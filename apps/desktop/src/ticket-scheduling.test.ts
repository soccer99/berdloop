import { expect, test } from "bun:test";
import { emptyTaskWorkspace, type AgentTask, type Task } from "@berdloop/core";
import { nextWorkerTicket } from "./ticket-scheduling";

const ticket = (id: string, status: Task["status"] = "queued"): Task => ({
  id,
  projectId: "project",
  title: id,
  criteria: id,
  source: "Local",
  ticket: id,
  stage: "Engineer",
  status,
});
const task = (
  id: string,
  parentTaskId: string,
  status: AgentTask["status"],
  reviewFix = false,
): AgentTask => ({
  id,
  parentTaskId,
  title: id,
  criteria: id,
  status,
  reviewFix,
  dependencyIds: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

test("review fixes take the next free worker slot while the next ticket is already running", () => {
  const workspace = {
    ...emptyTaskWorkspace(),
    tasks: [
      {
        ...ticket("old", "running"),
        pullRequest: {
          url: "https://example.test/pr",
          head: "abc",
          baseBranch: "main",
          review: "changes-requested" as const,
        },
      },
      ticket("next", "running"),
      ticket("later"),
    ],
    agentTasks: [
      task("ongoing", "next", "running"),
      task("later", "later", "ready"),
      task("fix", "old", "ready", true),
    ],
  };
  expect(nextWorkerTicket(workspace, "project", "next")?.id).toBe("old");
  workspace.agentTasks[2]!.status = "complete";
  expect(nextWorkerTicket(workspace, "project", "next")?.id).toBe("old");
  workspace.tasks[0]!.status = "review";
  expect(nextWorkerTicket(workspace, "project", "next")?.id).toBe("next");
});

test("a ticket in code review does not block the next ticket", () => {
  const workspace = {
    ...emptyTaskWorkspace(),
    tasks: [ticket("review", "review"), ticket("next")],
    agentTasks: [
      task("done", "review", "complete"),
      task("start", "next", "ready"),
    ],
  };
  expect(nextWorkerTicket(workspace, "project", "review")?.id).toBe("next");
});
