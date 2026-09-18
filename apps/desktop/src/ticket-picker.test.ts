import { describe, expect, test } from "bun:test";
import type { ExternalIssue } from "@berdloop/core";
import {
  needsConnection,
  recentFirst,
  searchSequence,
  updatedLabel,
} from "./ticket-picker";

function issue(key: string, updatedAt?: string): ExternalIssue {
  return {
    provider: "Linear",
    id: key.toLowerCase(),
    key,
    url: `https://linear.app/example/issue/${key}`,
    title: key,
    description: "",
    status: "Todo",
    updatedAt,
  };
}

describe("search sequence", () => {
  test("a slow earlier answer never overwrites a newer one", () => {
    const sequence = searchSequence();
    const first = sequence.start();
    const second = sequence.start();
    // The second search answers first, so it is the one on screen.
    expect(sequence.accept(second)).toBe(true);
    expect(sequence.accept(first)).toBe(false);
  });

  test("answers that arrive in order are all accepted", () => {
    const sequence = searchSequence();
    const first = sequence.start();
    expect(sequence.accept(first)).toBe(true);
    const second = sequence.start();
    expect(sequence.accept(second)).toBe(true);
  });

  test("one answer is shown once, however often it arrives", () => {
    const sequence = searchSequence();
    const ticket = sequence.start();
    expect(sequence.accept(ticket)).toBe(true);
    expect(sequence.accept(ticket)).toBe(false);
  });
});

describe("recent first", () => {
  test("the newest change leads and an undated issue goes last", () => {
    const listed = recentFirst([
      issue("BRD-1", "2026-09-01T10:00:00.000Z"),
      issue("BRD-2"),
      issue("BRD-3", "2026-09-17T10:00:00.000Z"),
      issue("BRD-4", "2026-09-05T10:00:00.000Z"),
    ]);
    expect(listed.map((found) => found.key)).toEqual([
      "BRD-3",
      "BRD-4",
      "BRD-1",
      "BRD-2",
    ]);
  });

  test("the provider's own list is left alone", () => {
    const provided = [issue("BRD-1", "2026-09-01T10:00:00.000Z")];
    expect(recentFirst(provided)).not.toBe(provided);
  });
});

describe("updated label", () => {
  test("an issue the provider never dated says nothing", () => {
    expect(updatedLabel(issue("BRD-1"))).toBe("");
    expect(updatedLabel(issue("BRD-2", "not a date"))).toBe("");
  });

  test("a dated issue reads as a date", () => {
    expect(updatedLabel(issue("BRD-3", "2026-09-17T10:00:00.000Z"))).not.toBe(
      "",
    );
  });
});

describe("needs connection", () => {
  test("the host's refusal is told apart from any other failure", () => {
    expect(needsConnection("Connect Linear in settings first.", "Linear")).toBe(
      true,
    );
    expect(needsConnection("Connect Jira in settings first.", "Linear")).toBe(
      false,
    );
    expect(needsConnection("Provider returned HTTP 401.", "Linear")).toBe(
      false,
    );
  });
});
