import {
  emptyTaskWorkspace,
  type AgentTask,
  type TaskWorkspace,
} from "./task-system";
import type { Task } from "./index";

export interface WorkspaceStore {
  load(): Promise<TaskWorkspace | null>;
  save(workspace: TaskWorkspace): Promise<void>;
}

export interface AccountSession {
  userId: string;
  accessToken: string;
}

export interface CloudWorkspaceStore {
  load(session: AccountSession): Promise<TaskWorkspace | null>;
  save(session: AccountSession, workspace: TaskWorkspace): Promise<void>;
}

function newest<T extends { id: string; updatedAt?: string }>(
  local: T[],
  remote: T[],
): T[] {
  const records = new Map(local.map((item) => [item.id, item]));
  for (const item of remote) {
    const current = records.get(item.id);
    if (!current || (item.updatedAt ?? "") > (current.updatedAt ?? "")) {
      records.set(item.id, item);
    }
  }
  return [...records.values()];
}

/** Merge independent edits when a signed-in device loads its cloud copy. */
export function mergeTaskWorkspaces(
  local: TaskWorkspace,
  remote: TaskWorkspace,
): TaskWorkspace {
  const tasks = newest<Task>(local.tasks, remote.tasks);
  const validParentIds = new Set(tasks.map((task) => task.id));
  const agentTasks = newest<AgentTask>(
    local.agentTasks,
    remote.agentTasks,
  ).filter((task) => validParentIds.has(task.parentTaskId));
  return {
    schemaVersion: 1,
    cloudUserId: local.cloudUserId ?? remote.cloudUserId,
    tasks,
    agentTasks,
  };
}

export class TaskRepository {
  constructor(
    private readonly local: WorkspaceStore,
    private readonly cloud?: CloudWorkspaceStore,
  ) {}

  async load(session?: AccountSession | null): Promise<TaskWorkspace> {
    const local = (await this.local.load()) ?? emptyTaskWorkspace();
    if (!session || !this.cloud) return local;
    if (local.cloudUserId && local.cloudUserId !== session.userId) {
      throw new Error(
        "This local task workspace belongs to another cloud account.",
      );
    }
    let remote: TaskWorkspace | null;
    try {
      remote = await this.cloud.load(session);
    } catch {
      return local;
    }
    if (!remote) return local;
    const merged = {
      ...mergeTaskWorkspaces(local, remote),
      cloudUserId: session.userId,
    };
    await this.local.save(merged);
    return merged;
  }

  /** A cloud failure never prevents the local copy from being written. */
  async save(
    workspace: TaskWorkspace,
    session?: AccountSession | null,
  ): Promise<void> {
    const stored = session && this.cloud ? await this.local.load() : null;
    if (
      session &&
      stored?.cloudUserId &&
      stored.cloudUserId !== session.userId
    ) {
      throw new Error(
        "This local task workspace belongs to another cloud account.",
      );
    }
    if (
      session &&
      this.cloud &&
      workspace.cloudUserId &&
      workspace.cloudUserId !== session.userId
    ) {
      throw new Error(
        "This local task workspace belongs to another cloud account.",
      );
    }
    const bound =
      session && this.cloud && !workspace.cloudUserId
        ? { ...workspace, cloudUserId: session.userId }
        : workspace;
    await this.local.save(bound);
    if (session && this.cloud) {
      await this.cloud.save(session, bound);
    }
  }
}
