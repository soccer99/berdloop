import { describe, expect, test } from "bun:test";
import {
  latestReports,
  planLoop,
  type LoopState,
  type TaskReport,
} from "./loop";
import {
  emptyTaskWorkspace,
  type AgentTask,
  type AgentTaskStatus,
} from "@berdloop/core";

function task(
  id: string,
  status: AgentTaskStatus,
  deps: string[] = [],
): AgentTask {
  return {
    id,
    parentTaskId: "ticket-1",
    title: `Task ${id}`,
    criteria: "do the thing",
    status,
    dependencyIds: deps,
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function state(over: Partial<LoopState> = {}): LoopState {
  return {
    workspace: emptyTaskWorkspace(),
    ticketId: "ticket-1",
    active: {},
    prepared: true,
    ticketOpen: true,
    paused: false,
    slots: 2,
    ...over,
  };
}

function withTasks(
  tasks: AgentTask[],
  over: Partial<LoopState> = {},
): LoopState {
  return state({
    workspace: { ...emptyTaskWorkspace(), agentTasks: tasks },
    ...over,
  });
}

describe("planLoop", () => {
  test("sets the staging area up before anything else", () => {
    expect(planLoop(state({ prepared: false }))).toEqual([{ kind: "prepare" }]);
  });

  test("opens the ticket branch before handing out work", () => {
    expect(planLoop(state({ ticketOpen: false }))).toEqual([
      { kind: "open-ticket" },
    ]);
  });

  test("a paused ticket does nothing at all", () => {
    // Paused wins even over an unprepared staging area: nothing should touch
    // the repository while a person is deciding.
    const steps = planLoop(state({ paused: true, prepared: false }));
    expect(steps).toEqual([{ kind: "wait", reason: "The ticket is paused." }]);
  });

  test("waits when the ticket has no tasks yet", () => {
    expect(planLoop(state())[0]).toMatchObject({ kind: "wait" });
  });

  test("hands out ready work up to the number of free workers", () => {
    const steps = planLoop(
      withTasks([task("a", "ready"), task("b", "ready"), task("c", "ready")]),
    );
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => (step as { task: AgentTask }).task.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("a task already handed out is never started twice", () => {
    // The workspace still says "ready" because the status write has not landed.
    const steps = planLoop(
      withTasks([task("a", "ready"), task("b", "ready")], {
        active: { a: { state: "running", runId: "r1" } },
      }),
    );
    expect(steps).toEqual([{ kind: "start-task", task: task("b", "ready") }]);
  });

  test("a finished run frees its worker again", () => {
    const steps = planLoop(
      withTasks([task("a", "complete"), task("b", "ready")], {
        active: { a: { state: "finished" } },
        slots: 1,
      }),
    );
    expect(steps).toEqual([{ kind: "start-task", task: task("b", "ready") }]);
  });

  test("waits rather than overfilling the workers", () => {
    const steps = planLoop(
      withTasks([task("a", "ready"), task("b", "ready")], {
        active: { a: { state: "running" }, b: { state: "starting" } },
      }),
    );
    expect(steps).toEqual([{ kind: "wait", reason: "Every worker is busy." }]);
  });

  test("waits while work is in progress and nothing else is ready", () => {
    const steps = planLoop(
      withTasks([task("a", "running"), task("b", "queued", ["a"])], {
        active: { a: { state: "running" } },
      }),
    );
    expect(steps[0]).toMatchObject({ kind: "wait" });
  });

  test("says so when everything left is blocked", () => {
    const steps = planLoop(
      withTasks([task("a", "blocked"), task("b", "complete")]),
    );
    expect(steps).toEqual([
      { kind: "wait", reason: "Every remaining task is blocked." },
    ]);
  });

  test("reports the ticket finished once every task is complete", () => {
    const steps = planLoop(
      withTasks([task("a", "complete"), task("b", "complete")]),
    );
    expect(steps).toEqual([{ kind: "ticket-done" }]);
  });
});

describe("latestReports", () => {
  test("a retried task keeps only its newest outcome", () => {
    const reports: TaskReport[] = [
      { ticket: "T", task: "a", status: "blocked", detail: "first try", at: 1 },
      {
        ticket: "T",
        task: "a",
        status: "complete",
        detail: "second try",
        at: 2,
      },
      { ticket: "T", task: "b", status: "complete", detail: "fine", at: 1 },
    ];
    const newest = latestReports(reports);
    expect(newest.a.status).toBe("complete");
    expect(newest.a.detail).toBe("second try");
    expect(newest.b.status).toBe("complete");
  });

  test("no reports is not an error", () => {
    expect(latestReports([])).toEqual({});
  });
});
