import type { Task, TicketProvider } from "./index";

export type ExternalProvider = Exclude<TicketProvider, "Local">;

export interface ExternalIssue {
  provider: ExternalProvider;
  id: string;
  key: string;
  url: string;
  title: string;
  description: string;
  status: string;
}

export type AgentTaskStatus =
  "queued" | "ready" | "running" | "review" | "blocked" | "complete";

/** Berdloop-owned work. These records never become provider subtasks. */
export interface AgentTask {
  id: string;
  parentTaskId: string;
  title: string;
  criteria: string;
  status: AgentTaskStatus;
  dependencyIds: string[];
  assigneeId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorkspace {
  schemaVersion: 1;
  /** The account this local copy may sync with after sign-in. */
  cloudUserId?: string;
  tasks: Task[];
  agentTasks: AgentTask[];
}

export const emptyTaskWorkspace = (): TaskWorkspace => ({
  schemaVersion: 1,
  tasks: [],
  agentTasks: [],
});

export function importIssue(
  workspace: TaskWorkspace,
  issue: ExternalIssue,
  projectId: string,
  now = new Date().toISOString(),
  makeId: () => string = () => crypto.randomUUID(),
): { workspace: TaskWorkspace; task: Task } {
  if (!issue.id.trim() || !issue.key.trim() || !issue.title.trim()) {
    throw new Error("Provider returned an incomplete ticket.");
  }
  let origin: string;
  try {
    const url = new URL(issue.url);
    if (url.protocol !== "https:") throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("Provider returned an invalid ticket URL.");
  }
  const existing = workspace.tasks.find(
    (task) =>
      task.source === issue.provider &&
      task.sourceId === issue.id &&
      (issue.provider !== "Jira" ||
        (task.sourceUrl && task.sourceUrl.startsWith(`${origin}/`))),
  );
  const task: Task = existing
    ? {
        ...existing,
        title: issue.title,
        ticket: issue.key,
        sourceUrl: issue.url,
        sourceStatus: issue.status,
        updatedAt: now,
      }
    : {
        id: makeId(),
        projectId,
        title: issue.title,
        criteria: issue.description,
        source: issue.provider,
        sourceId: issue.id,
        sourceUrl: issue.url,
        sourceStatus: issue.status,
        ticket: issue.key,
        stage: "Branch",
        status: "queued",
        updatedAt: now,
      };
  return {
    task,
    workspace: {
      ...workspace,
      tasks: existing
        ? workspace.tasks.map((item) => (item.id === existing.id ? task : item))
        : [...workspace.tasks, task],
    },
  };
}

export function addAgentTask(
  workspace: TaskWorkspace,
  input: Pick<
    AgentTask,
    "parentTaskId" | "title" | "criteria" | "dependencyIds"
  > &
    Partial<Pick<AgentTask, "assigneeId">>,
  now = new Date().toISOString(),
  makeId: () => string = () => crypto.randomUUID(),
): TaskWorkspace {
  if (!workspace.tasks.some((task) => task.id === input.parentTaskId)) {
    throw new Error("Parent task does not exist.");
  }
  const title = input.title.trim();
  const criteria = input.criteria.trim();
  if (!title || !criteria) {
    throw new Error("Title and acceptance criteria are required.");
  }
  const siblings = workspace.agentTasks.filter(
    (task) => task.parentTaskId === input.parentTaskId,
  );
  const ids = new Set(siblings.map((task) => task.id));
  const dependencyIds = [...new Set(input.dependencyIds)];
  if (dependencyIds.some((id) => !ids.has(id))) {
    throw new Error("Dependencies must belong to the same parent task.");
  }
  const agentTask: AgentTask = {
    id: makeId(),
    parentTaskId: input.parentTaskId,
    title,
    criteria,
    dependencyIds,
    assigneeId: input.assigneeId?.trim() || undefined,
    status: dependencyIds.some(
      (id) => siblings.find((task) => task.id === id)?.status !== "complete",
    )
      ? "queued"
      : "ready",
    createdAt: now,
    updatedAt: now,
  };
  return { ...workspace, agentTasks: [...workspace.agentTasks, agentTask] };
}

export function setAgentTaskStatus(
  workspace: TaskWorkspace,
  id: string,
  status: AgentTaskStatus,
  now = new Date().toISOString(),
): TaskWorkspace {
  const target = workspace.agentTasks.find((task) => task.id === id);
  if (!target) throw new Error("Agent task does not exist.");
  if (
    target.status === "complete" &&
    status !== "complete" &&
    workspace.agentTasks.some(
      (task) =>
        task.dependencyIds.includes(id) &&
        ["running", "review", "complete"].includes(task.status),
    )
  ) {
    throw new Error("Reopen dependent work before reopening this task.");
  }
  if (
    ["ready", "running", "review", "complete"].includes(status) &&
    target.dependencyIds.some(
      (dependencyId) =>
        workspace.agentTasks.find((task) => task.id === dependencyId)
          ?.status !== "complete",
    )
  ) {
    throw new Error("Complete dependencies before starting this task.");
  }
  const agentTasks = workspace.agentTasks.map((task) =>
    task.id === id ? { ...task, status, updatedAt: now } : { ...task },
  );
  for (const task of agentTasks) {
    if (task.parentTaskId !== target.parentTaskId || task.id === id) continue;
    const dependenciesComplete = task.dependencyIds.every(
      (dependencyId) =>
        agentTasks.find((dependency) => dependency.id === dependencyId)
          ?.status === "complete",
    );
    if (task.status === "queued" && dependenciesComplete) {
      task.status = "ready";
      task.updatedAt = now;
    } else if (task.status === "ready" && !dependenciesComplete) {
      task.status = "queued";
      task.updatedAt = now;
    }
  }
  return { ...workspace, agentTasks };
}

export function canCompleteParent(
  workspace: TaskWorkspace,
  parentTaskId: string,
) {
  const children = workspace.agentTasks.filter(
    (task) => task.parentTaskId === parentTaskId,
  );
  return (
    children.length > 0 && children.every((task) => task.status === "complete")
  );
}
