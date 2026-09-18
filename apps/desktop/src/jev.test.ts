import { expect, test } from "bun:test";
import {
  ORDER_LIMIT,
  orderQuestions,
  orderState,
  readOrder,
  readRoute,
  readStall,
  SURE_ENOUGH,
  type Decisions,
  type Orderable,
} from "./jev";

const sure = (value: string) => ({ value, confidence: 0.99 });
const unsure = (value: string) => ({ value, confidence: SURE_ENOUGH - 0.01 });
const items = (...titles: string[]): Orderable[] =>
  titles.map((title) => ({ id: title, title }));

/** "a needs b first." */
const needs = (items: Orderable[], a: string, b: string): Decisions => ({
  [`dep_${items.findIndex((i) => i.id === a)}_${items.findIndex((i) => i.id === b)}`]:
    sure("true"),
});
const urgency = (items: Orderable[], id: string, rank: string): Decisions => ({
  [`sev_${items.findIndex((i) => i.id === id)}`]: sure(rank),
});

test("a confident audience is used and an unsure one is not", () => {
  expect(readRoute({ audience: sure("planner") })).toBe("planner");
  expect(readRoute({ audience: unsure("planner") })).toBeUndefined();
  expect(readRoute({})).toBeUndefined();
});

test("an audience the interface has no chat for is ignored", () => {
  expect(readRoute({ audience: sure("the-database") })).toBeUndefined();
});

test("a stall needs repetition and no progress together", () => {
  expect(
    readStall({ repeating: sure("true"), progressing: sure("false") }),
  ).toBe(true);
  // Repeating while still getting somewhere is an ordinary test and fix cycle.
  expect(
    readStall({ repeating: sure("true"), progressing: sure("true") }),
  ).toBe(false);
  // Quiet but not repeating is a long build, not a stall.
  expect(
    readStall({ repeating: sure("false"), progressing: sure("false") }),
  ).toBe(false);
  expect(readStall({ repeating: sure("true") })).toBe(false);
});

test("an unsure stall answer leaves the worker alone", () => {
  expect(
    readStall({ repeating: unsure("true"), progressing: sure("false") }),
  ).toBe(false);
});

test("one question per ordered pair, and severity only when asked for", () => {
  const three = items("a", "b", "c");
  const plain = orderQuestions(three, false);
  expect(Object.keys(plain)).toHaveLength(6);
  expect(plain.dep_0_1!.type).toBe("boolean");
  expect(plain.dep_0_0).toBeUndefined();
  const scored = orderQuestions(three, true);
  expect(Object.keys(scored)).toHaveLength(9);
  expect(scored.sev_2!.type).toBe("score");
});

test("the state names every item by the index its questions use", () => {
  const state = orderState(
    [
      { id: "1", title: "Add the schema", criteria: "Migration applies" },
      { id: "2", title: "Add the endpoint" },
    ],
    "Tickets",
  );
  expect(state).toContain("[0] Add the schema");
  expect(state).toContain("Migration applies");
  expect(state).toContain("[1] Add the endpoint");
});

test("a dependency puts the thing it waits for first", () => {
  const three = items("endpoint", "schema", "docs");
  expect(readOrder(three, needs(three, "endpoint", "schema"))).toEqual([
    "schema",
    "endpoint",
    "docs",
  ]);
});

test("a chain of dependencies comes out in build order", () => {
  const three = items("ui", "endpoint", "schema");
  const answers = {
    ...needs(three, "ui", "endpoint"),
    ...needs(three, "endpoint", "schema"),
  };
  expect(readOrder(three, answers)).toEqual(["schema", "endpoint", "ui"]);
});

test("an unsure dependency is not believed", () => {
  const two = items("endpoint", "schema");
  expect(readOrder(two, { dep_0_1: unsure("true") })).toEqual([
    "endpoint",
    "schema",
  ]);
});

test("urgency decides between two items that wait for nothing", () => {
  const three = items("polish", "broken", "normal");
  const answers = {
    ...urgency(three, "polish", "0"),
    ...urgency(three, "broken", "3"),
    ...urgency(three, "normal", "1"),
  };
  expect(readOrder(three, answers)).toEqual(["broken", "normal", "polish"]);
});

test("a dependency outranks urgency, because urgent work that cannot start is not work", () => {
  const two = items("urgent", "groundwork");
  const answers = {
    ...needs(two, "urgent", "groundwork"),
    ...urgency(two, "urgent", "3"),
    ...urgency(two, "groundwork", "0"),
  };
  expect(readOrder(two, answers)).toEqual(["groundwork", "urgent"]);
});

test("the rung's own words rank the same as its number", () => {
  const two = items("a", "b");
  const spelled = {
    sev_0: sure("Optional polish. Nothing else suffers if it is late."),
    sev_1: sure("Something is broken or unsafe until this is done."),
  };
  expect(readOrder(two, spelled)).toEqual(["b", "a"]);
});

test("an item nobody scored keeps its place rather than sinking", () => {
  const three = items("first", "scored", "last");
  expect(readOrder(three, urgency(three, "scored", "1"))).toEqual([
    "first",
    "scored",
    "last",
  ]);
});

test("a circular answer still produces a full order", () => {
  const two = items("a", "b");
  const answers = { ...needs(two, "a", "b"), ...needs(two, "b", "a") };
  const order = readOrder(two, answers);
  expect(order).toHaveLength(2);
  expect([...order].sort()).toEqual(["a", "b"]);
});

test("a three-way circle resolves to the most urgent first", () => {
  const three = items("a", "b", "c");
  const answers = {
    ...needs(three, "a", "b"),
    ...needs(three, "b", "c"),
    ...needs(three, "c", "a"),
    ...urgency(three, "b", "3"),
  };
  expect(readOrder(three, answers)[0]).toBe("b");
});

test("no answers at all leaves the order exactly as it was", () => {
  const three = items("a", "b", "c");
  expect(readOrder(three, {})).toEqual(["a", "b", "c"]);
});

test("nothing is added, dropped, or duplicated", () => {
  const five = items("a", "b", "c", "d", "e");
  const answers = {
    ...needs(five, "a", "e"),
    ...needs(five, "b", "d"),
    ...needs(five, "c", "a"),
  };
  expect([...readOrder(five, answers)].sort()).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
});

test("items past the limit keep their places at the end", () => {
  const many = items(
    ...Array.from({ length: ORDER_LIMIT + 3 }, (_, i) => `t${i}`),
  );
  const answers = needs(many, "t0", "t1");
  const order = readOrder(many, answers);
  expect(order).toHaveLength(many.length);
  expect(order.slice(ORDER_LIMIT)).toEqual([
    `t${ORDER_LIMIT}`,
    `t${ORDER_LIMIT + 1}`,
    `t${ORDER_LIMIT + 2}`,
  ]);
  expect(order.indexOf("t1")).toBeLessThan(order.indexOf("t0"));
});

test("one item is not worth reordering", () => {
  expect(readOrder(items("only"), {})).toEqual(["only"]);
  expect(readOrder([], {})).toEqual([]);
});
