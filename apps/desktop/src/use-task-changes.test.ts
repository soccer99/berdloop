import { describe, expect, test } from "bun:test";
import { decideFetch, type ChangesTick } from "./use-task-changes";

const tick = (over: Partial<ChangesTick> = {}): ChangesTick => ({
  key: "p\u0000ENG-42\u0000task\u0000ticket",
  refresh: 0,
  messageCount: 3,
  streaming: false,
  visible: false,
  ...over,
});

describe("decideFetch", () => {
  test("fetches once for a task it has not seen, open or not", () => {
    expect(decideFetch(undefined, tick(), false)).toEqual({
      fetch: true,
      stale: false,
    });
  });

  test("fetches when the base changes", () => {
    const next = tick({ key: "p\u0000ENG-42\u0000task\u0000commit" });
    expect(decideFetch(tick(), next, false).fetch).toBe(true);
  });

  test("fetches when Refresh is pressed", () => {
    expect(decideFetch(tick(), tick({ refresh: 1 }), false).fetch).toBe(true);
  });

  test("a shut tab remembers a message instead of fetching", () => {
    expect(decideFetch(tick(), tick({ messageCount: 4 }), false)).toEqual({
      fetch: false,
      stale: true,
    });
  });

  test("a shut tab remembers the end of a stream instead of fetching", () => {
    const before = tick({ streaming: true });
    expect(decideFetch(before, tick({ streaming: false }), false)).toEqual({
      fetch: false,
      stale: true,
    });
  });

  test("a whole stream into a shut tab is one mark, never a fetch", () => {
    let stale = false;
    let before = tick();
    for (let count = 4; count < 30; count++) {
      const now = tick({ messageCount: count, streaming: true });
      const decision = decideFetch(before, now, stale);
      expect(decision.fetch).toBe(false);
      stale = decision.stale;
      before = now;
    }
    expect(stale).toBe(true);
  });

  test("opening a stale tab fetches once, and then holds still", () => {
    const shut = tick({ messageCount: 4 });
    const open = tick({ messageCount: 4, visible: true });
    expect(decideFetch(shut, open, true)).toEqual({
      fetch: true,
      stale: false,
    });
    expect(decideFetch(open, open, false)).toEqual({
      fetch: false,
      stale: false,
    });
  });

  test("opening a tab nothing happened to does not fetch", () => {
    expect(decideFetch(tick(), tick({ visible: true }), false)).toEqual({
      fetch: false,
      stale: false,
    });
  });

  test("an open tab follows the agent", () => {
    const before = tick({ visible: true });
    const after = tick({ visible: true, messageCount: 4 });
    expect(decideFetch(before, after, false)).toEqual({
      fetch: true,
      stale: false,
    });
  });

  test("a render that changes nothing leaves the mark alone", () => {
    expect(decideFetch(tick(), tick(), true)).toEqual({
      fetch: false,
      stale: true,
    });
  });
});

/**
 * The hook keeps a previous tick and a stale mark across renders and feeds
 * them back in, so replaying a run through the same two carries counts the
 * fetches a real worker would cause.
 */
function fetches(run: ChangesTick[]): number {
  let before: ChangesTick | undefined;
  let stale = false;
  let count = 0;
  for (const now of run) {
    const decision = decideFetch(before, now, stale);
    before = now;
    stale = decision.stale;
    if (decision.fetch) count++;
  }
  return count;
}

describe("a worker streaming into a shut Changes tab", () => {
  const stream = (visible: boolean) =>
    Array.from({ length: 40 }, (_, index) =>
      tick({ messageCount: 3 + index, streaming: true, visible }),
    );

  test("costs one fetch on task load and one more on opening", () => {
    const run = [
      tick({ messageCount: 3 }),
      ...stream(false),
      tick({ messageCount: 42, streaming: false }),
      // The tab opens on a thread that has finished.
      tick({ messageCount: 42, streaming: false, visible: true }),
      tick({ messageCount: 42, streaming: false, visible: true }),
    ];
    expect(fetches(run)).toBe(2);
  });

  test("follows the agent while the tab is open", () => {
    expect(fetches([tick({ visible: true }), ...stream(true)])).toBe(40);
  });
});
