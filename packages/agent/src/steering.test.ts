import { describe, expect, test } from "bun:test";
import {
  applySteer,
  planSteer,
  takePending,
  type Conversation,
} from "./steering";

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    role: "worker",
    state: "running",
    harness: "claude-code",
    ticket: "ENG-42",
    pending: [],
    ...over,
  };
}

describe("planSteer", () => {
  test("a running conversation is interrupted", () => {
    const live = conversation({ sessionId: "s1", taskId: "t1" });
    expect(
      planSteer([live], { taskId: "t1" }, "stop using the old API"),
    ).toEqual([
      {
        kind: "inject",
        conversationId: "c1",
        harness: "claude-code",
        sessionId: "s1",
        message: "stop using the old API",
      },
    ]);
  });

  test("a queued conversation keeps the message for when it starts", () => {
    const queued = conversation({ state: "queued", taskId: "t1" });
    expect(planSteer([queued], { taskId: "t1" }, "use the new API")).toEqual([
      { kind: "hold", conversationId: "c1", message: "use the new API" },
    ]);
  });

  test("a started conversation that has not reported its id is held, not injected", () => {
    // Injecting needs a session id. Holding is always safe.
    const starting = conversation({ sessionId: undefined });
    expect(planSteer([starting], { all: true }, "hello")[0].kind).toBe("hold");
  });

  test("a finished conversation is skipped with a reason", () => {
    const done = conversation({ state: "finished", sessionId: "s1" });
    const [action] = planSteer([done], { all: true }, "too late");
    expect(action.kind).toBe("skip");
  });

  test("a ticket's requirements reach every conversation on that ticket", () => {
    const all = [
      conversation({ id: "task-agent", role: "task-agent", sessionId: "s0" }),
      conversation({ id: "w1", taskId: "t1", sessionId: "s1" }),
      conversation({ id: "w2", taskId: "t2", state: "queued" }),
      conversation({ id: "other", ticket: "ENG-99", sessionId: "s9" }),
    ];
    const actions = planSteer(
      all,
      { ticket: "ENG-42" },
      "requirements changed",
    );
    expect(actions.map((a) => a.conversationId)).toEqual([
      "task-agent",
      "w1",
      "w2",
    ]);
    expect(actions.map((a) => a.kind)).toEqual(["inject", "inject", "hold"]);
  });

  test("a ticket agent can address just the task agent", () => {
    const all = [
      conversation({ id: "task-agent", role: "task-agent", sessionId: "s0" }),
      conversation({ id: "w1", taskId: "t1", sessionId: "s1" }),
    ];
    const actions = planSteer(
      all,
      { ticket: "ENG-42", role: "task-agent" },
      "replan",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].conversationId).toBe("task-agent");
  });

  test("an empty message is refused", () => {
    expect(() => planSteer([conversation()], { all: true }, "   ")).toThrow();
  });
});

describe("applySteer and takePending", () => {
  test("held messages are kept in order and handed over once", () => {
    let all = [conversation({ state: "queued", taskId: "t1" })];
    all = applySteer(all, planSteer(all, { taskId: "t1" }, "first"));
    all = applySteer(all, planSteer(all, { taskId: "t1" }, "second"));
    expect(all[0].pending).toEqual(["first", "second"]);

    const taken = takePending(all, "c1");
    expect(taken.pending).toEqual(["first", "second"]);
    // Taken means taken. A restart must not replay them.
    expect(taken.conversations[0].pending).toEqual([]);
    expect(takePending(taken.conversations, "c1").pending).toEqual([]);
  });

  test("injected messages are not stored", () => {
    const all = [conversation({ sessionId: "s1" })];
    const after = applySteer(all, planSteer(all, { all: true }, "live"));
    expect(after[0].pending).toEqual([]);
  });
});
