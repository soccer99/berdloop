import type { AgentRole, HarnessId } from "@berdloop/agent";
import type { AgentTask, Task } from "@berdloop/core";
import type { AgentThreadView, WorkflowAction } from "./workflow-ui";

/** Matches the Rust conversation address. A UI selection is never a run ID. */
export interface AgentScope {
  organizationId: string;
  projectId: string;
  role: AgentRole;
  ticketId?: string;
  taskId?: string;
}

export interface ConversationSnapshot extends AgentThreadView {
  scope: AgentScope;
  revision: number;
  runId?: string;
  sessionId?: string;
  harness: HarnessId;
}

export function conversationKey(scope: AgentScope): string {
  if (!scope.projectId)
    throw new Error("Choose a project before messaging an agent.");
  if (scope.role === "ticket-agent") return `ticket-agent:${scope.projectId}`;
  if (!scope.ticketId)
    throw new Error("Choose a ticket before messaging an agent.");
  if (scope.role === "pr-code-review")
    return `pr-code-review:${scope.ticketId}`;
  if (scope.role === "task-agent") return `planner:${scope.ticketId}`;
  if (!scope.taskId)
    throw new Error("Choose a task before messaging a worker.");
  return scope.taskId;
}

/** Reject a stale/mismatched selection; broadcasts include queued workers too. */
export function messageScopes(
  action: WorkflowAction,
  tickets: Task[],
  tasks: AgentTask[],
): AgentScope[] {
  const base = {
    organizationId: action.organizationId ?? "",
    projectId: action.projectId,
  };
  if (!base.projectId)
    throw new Error("Choose a project before messaging an agent.");
  if (action.target === "ticket-agent")
    return [{ ...base, role: "ticket-agent" }];
  const ticket = tickets.find(
    (item) =>
      item.id === action.ticketId && item.projectId === action.projectId,
  );
  if (!ticket)
    throw new Error(
      "This conversation does not belong to the selected project and ticket.",
    );
  if (action.target === "planner")
    return [{ ...base, ticketId: ticket.id, role: "task-agent" }];
  const workers = tasks.filter(
    (task) =>
      task.parentTaskId === ticket.id &&
      (action.target === "all-workers"
        ? ["ready", "queued", "running", "review"].includes(task.status)
        : task.id === action.taskId),
  );
  if (!workers.length)
    throw new Error("There are no matching workers on this ticket.");
  return workers.map((task) => ({
    ...base,
    ticketId: ticket.id,
    taskId: task.id,
    role: "worker",
  }));
}

/** A late initial fetch or command reply must not overwrite newer streamed text. */
export function mergeConversations(
  current: Record<string, ConversationSnapshot>,
  snapshots: ConversationSnapshot[],
): Record<string, ConversationSnapshot> {
  const next = { ...current };
  for (const snapshot of snapshots) {
    if (snapshot.agentId !== conversationKey(snapshot.scope)) continue;
    if (
      !next[snapshot.agentId] ||
      snapshot.revision > next[snapshot.agentId]!.revision
    ) {
      next[snapshot.agentId] = snapshot;
    }
  }
  return next;
}
