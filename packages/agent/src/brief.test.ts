import { describe, expect, test } from "bun:test";
import { buildTaskBrief, nextTasks, ticketProgress } from "./brief";
import {
  emptyTaskWorkspace,
  type AgentTask,
  type AgentTaskStatus,
  type Task,
} from "@berdloop/core";

const ticket: Task = {
  id: "ticket-1",
  projectId: "p",
  title: "Invite teammates",
  source: "Linear",
  ticket: "ENG-42",
  stage: "Engineer",
  status: "running",
  criteria: "A member can invite a teammate by email.",
};

function agentTask(
  id: string,
  status: AgentTaskStatus,
  extra: Partial<AgentTask> = {},
): AgentTask {
  return {
    id,
    parentTaskId: "ticket-1",
    title: `Task ${id}`,
    criteria: `Criteria for ${id}`,
    status,
    dependencyIds: [],
    createdAt: `2026-01-0${id.length}T00:00:00.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("buildTaskBrief", () => {
  const task = agentTask("a", "ready");

  test("carries the ticket and the task, and nothing else", () => {
    const brief = buildTaskBrief({
      ticket,
      task,
      siblings: [task],
      worktree: "/work/a",
    });
    expect(brief).toContain("ENG-42");
    expect(brief).toContain("A member can invite a teammate by email.");
    expect(brief).toContain("Criteria for a");
    expect(brief).toContain("/work/a");
  });

  test("names finished siblings but never explains them", () => {
    const done = agentTask("b", "complete");
    const brief = buildTaskBrief({
      ticket,
      task,
      siblings: [task, done],
      worktree: "/work/a",
    });
    expect(brief).toContain("Task b");
    // A fresh worker must not inherit another task's detail.
    expect(brief).not.toContain("Criteria for b");
  });

  test("leaves unfinished siblings out of the finished list", () => {
    const brief = buildTaskBrief({
      ticket,
      task,
      siblings: [task, agentTask("c", "running")],
      worktree: "/work/a",
    });
    expect(brief).not.toContain("Already finished");
  });

  test("warns about dependencies that are not done", () => {
    const blocked = agentTask("d", "running");
    const brief = buildTaskBrief({
      ticket,
      task: { ...task, dependencyIds: ["d"] },
      siblings: [task, blocked],
      worktree: "/work/a",
    });
    expect(brief).toContain("Not finished yet");
    expect(brief).toContain("Task d");
  });

  test("says so when an earlier attempt failed", () => {
    const first = buildTaskBrief({
      ticket,
      task,
      siblings: [task],
      worktree: "/w",
    });
    expect(first).not.toContain("Attempt");

    const retry = buildTaskBrief({
      ticket,
      task,
      siblings: [task],
      worktree: "/w",
      attempt: 2,
      lastFailure: "the build broke",
    });
    expect(retry).toContain("Attempt 2");
    expect(retry).toContain("the build broke");
  });

  test("shortens a very long field instead of sending it whole", () => {
    const brief = buildTaskBrief({
      ticket: { ...ticket, criteria: "x".repeat(5000) },
      task,
      siblings: [task],
      worktree: "/w",
    });
    expect(brief).toContain("(shortened)");
    expect(brief.length).toBeLessThan(4000);
  });
});

describe("ticketProgress", () => {
  test("a ticket with no tasks is still being planned", () => {
    const progress = ticketProgress(emptyTaskWorkspace(), "ticket-1");
    expect(progress.state).toBe("planning");
    expect(progress.ratio).toBe(0);
  });

  test("counts finished work", () => {
    const workspace = {
      ...emptyTaskWorkspace(),
      agentTasks: [
        agentTask("a", "complete"),
        agentTask("b", "complete"),
        agentTask("c", "ready"),
        agentTask("d", "running"),
      ],
    };
    const progress = ticketProgress(workspace, "ticket-1");
    expect(progress.total).toBe(4);
    expect(progress.complete).toBe(2);
    expect(progress.ratio).toBe(0.5);
    expect(progress.state).toBe("running");
  });

  test("blocked work shows when nothing is running", () => {
    const workspace = {
      ...emptyTaskWorkspace(),
      agentTasks: [agentTask("a", "blocked"), agentTask("b", "ready")],
    };
    expect(ticketProgress(workspace, "ticket-1").state).toBe("blocked");
  });

  test("everything complete reads as done", () => {
    const workspace = {
      ...emptyTaskWorkspace(),
      agentTasks: [agentTask("a", "complete")],
    };
    expect(ticketProgress(workspace, "ticket-1").state).toBe("done");
  });
});

describe("nextTasks", () => {
  const workspace = {
    ...emptyTaskWorkspace(),
    agentTasks: [
      agentTask("a", "ready"),
      agentTask("bb", "ready"),
      agentTask("ccc", "queued"),
      agentTask("dddd", "complete"),
    ],
  };

  test("only ready work is handed out, oldest first", () => {
    expect(nextTasks(workspace, "ticket-1", 5).map((t) => t.id)).toEqual([
      "a",
      "bb",
    ]);
  });

  test("respects the number of free slots", () => {
    expect(nextTasks(workspace, "ticket-1", 1).map((t) => t.id)).toEqual(["a"]);
    expect(nextTasks(workspace, "ticket-1", 0)).toEqual([]);
  });

  test("work already in flight uses up a slot", () => {
    const busy = {
      ...workspace,
      agentTasks: [...workspace.agentTasks, agentTask("e", "running")],
    };
    expect(nextTasks(busy, "ticket-1", 2).map((t) => t.id)).toEqual(["a"]);
    expect(nextTasks(busy, "ticket-1", 1)).toEqual([]);
  });
});
