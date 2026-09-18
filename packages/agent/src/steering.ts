import type { AgentRole } from "./tools";
import type { HarnessId } from "./harness";

/**
 * Every conversation can be steered while it is alive, and every conversation
 * that has not started yet can be steered in advance.
 *
 * A person, a ticket agent or a task agent may all send an instruction. What
 * happens to it depends only on the state of the conversation it is aimed at:
 *
 * - running: the message is put into the live thread, mid-task.
 * - queued: the message is kept and folded into the prompt the agent will be
 *   given when a worker picks it up. Nothing is lost by steering early.
 * - finished: there is nobody to tell, so the caller is told that instead.
 *
 * Callers never have to know which case applies. Asking them to would mean
 * asking them to win a race against the queue.
 */

export type ConversationState = "queued" | "running" | "finished";

export interface Conversation {
  id: string;
  role: AgentRole;
  state: ConversationState;
  harness: HarnessId;
  /** The ticket this conversation serves. Every role has one except the ticket agent. */
  ticket?: string;
  /** Set for workers only. */
  taskId?: string;
  /** Known once the harness has reported or accepted one. */
  sessionId?: string;
  /** Instructions received while queued, oldest first. */
  pending: string[];
}

/** Who an instruction is aimed at. */
export type SteerTarget =
  | { conversationId: string }
  | { taskId: string }
  | { ticket: string; role?: AgentRole }
  | { all: true };

export type SteerAction =
  | {
      kind: "inject";
      conversationId: string;
      harness: HarnessId;
      sessionId: string;
      message: string;
    }
  | { kind: "hold"; conversationId: string; message: string }
  | { kind: "skip"; conversationId: string; reason: string };

export function matches(
  conversation: Conversation,
  target: SteerTarget,
): boolean {
  if ("all" in target) return true;
  if ("conversationId" in target)
    return conversation.id === target.conversationId;
  if ("taskId" in target) return conversation.taskId === target.taskId;
  return (
    conversation.ticket === target.ticket &&
    (!target.role || conversation.role === target.role)
  );
}

/**
 * Work out what to do with one instruction, without doing any of it.
 *
 * Returning a plan rather than acting keeps the decision testable and lets
 * the caller show a person exactly who is about to be interrupted.
 */
export function planSteer(
  conversations: Conversation[],
  target: SteerTarget,
  message: string,
): SteerAction[] {
  const text = message.trim();
  if (!text) throw new Error("A steering message cannot be empty.");

  return conversations
    .filter((item) => matches(item, target))
    .map((item) => {
      if (item.state === "finished") {
        return {
          kind: "skip" as const,
          conversationId: item.id,
          reason: "That conversation has already finished.",
        };
      }
      // A running conversation without a session id has started but not yet
      // said who it is. Holding the message is safe; injecting is not.
      if (item.state === "running" && item.sessionId) {
        return {
          kind: "inject" as const,
          conversationId: item.id,
          harness: item.harness,
          sessionId: item.sessionId,
          message: text,
        };
      }
      return { kind: "hold" as const, conversationId: item.id, message: text };
    });
}

/** Record the messages that could not be delivered yet. */
export function applySteer(
  conversations: Conversation[],
  actions: SteerAction[],
): Conversation[] {
  const held = new Map<string, string[]>();
  for (const action of actions) {
    if (action.kind !== "hold") continue;
    held.set(action.conversationId, [
      ...(held.get(action.conversationId) ?? []),
      action.message,
    ]);
  }
  if (!held.size) return conversations;
  return conversations.map((item) =>
    held.has(item.id)
      ? { ...item, pending: [...item.pending, ...held.get(item.id)!] }
      : item,
  );
}

/**
 * Hand over the messages a conversation collected while it waited, and clear
 * them. Called once, as the conversation starts.
 */
export function takePending(
  conversations: Conversation[],
  conversationId: string,
): { conversations: Conversation[]; pending: string[] } {
  const target = conversations.find((item) => item.id === conversationId);
  if (!target || !target.pending.length) {
    return { conversations, pending: [] };
  }
  return {
    pending: target.pending,
    conversations: conversations.map((item) =>
      item.id === conversationId ? { ...item, pending: [] } : item,
    ),
  };
}
