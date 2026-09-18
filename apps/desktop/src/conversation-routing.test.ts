import { describe, expect, test } from "bun:test";
import type { AgentTask, Task } from "@berdloop/core";
import {
  conversationKey,
  mergeConversations,
  messageScopes,
  type ConversationSnapshot,
} from "./conversation-routing";
import type { WorkflowAction } from "./workflow-ui";

const tickets = [
  { id: "t1", projectId: "p1" },
  { id: "t2", projectId: "p1" },
  { id: "t3", projectId: "p2" },
] as Task[];
const tasks = [
  { id: "a", parentTaskId: "t1", status: "running" },
  { id: "b", parentTaskId: "t1", status: "ready" },
  { id: "c", parentTaskId: "t2", status: "running" },
  { id: "d", parentTaskId: "t3", status: "running" },
  { id: "done", parentTaskId: "t1", status: "complete" },
] as AgentTask[];
const action: WorkflowAction = {
  kind: "message",
  organizationId: "org",
  projectId: "p1",
  ticketId: "t1",
  text: "Check accessibility",
};

describe("UI conversation addresses", () => {
  test("each coordinator and worker has its own backend address", () => {
    expect(
      messageScopes({ ...action, target: "ticket-agent" }, tickets, tasks).map(
        conversationKey,
      ),
    ).toEqual(["ticket-agent:p1"]);
    expect(
      messageScopes({ ...action, target: "planner" }, tickets, tasks).map(
        conversationKey,
      ),
    ).toEqual(["planner:t1"]);
    expect(
      messageScopes(
        { ...action, target: "worker", taskId: "a" },
        tickets,
        tasks,
      ).map(conversationKey),
    ).toEqual(["a"]);
  });
  test("all-workers includes queued tasks but never another ticket, project, or completed task", () => {
    const scopes = messageScopes(
      { ...action, target: "all-workers" },
      tickets,
      tasks,
    );
    expect(scopes.map(conversationKey)).toEqual(["a", "b"]);
    expect(
      scopes.every(
        (scope) => scope.projectId === "p1" && scope.ticketId === "t1",
      ),
    ).toBe(true);
  });
  test("rejects mismatched selections instead of falling back to a different agent", () => {
    expect(() =>
      messageScopes(
        { ...action, projectId: "p2", target: "planner" },
        tickets,
        tasks,
      ),
    ).toThrow();
    expect(() =>
      messageScopes(
        { ...action, target: "worker", taskId: "c" },
        tickets,
        tasks,
      ),
    ).toThrow();
    expect(() =>
      messageScopes(
        { ...action, projectId: "", target: "ticket-agent" },
        tickets,
        tasks,
      ),
    ).toThrow();
  });
});

const snapshot = (revision: number, text: string): ConversationSnapshot => ({
  agentId: "a",
  scope: {
    organizationId: "org",
    projectId: "p1",
    ticketId: "t1",
    taskId: "a",
    role: "worker",
  },
  revision,
  runId: "run-a",
  harness: "claude-code",
  activity: "coding",
  streaming: true,
  messages: [{ id: "message", role: "agent", text }],
});

describe("backend conversation snapshots", () => {
  test("a late initial fetch cannot erase output already received", () => {
    const streamed = mergeConversations({}, [snapshot(3, "latest reply")]);
    const restored = mergeConversations(streamed, [snapshot(1, "old reply")]);
    expect(restored.a?.messages[0]?.text).toBe("latest reply");
  });
  test("restores an existing conversation after a UI remount, without duplicating messages", () => {
    const current = snapshot(5, "kept in Rust");
    const restored = mergeConversations({}, [current]);
    expect(mergeConversations(restored, [current]).a?.messages).toEqual(
      current.messages,
    );
  });
  test("rejects a snapshot whose key disagrees with its scope", () => {
    expect(
      mergeConversations({}, [{ ...snapshot(1, "wrong chat"), agentId: "b" }]),
    ).toEqual({});
  });
});
