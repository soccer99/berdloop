import type { AgentActivity, AgentTask, Task } from "@berdloop/core";

/** UI boundary for the agent system. Supply snapshots as runs stream updates. */
export type { AgentActivity };
export interface ThreadMessage {
  id: string;
  /** A `tool` message is a file the agent wrote, not something said. */
  role: "user" | "agent" | "system" | "tool";
  /** What was said, or on a `tool` message the name of the tool. */
  text: string;
  /** The file a `tool` message's tool call wrote. */
  path?: string;
  at?: string | number;
  delivery?: "saved" | "pending" | "delivered" | "applied" | "failed";
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
  mergeQueues?: Record<string, MergeEntry[]>;
  ticketBranches?: Record<string, string>;
  pullRequests?: Record<string, { url: string; status: string }>;
  dispatch: (action: WorkflowAction) => Promise<void>;
}
/**
 * One merge attempt on a ticket.
 *
 * Nothing is ever dropped from this list. An attempt that landed, gave up or
 * died is kept beside the ones still in the line, so the list is the ticket's
 * whole merge history and reads back the same weeks later.
 */
export interface MergeEntry {
  taskId: string;
  status: "waiting" | "merging" | "conflict" | "merged" | "left" | "abandoned";
  /** When the attempt joined the line. Milliseconds since the epoch, 0 if unknown. */
  at: number;
}
/** Attempts still in the line. Everything else is history. */
export function mergeIsLive(entry: MergeEntry): boolean {
  return ["waiting", "merging", "conflict"].includes(entry.status);
}
/** Merge history reuses the worker labels, so one state has one name everywhere. */
export const mergeActivity: Record<MergeEntry["status"], AgentActivity> = {
  waiting: "waiting-to-merge",
  merging: "merging",
  conflict: "fixing-conflicts",
  merged: "merged",
  left: "done",
  abandoned: "blocked",
};

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
  done: "Done, not merged",
  merged: "Merged",
};
export function taskActivity(
  task: AgentTask,
  thread?: AgentThreadView,
  /** True once the merge queue records this task as landed. */
  merged = false,
): AgentActivity {
  // Finishing and merging are different things, and only one of them means the
  // work exists outside the worker's own worktree. They never share a label.
  if (task.status === "complete") return merged ? "merged" : "done";
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
    review: "Code review",
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
