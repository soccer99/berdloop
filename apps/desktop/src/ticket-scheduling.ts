import type { Task, TaskWorkspace } from "@berdloop/core";

/** Keep one ticket in flight, but interrupt its queue for review fixes. */
export function nextWorkerTicket(
  workspace: TaskWorkspace,
  projectId: string,
  preferredId?: string,
  excludedIds: ReadonlySet<string> = new Set(),
): Task | undefined {
  const eligible = workspace.tasks.filter(
    (ticket) =>
      ticket.projectId === projectId &&
      ["queued", "running"].includes(ticket.status) &&
      !excludedIds.has(ticket.id),
  );
  const hasWork = (ticket: Task) =>
    workspace.agentTasks.some((task) => task.parentTaskId === ticket.id);
  // Any outstanding fix goes first, whoever asked for it. A reviewer's
  // verdict is one reason; a failing build is another, and that one arrives
  // while the review is still pending, so the verdict cannot be the test.
  const reviewPriority = (ticket: Task) =>
    workspace.agentTasks.some(
      (task) => task.parentTaskId === ticket.id && task.reviewFix,
    );
  return (
    eligible.find(reviewPriority) ??
    eligible.find(
      (ticket) => ticket.id === preferredId && ticket.status === "running",
    ) ??
    eligible.find((ticket) => ticket.status === "running") ??
    eligible.find((ticket) => ticket.id === preferredId && hasWork(ticket)) ??
    eligible.find(hasWork) ??
    eligible.find((ticket) => ticket.id === preferredId) ??
    eligible[0]
  );
}
