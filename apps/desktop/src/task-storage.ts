import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
        ["queued", "running", "paused", "review", "complete"].includes(
          task.status,
        ) &&
        (task.mergePolicy === undefined ||
          ["manual", "automatic"].includes(task.mergePolicy)) &&
        (task.pullRequest === undefined ||
          (typeof task.pullRequest === "object" &&
            typeof task.pullRequest.url === "string" &&
            typeof task.pullRequest.head === "string" &&
            ["pending", "changes-requested", "approved"].includes(
              task.pullRequest.review,
            ))),
    ) &&
    Array.isArray(workspace.agentTasks) &&
    workspace.agentTasks.every(
      (task) =>
        task &&
        typeof task.id === "string" &&
        typeof task.parentTaskId === "string" &&
        typeof task.title === "string" &&
        typeof task.criteria === "string" &&
        (task.prompt === undefined || typeof task.prompt === "string") &&
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

/** Prompts an older build kept in the browser. Malformed storage is ignored. */
export function legacyPrompts(
  raw: string | null = localStorage.getItem("berdloop.ui.task-prompts.v1"),
): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
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
    const prompts = legacyPrompts();
    const migrated = {
      ...value,
      agentTasks: value.agentTasks.map((task) =>
        task.prompt === undefined && typeof prompts[task.id] === "string"
          ? { ...task, prompt: prompts[task.id] }
          : task,
      ),
    };
    if (JSON.stringify(migrated) !== JSON.stringify(value)) {
      if (isTauri())
        return invoke<TaskWorkspace>("patch_task_workspace", {
          base: value,
          workspace: migrated,
        });
      localStorage.setItem(browserKey, JSON.stringify(migrated));
    }
    return migrated;
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
  const pendingWrites = useRef(0);
  const generation = useRef(0);
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

  // The pull request watcher writes records from outside this window: fix
  // tasks for a broken build, a ticket completed by a merge. Nothing here
  // asked for them, so the window has to be told to read them back.
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const stop = listen("workspace-changed", () => {
      // A write of our own is already on its way and answers with the merged
      // truth. Reading now would only show a copy that write is about to beat.
      if (pendingWrites.current) return;
      const version = generation.current;
      void localTaskStore
        .load()
        .then((loaded) => {
          if (!active || !loaded) return;
          if (version !== generation.current || pendingWrites.current) return;
          current.current = loaded;
          setWorkspace(loaded);
          publish(loaded);
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      void stop.then((off) => off());
    };
  }, []);

  const update = useCallback(
    (change: (previous: TaskWorkspace) => TaskWorkspace) => {
      if (!ready) return;
      const base = current.current;
      const next = change(base);
      const version = ++generation.current;
      pendingWrites.current += 1;
      current.current = next;
      setWorkspace(next);
      publish(next);
      writes.current = writes.current
        .catch(() => {})
        .then(async () => {
          if (isTauri()) {
            const saved = await invoke<TaskWorkspace>("patch_task_workspace", {
              base,
              workspace: next,
            });
            if (version === generation.current) {
              current.current = saved;
              setWorkspace(saved);
              publish(saved);
            }
          } else await repository.current.save(next, session);
          setError(null);
        })
        .catch(async (cause: unknown) => {
          setError(String(cause));
          // A rejected patch leaves the screen showing an edit that was never
          // saved. Read the records back so the next edit starts from truth.
          if (!isTauri() || version !== generation.current) return;
          const loaded = await localTaskStore.load().catch(() => null);
          if (loaded && version === generation.current) {
            current.current = loaded;
            setWorkspace(loaded);
            publish(loaded);
          }
        })
        .finally(() => {
          pendingWrites.current -= 1;
        });
    },
    [ready, session],
  );

  // Rust owns native records. Polling is deliberately small and direct; no
  // second queue store or synchronization protocol is needed in the UI.
  useEffect(() => {
    if (!isTauri() || !ready) return;
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (reading || pendingWrites.current) return;
      reading = true;
      const version = generation.current;
      try {
        const loaded = await localTaskStore.load();
        if (
          active &&
          loaded &&
          !pendingWrites.current &&
          version === generation.current &&
          JSON.stringify(loaded) !== JSON.stringify(current.current)
        ) {
          current.current = loaded;
          setWorkspace(loaded);
          publish(loaded);
        }
      } catch (cause) {
        if (active) setError(String(cause));
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(() => void refresh(), 750);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready]);

  return { workspace, update, ready, error };
}
