import { describe, expect, test } from "bun:test";
import { buildTaskBrief, nextTasks, ticketProgress } from "./brief";
import { standingOrders } from "./harness";
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

  test("the edited prompt reaches the worker word for word", () => {
    const edited = agentTask("a", "ready", {
      prompt: "Use the existing InviteForm. Do not add a new dependency.",
    });
    const brief = buildTaskBrief({
      ticket,
      task: edited,
      siblings: [edited],
      worktree: "/work/a",
    });
    expect(brief).toContain("## Task instructions");
    expect(brief).toContain(
      "Use the existing InviteForm. Do not add a new dependency.",
    );
    // The criteria still travel too: the prompt adds to them, never replaces.
    expect(brief).toContain("Criteria for a");
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

  test("the queue order decides, not the age of the task", () => {
    // A newer task moved above an older one starts first.
    const reordered = {
      ...emptyTaskWorkspace(),
      agentTasks: [
        agentTask("newer", "ready", { createdAt: "2026-02-01T00:00:00.000Z" }),
        agentTask("older", "ready", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
    };
    expect(nextTasks(reordered, "ticket-1", 1).map((t) => t.id)).toEqual([
      "newer",
    ]);
    // Order never overrides a dependency or an occupied slot.
    const gated = {
      ...emptyTaskWorkspace(),
      agentTasks: [
        agentTask("first", "queued", { dependencyIds: ["last"] }),
        agentTask("busy", "running"),
        agentTask("last", "ready"),
      ],
    };
    expect(nextTasks(gated, "ticket-1", 2).map((t) => t.id)).toEqual(["last"]);
    expect(nextTasks(gated, "ticket-1", 1)).toEqual([]);
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

/**
 * The brief a role is handed is `standingOrders`, in harness.ts: it renders
 * the rules that carry that role. These read it from there.
 */
describe("the one-message-one-ticket rule", () => {
  // Matched on the text, not on where the rule sits in the list, so reordering
  // the rules does not silently pass or fail this.
  const heading = "One message is one ticket";
  const phrase =
    "Two asks sent in two messages are two tickets, even when they touch the same code.";

  test("reaches the ticket agent", () => {
    const orders = standingOrders("ticket-agent");
    expect(orders).toContain(heading);
    expect(orders).toContain(phrase);
    expect(orders).toContain("Combine only when the person says to combine.");
    expect(orders).toContain(
      "A shared file is a sequencing problem, not a reason to merge two tickets.",
    );
  });

  test("reaches nobody else", () => {
    // A worker or a reviewer that read this would apply it to work it does not
    // own, and the task agent splits one ticket rather than deciding what a
    // ticket is.
    for (const role of ["worker", "task-agent", "pr-code-review"] as const) {
      const orders = standingOrders(role);
      expect(orders).not.toContain(heading);
      expect(orders).not.toContain(phrase);
    }
  });
});
