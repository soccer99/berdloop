import { nextTasks, ticketProgress } from "./brief";
import type { AgentTask, TaskWorkspace } from "@berdloop/core";

/**
 * The Ralph loop: keep handing bounded work to fresh agents until a ticket is
 * finished.
 *
 * The decision is kept apart from the doing. `planLoop` reads the world and
 * says what should happen next; something else spawns the processes. That way
 * the rule "never start the same task twice" is a test, not a hope.
 */

export interface RunState {
  /** Set once the agent has been started for this task. */
  runId?: string;
  state: "starting" | "running" | "finished";
}

export interface LoopState {
  workspace: TaskWorkspace;
  ticketId: string;
  /** Tasks this loop has already handed out, by task id. */
  active: Record<string, RunState>;
  /** The private staging repository exists and has been refreshed. */
  prepared: boolean;
  /** The ticket branch and its worktree exist. */
  ticketOpen: boolean;
  paused: boolean;
  /** How many workers may run at once. */
  slots: number;
}

export type LoopStep =
  | { kind: "prepare" }
  | { kind: "open-ticket" }
  | { kind: "start-task"; task: AgentTask }
  | { kind: "wait"; reason: string }
  | { kind: "ticket-done" };

export function planLoop(state: LoopState): LoopStep[] {
  if (state.paused) return [{ kind: "wait", reason: "The ticket is paused." }];
  if (!state.prepared) return [{ kind: "prepare" }];
  if (!state.ticketOpen) return [{ kind: "open-ticket" }];

  const progress = ticketProgress(state.workspace, state.ticketId);
  if (!progress.total) {
    return [{ kind: "wait", reason: "No tasks planned yet." }];
  }
  if (progress.complete === progress.total) {
    return [{ kind: "ticket-done" }];
  }

  // A task this loop already handed out is busy even if the workspace has not
  // caught up yet. Without this, a slow status write starts it twice.
  const busy = Object.entries(state.active).filter(
    ([, run]) => run.state !== "finished",
  );
  const free = state.slots - busy.length;
  if (free < 1) {
    return [{ kind: "wait", reason: "Every worker is busy." }];
  }

  const handedOut = new Set(busy.map(([taskId]) => taskId));
  const ready = nextTasks(state.workspace, state.ticketId, state.slots)
    .filter((task) => !handedOut.has(task.id))
    .slice(0, free);

  if (ready.length) {
    return ready.map((task) => ({ kind: "start-task" as const, task }));
  }
  if (busy.length) {
    return [{ kind: "wait", reason: "Waiting for work in progress." }];
  }
  if (progress.blocked) {
    return [{ kind: "wait", reason: "Every remaining task is blocked." }];
  }
  // The workspace still says these are running, but this loop is not running
  // them. Their worker died with an earlier window, and recovery has not put
  // them back yet. Saying "waiting on another task" here sent people looking
  // for a dependency that does not exist.
  if (progress.running) {
    return [
      {
        kind: "wait",
        reason:
          progress.running === 1
            ? "One task says it is running with no worker on it. Start the loop again to recover it."
            : `${progress.running} tasks say they are running with no worker on them. Start the loop again to recover them.`,
      },
    ];
  }
  return [
    {
      kind: "wait",
      reason: "Nothing is ready. Some task is waiting on another.",
    },
  ];
}

/** What a finished worker said about its task, read back from disk. */
export interface TaskReport {
  ticket: string;
  task: string;
  status: "complete" | "blocked";
  detail: string;
  at: number;
  runId?: string;
}

/**
 * The newest report for each task.
 *
 * A retried task writes more than one, and only the last one counts.
 */
export function latestReports(
  reports: TaskReport[],
): Record<string, TaskReport> {
  const newest: Record<string, TaskReport> = {};
  for (const report of reports) {
    const current = newest[report.task];
    if (!current || report.at >= current.at) newest[report.task] = report;
  }
  return newest;
}
