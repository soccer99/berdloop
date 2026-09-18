/**
 * Beta features backed by Jev, a decision model.
 *
 * Jev writes no text. It answers typed questions about one block of state, all
 * of them in the same call, each with a probability. That makes it cheap
 * enough to ask on every worker turn and fast enough to sit in front of a
 * person who is waiting.
 *
 * The key stays in the native host, which also knows which gateway serves Jev
 * and what that gateway calls each question type. This file writes one kind of
 * question, gets back one kind of answer, and never learns which gateway
 * answered.
 *
 * Everything below `decide` is pure. A decision this small is not worth a
 * network round trip to test, and the parts worth getting right are the sort
 * that a person cannot check by looking: the order a list comes back in.
 *
 * Every function here fails quiet. No key, no network, an answer the model is
 * not sure about: the caller gets nothing back and keeps the behaviour it had
 * before the beta was turned on.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AgentTask, Task } from "@berdloop/core";

/** One answer: what Jev picked, and how sure it is, from 0 to 1. */
export interface Decision {
  value: string;
  confidence: number;
}
export type Decisions = Record<string, Decision>;

/**
 * A question. `boolean` asks for a yes/no probability, `choice` picks one of
 * the named criteria, and `score` places the state on an ordered scale.
 */
export type Question =
  | {
      type: "boolean";
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Questions = Record<string, Question>;

/**
 * How sure Jev must be before anything acts on an answer.
 *
 * Jev is calibrated, so this reads as "wrong about one time in five". Nothing
 * here is destructive: the worst an answer does is reorder a queue or put a
 * label on a worker, and a person can see and undo both.
 */
export const SURE_ENOUGH = 0.8;

/**
 * Ask the host to put one question set to Jev.
 *
 * Returns nothing at all when the beta is off or the call fails. Callers treat
 * an empty result and a result below the threshold the same way: do what you
 * would have done anyway.
 */
export async function decide(
  state: string,
  questions: Questions,
): Promise<Decisions> {
  try {
    return await invoke<Decisions>("jev_decide", { state, questions });
  } catch {
    return {};
  }
}

/** An answer, only if Jev was sure enough about it. */
function sure(answers: Decisions, id: string): string | undefined {
  const answer = answers[id];
  return answer && answer.confidence >= SURE_ENOUGH ? answer.value : undefined;
}

/* ------------------------------------------------------------------ *
 * Routing a steering message
 * ------------------------------------------------------------------ */

/** Who a typed instruction was meant for. */
export type Route = "ticket-agent" | "planner" | "all-workers";
const ROUTES: Route[] = ["ticket-agent", "planner", "all-workers"];

const ROUTE_QUESTIONS: Questions = {
  audience: {
    type: "choice",
    instructions:
      "A person typed this instruction while agents are working on a ticket. Who is it for?",
    criteria: {
      "ticket-agent":
        "It is about which tickets exist, their order, their requirements, or starting and pausing them.",
      planner:
        "It is about how this one ticket is broken into tasks: adding, removing, reordering, or changing a task and its acceptance criteria.",
      "all-workers":
        "It is about how the code should be written right now: a correction, a constraint, or a detail every worker on this ticket needs.",
    },
  },
};

/** Read the audience out of an answer set. Undefined means "not sure". */
export function readRoute(answers: Decisions): Route | undefined {
  const value = sure(answers, "audience");
  return ROUTES.find((route) => route === value);
}

/**
 * Suggest who a steering message belongs to.
 *
 * A suggestion only. The caller still shows the person which chat they are
 * about to speak into, because sending a correction to the wrong agent is a
 * mistake nobody can see until the wrong code arrives.
 */
export async function routeSteering(
  text: string,
  context: { ticket?: string; tasks?: string[] } = {},
): Promise<Route | undefined> {
  if (!text.trim()) return undefined;
  const state = [
    context.ticket ? `Ticket: ${context.ticket}` : "",
    context.tasks?.length
      ? `Tasks in flight:\n- ${context.tasks.join("\n- ")}`
      : "",
    `Instruction:\n${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return readRoute(await decide(state, ROUTE_QUESTIONS));
}

/* ------------------------------------------------------------------ *
 * Stall detection
 * ------------------------------------------------------------------ */

/** How much of a worker's output is worth showing the model. */
const STALL_WINDOW = 6000;
/** Below this many characters there is nothing yet to judge. */
const STALL_FLOOR = 400;

const STALL_QUESTIONS: Questions = {
  repeating: {
    type: "boolean",
    instructions:
      "Is this agent repeating itself: running the same command again, or trying a fix it already tried?",
    criteria: {
      true: "The same command, error, or approach appears more than once with no change between attempts.",
      false:
        "Each step differs from the last, or the same command now gives a different result.",
    },
  },
  progressing: {
    type: "boolean",
    instructions: "Is this agent getting closer to finishing its task?",
    criteria: {
      true: "Errors are being resolved, files are changing, or checks that failed now pass.",
      false:
        "It is stuck on the same problem, or has been reading and thinking without changing anything.",
    },
  },
};

/**
 * Read a stall out of an answer set.
 *
 * Both questions must agree. Repetition alone is a normal part of a test and
 * fix cycle, and a quiet stretch alone might be a long build. Repeating *and*
 * not progressing is the pattern worth a person's attention.
 */
export function readStall(answers: Decisions): boolean {
  return (
    sure(answers, "repeating") === "true" &&
    sure(answers, "progressing") === "false"
  );
}

/**
 * Judge whether a worker is going round in circles.
 *
 * This is a label, never an action. A stalled worker keeps running: the loop
 * has its own limits, and a worker that is merely slow must not be stopped by
 * a second model's opinion.
 */
export async function detectStall(
  transcript: string,
  task?: string,
): Promise<boolean> {
  const tail = transcript.slice(-STALL_WINDOW);
  if (tail.length < STALL_FLOOR) return false;
  // The task line is left out when there is no title to give. An identifier
  // tells the model nothing, and unrelated text in the state makes its answers
  // worse rather than leaving them unchanged.
  const state = [task ? `Task: ${task}` : "", `Most recent output:\n${tail}`]
    .filter(Boolean)
    .join("\n\n");
  return readStall(await decide(state, STALL_QUESTIONS));
}

/* ------------------------------------------------------------------ *
 * Ordering by dependency and severity
 * ------------------------------------------------------------------ */

/**
 * The most items one ordering call covers.
 *
 * Every pair is a question, so the call grows with the square of the list.
 * Eight items is 56 questions, which Jev answers in a single pass. Past that
 * the first eight are ordered and the rest keep the places they had.
 */
export const ORDER_LIMIT = 8;

export interface Orderable {
  id: string;
  title: string;
  criteria?: string;
}

/** The severity scale, lowest first. Only used when severity is asked for. */
const SEVERITY = [
  "Optional polish. Nothing else suffers if it is late.",
  "Ordinary work. It should happen, in no particular hurry.",
  "Other work is waiting on it, or a person is blocked.",
  "Something is broken or unsafe until this is done.",
];

/** The state one ordering call is judged against. */
export function orderState(items: Orderable[], kind: string): string {
  const described = items
    .map(
      (item, index) =>
        `[${index}] ${item.title}${item.criteria ? `\n    ${item.criteria}` : ""}`,
    )
    .join("\n");
  return `${kind}, each with its index:\n\n${described}`;
}

/**
 * Build the questions for one ordering call.
 *
 * One yes/no per ordered pair, plus one severity score per item when asked.
 * Pairs rather than one question about the whole list, because Jev is at its
 * best on a narrow question and a pair is the narrowest one there is.
 */
export function orderQuestions(
  items: Orderable[],
  withSeverity: boolean,
): Questions {
  const questions: Questions = {};
  items.forEach((_, i) => {
    items.forEach((_, j) => {
      if (i === j) return;
      questions[`dep_${i}_${j}`] = {
        type: "boolean",
        instructions: `Does the work in [${i}] need the work in [${j}] to be finished first?`,
        criteria: {
          true: `[${i}] builds on something [${j}] creates, or would have to be redone if [${j}] landed after it.`,
          false: `[${i}] can be done before [${j}], or the two do not depend on each other at all.`,
        },
      };
    });
  });
  if (withSeverity) {
    items.forEach((_, i) => {
      questions[`sev_${i}`] = {
        type: "score",
        instructions: `How urgent is the work in [${i}]?`,
        criteria: SEVERITY,
      };
    });
  }
  return questions;
}

/**
 * Turn a score answer into a rank. Higher is more urgent.
 *
 * One gateway answers with the rung's own words and the other with a number
 * between the rungs, so both are accepted. An unanswered item sits in the
 * middle rather than at either end.
 */
function severityRank(answer: Decision | undefined): number {
  if (!answer) return 1;
  const asNumber = Number(answer.value);
  if (Number.isFinite(asNumber)) return asNumber;
  const rung = SEVERITY.indexOf(answer.value);
  return rung < 0 ? 1 : rung;
}

/**
 * Turn the answers into an order.
 *
 * A dependency is only believed when Jev is sure enough about it. What comes
 * out is the list that went in, rearranged: nothing is added, nothing is
 * dropped, and anything past the limit keeps its place at the end.
 *
 * A circular answer cannot deadlock the sort. When every remaining item claims
 * to be waiting for another, the most urgent of them goes next and its own
 * dependencies are ignored. Jev sees one pair at a time and never the list as
 * a whole, so it can contradict itself across pairs, and a sort that hung on
 * that would be worse than one that breaks the tie.
 */
export function readOrder(items: Orderable[], answers: Decisions): string[] {
  const sorted = items.slice(0, ORDER_LIMIT);
  const tail = items.slice(ORDER_LIMIT).map((item) => item.id);
  const size = sorted.length;
  if (size < 2) return items.map((item) => item.id);

  // needs[i] holds the indexes i is waiting for.
  const needs = sorted.map(() => new Set<number>());
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (i === j) continue;
      if (sure(answers, `dep_${i}_${j}`) === "true") needs[i]!.add(j);
    }
  }
  const urgency = sorted.map((_, i) => severityRank(answers[`sev_${i}`]));

  const order: number[] = [];
  const left = new Set(sorted.map((_, i) => i));
  // Most urgent first. A tie keeps the order the person already had, because
  // that order is a decision somebody made and a tie is not a reason to undo it.
  const best = (candidates: number[]) =>
    candidates.reduce((a, b) => (urgency[b]! > urgency[a]! ? b : a));
  while (left.size) {
    const free = [...left].filter(
      (i) => ![...needs[i]!].some((need) => left.has(need)),
    );
    const next = best(free.length ? free : [...left]);
    order.push(next);
    left.delete(next);
  }
  return [...order.map((i) => sorted[i]!.id), ...tail];
}

/** Ask Jev for an order. Returns nothing when it cannot answer. */
async function order(
  items: Orderable[],
  kind: string,
  withSeverity: boolean,
): Promise<string[] | undefined> {
  if (items.length < 2) return undefined;
  const answers = await decide(
    orderState(items, kind),
    orderQuestions(items.slice(0, ORDER_LIMIT), withSeverity),
  );
  return Object.keys(answers).length ? readOrder(items, answers) : undefined;
}

/**
 * Order tickets by which one's features the next one builds on.
 *
 * Severity is not asked for here. A ticket queue is a person's own statement
 * of what matters, and rearranging it by a model's idea of urgency would
 * overwrite a decision they already made. Only the build order is offered.
 */
export function orderTickets(tickets: Task[]): Promise<string[] | undefined> {
  return order(
    tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      criteria: ticket.criteria,
    })),
    "Tickets waiting to be worked on",
    false,
  );
}

/**
 * Order the agent tasks under one ticket, by urgency and by what they need.
 *
 * Merge conflicts are deliberately not part of this. Workers resolve those
 * themselves when they reach the front of the merge queue, so ordering around
 * them would be guarding a problem that is already solved.
 */
export function orderAgentTasks(
  tasks: AgentTask[],
): Promise<string[] | undefined> {
  return order(
    tasks.map((task) => ({
      id: task.id,
      title: task.title,
      criteria: task.criteria,
    })),
    "Agent tasks under one ticket",
    true,
  );
}
