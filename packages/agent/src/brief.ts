import type {
  AgentTask,
  AgentTaskStatus,
  Task,
  TaskWorkspace,
} from "@berdloop/core";

/**
 * A Ralph worker starts with an empty context every time. It cannot remember
 * an earlier attempt, so everything it needs must be written into one brief.
 *
 * The brief stays deliberately small. Completed sibling work is named, never
 * explained, because a worker that reads the whole ticket history loses the
 * context budget it needs for its own task.
 */

/** Longest a single field may be before it is cut short. */
const FIELD_LIMIT = 1200;

/** Most finished siblings to name, newest last. */
const SIBLING_LIMIT = 12;

export interface BriefInput {
  ticket: Task;
  task: AgentTask;
  /** Every agent task under the same ticket, including this one. */
  siblings: AgentTask[];
  /** Directory the worker owns. Nothing outside it may be touched. */
  worktree: string;
  /** 1 for the first run. Later numbers mean an earlier attempt failed. */
  attempt?: number;
  /** Why the last attempt failed, when there was one. */
  lastFailure?: string;
  /**
   * Instructions sent while this task sat in the queue. They arrive with the
   * brief, so steering a task before it starts is never lost.
   */
  pending?: string[];
}

function clamp(text: string, limit = FIELD_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit).trimEnd()}\n…(shortened)`
    : trimmed;
}

/**
 * Build the whole prompt for one fresh worker.
 *
 * The result is self-contained: no earlier conversation, no transcript, no
 * reference to another agent's session.
 */
export function buildTaskBrief(input: BriefInput): string {
  const { ticket, task, siblings, worktree } = input;
  const attempt = input.attempt ?? 1;

  const done = siblings
    .filter((item) => item.id !== task.id && item.status === "complete")
    .slice(-SIBLING_LIMIT)
    .map((item) => `- ${item.title}`);

  const blocked = siblings.filter(
    (item) =>
      task.dependencyIds.includes(item.id) && item.status !== "complete",
  );

  const lines = [
    `# Task: ${task.title}`,
    "",
    `Ticket ${ticket.ticket}: ${ticket.title}`,
    "",
    "## What the ticket must achieve",
    clamp(ticket.criteria) || "(none recorded)",
    "",
    ...(task.prompt?.trim()
      ? ["## Task instructions", task.prompt.trim(), ""]
      : []),
    "## What this task must achieve",
    clamp(task.criteria),
    "",
  ];

  if (done.length) {
    lines.push(
      "## Already finished by other workers",
      "Do not redo these. They are listed by name only, on purpose.",
      ...done,
      "",
    );
  }

  if (blocked.length) {
    lines.push(
      "## Not finished yet",
      "Do not depend on these being present:",
      ...blocked.map((item) => `- ${item.title}`),
      "",
    );
  }

  if (input.pending?.length) {
    lines.push(
      "## Since this task was written",
      "Read these before you start. They are newer than the criteria above and they win.",
      ...input.pending.map((note) => `- ${note}`),
      "",
    );
  }

  lines.push(
    "## Rules",
    `- Work only inside ${worktree}. It is yours alone.`,
    "- Other workers are changing other files at the same time. Keep your change as small as the task allows.",
    "- Do not change files that belong to another task in the list above.",
    "- Read what you need from the repository. You have no memory of earlier runs.",
    "- Stop when this one task is done. Do not start the next one.",
    "- Leave the work committed, or leave it staged and say why it is not done.",
    "",
    "## Finishing",
    "Last of all, state whether the task's criteria are met, and name the check you ran that proves it.",
  );

  if (attempt > 1) {
    lines.push(
      "",
      `## Attempt ${attempt}`,
      "An earlier worker tried this task and did not finish it.",
      input.lastFailure
        ? `What went wrong: ${clamp(input.lastFailure, 500)}`
        : "The reason was not recorded.",
      "Start from the repository as it is now, not from what you expect.",
    );
  }

  return lines.join("\n");
}

export interface TicketProgress {
  total: number;
  complete: number;
  running: number;
  blocked: number;
  /** 0 to 1. A ticket with no tasks yet reads as 0. */
  ratio: number;
  /** What the queue should show for this ticket. */
  state: "planning" | "ready" | "running" | "blocked" | "done";
}

/** Roll a ticket's agent tasks up into one line for the queue. */
export function ticketProgress(
  workspace: TaskWorkspace,
  ticketId: string,
): TicketProgress {
  const tasks = workspace.agentTasks.filter(
    (task) => task.parentTaskId === ticketId,
  );
  const count = (status: AgentTaskStatus) =>
    tasks.filter((task) => task.status === status).length;

  const complete = count("complete");
  const running = count("running") + count("review");
  const blocked = count("blocked");
  const total = tasks.length;

  const state: TicketProgress["state"] = !total
    ? "planning"
    : complete === total
      ? "done"
      : running
        ? "running"
        : blocked
          ? "blocked"
          : "ready";

  return {
    total,
    complete,
    running,
    blocked,
    ratio: total ? complete / total : 0,
    state,
  };
}

/**
 * Choose the tasks a Ralph loop may start right now.
 *
 * Only `ready` work qualifies, because `setAgentTaskStatus` promotes a task
 * out of `queued` once its dependencies finish. Returning several is safe:
 * each one gets its own worktree.
 */
export function nextTasks(
  workspace: TaskWorkspace,
  ticketId: string,
  slots: number,
): AgentTask[] {
  if (slots < 1) return [];
  const tasks = workspace.agentTasks.filter(
    (task) => task.parentTaskId === ticketId,
  );
  const busy = tasks.filter(
    (task) => task.status === "running" || task.status === "review",
  ).length;
  const free = slots - busy;
  if (free < 1) return [];
  return tasks.filter((task) => task.status === "ready").slice(0, free);
}
