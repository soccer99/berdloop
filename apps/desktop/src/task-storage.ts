import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useBerdloop } from "@berdloop/state";
import {
  emptyTaskWorkspace,
  TaskRepository,
  type AccountSession,
  type CloudWorkspaceStore,
  type TaskWorkspace,
  type WorkspaceStore,
} from "@berdloop/core";

const browserKey = "berdloop.tasks.v1";

function validWorkspace(value: unknown): value is TaskWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<TaskWorkspace>;
  return (
    workspace.schemaVersion === 1 &&
    (workspace.cloudUserId === undefined ||
      typeof workspace.cloudUserId === "string") &&
    Array.isArray(workspace.tasks) &&
    workspace.tasks.every(
      (task) =>
        task &&
        typeof task.id === "string" &&
        typeof task.projectId === "string" &&
        typeof task.title === "string" &&
        typeof task.criteria === "string" &&
        typeof task.ticket === "string" &&
        ["Local", "Jira", "Linear", "Asana"].includes(task.source) &&
        ["Branch", "Engineer", "Review", "Deploy"].includes(task.stage) &&
        ["queued", "running", "paused", "complete"].includes(task.status),
    ) &&
    Array.isArray(workspace.agentTasks) &&
    workspace.agentTasks.every(
      (task) =>
        task &&
        typeof task.id === "string" &&
        typeof task.parentTaskId === "string" &&
        typeof task.title === "string" &&
        typeof task.criteria === "string" &&
        Array.isArray(task.dependencyIds) &&
        task.dependencyIds.every((id: unknown) => typeof id === "string") &&
        [
          "queued",
          "ready",
          "running",
          "review",
          "blocked",
          "complete",
        ].includes(task.status) &&
        typeof task.createdAt === "string" &&
        typeof task.updatedAt === "string",
    )
  );
}

export const localTaskStore: WorkspaceStore = {
  async load() {
    const value = isTauri()
      ? await invoke<unknown>("load_task_workspace")
      : JSON.parse(localStorage.getItem(browserKey) ?? "null");
    if (value === null) {
      const legacy = JSON.parse(
        localStorage.getItem("berdloop.preview.tasks.v1") ?? "null",
      ) as unknown;
      if (Array.isArray(legacy)) {
        return {
          ...emptyTaskWorkspace(),
          tasks: legacy.filter((task): task is TaskWorkspace["tasks"][number] =>
            Boolean(
              task &&
              typeof task === "object" &&
              "id" in task &&
              typeof task.id === "string" &&
              !task.id.startsWith("demo-"),
            ),
          ),
        };
      }
      return null;
    }
    if (!validWorkspace(value))
      throw new Error("Local tasks use an unsupported format.");
    return value;
  },
  async save(workspace) {
    if (!validWorkspace(workspace)) throw new Error("Invalid task workspace.");
    if (isTauri()) {
      await invoke("save_task_workspace", { workspace });
    } else {
      localStorage.setItem(browserKey, JSON.stringify(workspace));
    }
  },
};

/** Cloud API contract: GET/PUT /v1/task-workspaces/me with bearer auth. */
export function cloudTaskStore(baseUrl: string): CloudWorkspaceStore {
  const url = new URL("/v1/task-workspaces/me", baseUrl);
  if (url.protocol !== "https:")
    throw new Error("Cloud task storage requires HTTPS.");
  async function request(
    session: AccountSession,
    method: "GET" | "PUT",
    workspace?: TaskWorkspace,
  ) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(workspace ? { "Content-Type": "application/json" } : {}),
      },
      body: workspace ? JSON.stringify(workspace) : undefined,
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok)
      throw new Error(`Cloud task sync failed (${response.status}).`);
    return method === "GET" ? response.json() : null;
  }
  return {
    async load(session) {
      const value: unknown = await request(session, "GET");
      if (value === null) return null;
      if (!validWorkspace(value))
        throw new Error("Cloud tasks use an unsupported format.");
      return value;
    },
    async save(session, workspace) {
      await request(session, "PUT", workspace);
    },
  };
}

/** Hand the records to the central store, which is what shared UI reads. */
function publish(workspace: TaskWorkspace) {
  const store = useBerdloop.getState();
  store.setTickets(workspace.tasks);
  store.setAgentTasks(workspace.agentTasks);
}

export function useTaskWorkspace(session: AccountSession | null = null) {
  const [workspace, setWorkspace] = useState<TaskWorkspace>(emptyTaskWorkspace);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(workspace);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const repository = useRef(
    new TaskRepository(
      localTaskStore,
      import.meta.env.VITE_BERDLOOP_CLOUD_API_URL
        ? cloudTaskStore(import.meta.env.VITE_BERDLOOP_CLOUD_API_URL)
        : undefined,
    ),
  );

  useEffect(() => {
    let active = true;
    useBerdloop.getState().loading("tickets");
    repository.current
      .load(session)
      .then((loaded) => {
        if (!active) return;
        current.current = loaded;
        setWorkspace(loaded);
        publish(loaded);
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(String(cause));
        useBerdloop.getState().failed("tickets", cause);
      });
    return () => {
      active = false;
    };
  }, [session]);

  const update = useCallback(
    (change: (previous: TaskWorkspace) => TaskWorkspace) => {
      if (!ready) return;
      const next = change(current.current);
      current.current = next;
      setWorkspace(next);
      publish(next);
      writes.current = writes.current
        .catch(() => {})
        .then(() => repository.current.save(next, session))
        .then(() => setError(null))
        .catch((cause: unknown) => setError(String(cause)));
    },
    [ready, session],
  );

  return { workspace, update, ready, error };
}
