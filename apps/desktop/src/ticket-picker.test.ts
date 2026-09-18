import { describe, expect, test } from "bun:test";
import type { ExternalIssue } from "@berdloop/core";
import {
  settingsFix,
  recentFirst,
  searchSequence,
  ticketAgentPrompt,
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

describe("settings fix", () => {
  test("an unconnected provider is offered settings, and reads without the mark", () => {
    expect(settingsFix("Settings: Connect Linear in settings first.")).toBe(
      "Connect Linear in settings first.",
    );
    expect(settingsFix("Settings: Connect Jira in settings first.")).toBe(
      "Connect Jira in settings first.",
    );
  });

  test("a missing Asana workspace is offered settings too", () => {
    expect(
      settingsFix("Settings: Add your Asana workspace GID in settings."),
    ).toBe("Add your Asana workspace GID in settings.");
    expect(
      settingsFix("Settings: Enter a Jira Cloud site URL and account email."),
    ).toBe("Enter a Jira Cloud site URL and account email.");
  });

  test("a failure settings cannot fix is left as a failure", () => {
    expect(settingsFix("Provider returned HTTP 401.")).toBe("");
    // The wording alone is not the mark: only the host may say a refusal is
    // one settings can fix.
    expect(settingsFix("Connect Linear in settings first.")).toBe("");
  });
});

describe("ticket agent prompt", () => {
  const picked: ExternalIssue = {
    provider: "Jira",
    id: "10042",
    key: "BRD-12",
    url: "https://example.atlassian.net/browse/BRD-12",
    title: "Searchable ticket import",
    description: "The import modal should search, not ask for an id.",
    status: "In Progress",
    updatedAt: "2026-09-17T10:00:00.000Z",
  };

  test("the prompt names everything the picker knows", () => {
    const prompt = ticketAgentPrompt(picked);
    expect(prompt).toContain("Jira");
    expect(prompt).toContain("BRD-12");
    expect(prompt).toContain("https://example.atlassian.net/browse/BRD-12");
    expect(prompt).toContain("Searchable ticket import");
    expect(prompt).toContain("In Progress");
    expect(prompt).toContain(
      "The import modal should search, not ask for an id.",
    );
  });

  test("the last line tells the agent what to do", () => {
    const lines = ticketAgentPrompt(picked).split("\n");
    expect(lines[lines.length - 1]).toBe(
      "Import this into Berdloop with ticket_import (provider=Jira, reference=BRD-12), then plan it.",
    );
  });

  test("a body the picker never got is left out rather than left empty", () => {
    const prompt = ticketAgentPrompt({ ...picked, description: "   " });
    expect(prompt).not.toContain("Description");
    expect(prompt).toContain("BRD-12");
  });

  test("a ticket the provider left unstated still says where it stands", () => {
    expect(ticketAgentPrompt({ ...picked, status: "" })).toContain(
      "- Status: Unknown",
    );
  });
});
