import type { AgentActivity, AgentTask, Task } from "@berdloop/core";

/** UI boundary for the agent system. Supply snapshots as runs stream updates. */
export type { AgentActivity };
export interface ThreadMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  at?: string;
  delivery?: "saved" | "pending" | "delivered" | "applied";
  target?: WorkflowAction["target"];
}
export interface AgentThreadView {
  agentId: string;
  activity: AgentActivity;
  messages: ThreadMessage[];
  streaming?: boolean;
  worktree?: string;
  branch?: string;
}
export interface WorkflowAction {
  kind:
    | "message"
    | "start-ticket"
    | "pause-ticket"
    | "resume-ticket"
    | "stop-agent";
  projectId: string;
  organizationId?: string;
  ticketId?: string;
  taskId?: string;
  target?: "ticket-agent" | "planner" | "all-workers" | "worker";
  text?: string;
  /** Echo this as the user message ID in snapshots to reconcile delivery. */
  clientMessageId?: string;
}
export interface WorkflowRuntime {
  connected: boolean;
  /** Keys: ticket-agent:<project id>, planner:<ticket id>, or agent-task id. */
  threads: Record<string, AgentThreadView>;
  mergeQueues?: Record<string, string[]>;
  ticketBranches?: Record<string, string>;
  pullRequests?: Record<string, { url: string; status: string }>;
  dispatch: (action: WorkflowAction) => Promise<void>;
}
export const activityLabels: Record<AgentActivity, string> = {
  queued: "Queued",
  coding: "Coding",
  testing: "Testing",
  reviewing: "Reviewing",
  "waiting-for-human": "Waiting for you",
  "waiting-to-merge": "In merge queue",
  merging: "Merging",
  "fixing-conflicts": "Fixing conflicts",
  paused: "Paused",
  blocked: "Blocked",
  done: "Done",
};
export function taskActivity(
  task: AgentTask,
  thread?: AgentThreadView,
): AgentActivity {
  if (thread) return thread.activity;
  return (
    {
      queued: "queued",
      ready: "queued",
      running: "coding",
      review: "reviewing",
      blocked: "blocked",
      complete: "done",
    } as const
  )[task.status];
}
export function ticketState(ticket: Task): string {
  return {
    queued: "Queued",
    running: "Working",
    paused: "Paused",
    complete: "Done",
  }[ticket.status];
}

export function threadMessages(
  remote: ThreadMessage[] = [],
  local: ThreadMessage[] = [],
) {
  const remoteIds = new Set(remote.map((message) => message.id));
  return [...remote, ...local.filter((message) => !remoteIds.has(message.id))];
}
