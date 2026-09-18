import { beforeEach, describe, expect, test } from "bun:test";
import {
  readDraft,
  saveDraft,
  type DraftOptions,
  type DraftStorage,
} from "./drafts";
import {
  moveNewTicketDrafts,
  newTicketDraftKey,
  newTicketFields,
} from "./new-ticket-draft";

/** localStorage, small enough to assert against. */
class MemoryStorage implements DraftStorage {
  private entries = new Map<string, string>();

  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }

  removeItem(key: string) {
    this.entries.delete(key);
  }

  key(index: number) {
    return [...this.entries.keys()][index] ?? null;
  }

  get length() {
    return this.entries.size;
  }
}

let storage: MemoryStorage;
let settings: DraftOptions;

beforeEach(() => {
  storage = new MemoryStorage();
  settings = { storage };
});

/** What the form shows for one field when it opens aimed at a project. */
function shown(projectId: string, field: "title" | "reference" | "criteria") {
  return readDraft(newTicketDraftKey(projectId, field), settings);
}

/** What the form writes as a person types into one field. */
function type(
  projectId: string,
  field: "title" | "reference" | "criteria",
  text: string,
) {
  saveDraft(newTicketDraftKey(projectId, field), text, settings);
}

describe("new-ticket draft keys", () => {
  test("names the project the ticket will be created in", () => {
    expect(newTicketDraftKey("project-a", "title")).toBe(
      "new-ticket:project-a:title",
    );
  });

  test("a form with no target yet is not a project", () => {
    expect(newTicketDraftKey("", "criteria")).toBe("new-ticket:none:criteria");
  });

  test("two organizations' targets do not share a draft", () => {
    // The repro: organization A has no project in view, so the form resolved
    // its target from the organization's first project. Switching to
    // organization B resolves a different project, and must show nothing.
    type("project-a", "title", "Add the paused state check");
    type("project-a", "reference", "BRD-128");
    type("project-a", "criteria", "A paused task does not advance.");

    for (const field of newTicketFields) {
      expect(shown("project-b", field)).toBe("");
    }
    expect(shown("project-a", "title")).toBe("Add the paused state check");
  });
});

describe("moveNewTicketDrafts", () => {
  test("carries what is on screen to the newly chosen project", () => {
    type("project-a", "title", "Add the paused state check");
    type("project-a", "reference", "BRD-128");

    moveNewTicketDrafts(
      "project-a",
      "project-b",
      [
        { field: "title", text: "Add the paused state check" },
        { field: "reference", text: "BRD-128" },
        { field: "criteria", text: "A paused task does not advance." },
      ],
      settings,
    );

    expect(shown("project-b", "title")).toBe("Add the paused state check");
    expect(shown("project-b", "reference")).toBe("BRD-128");
    expect(shown("project-b", "criteria")).toBe(
      "A paused task does not advance.",
    );
  });

  test("leaves nothing behind under the project it came from", () => {
    type("project-a", "title", "Add the paused state check");

    moveNewTicketDrafts(
      "project-a",
      "project-b",
      [
        { field: "title", text: "Add the paused state check" },
        { field: "reference", text: "" },
        { field: "criteria", text: "" },
      ],
      settings,
    );

    expect(shown("project-a", "title")).toBe("");
  });

  test("a seeded field keeps its seed rather than storing it", () => {
    moveNewTicketDrafts(
      "project-a",
      "project-b",
      [
        { field: "title", text: "" },
        { field: "reference", text: "" },
        { field: "criteria", text: "Seeded criteria", seed: "Seeded criteria" },
      ],
      settings,
    );

    expect(storage.length).toBe(0);
    expect(
      readDraft(newTicketDraftKey("project-b", "criteria"), {
        ...settings,
        seed: "Seeded criteria",
      }),
    ).toBe("Seeded criteria");
  });

  test("aiming at the project already targeted leaves the draft alone", () => {
    type("project-a", "title", "Add the paused state check");

    moveNewTicketDrafts(
      "project-a",
      "project-a",
      [{ field: "title", text: "" }],
      settings,
    );

    expect(shown("project-a", "title")).toBe("Add the paused state check");
  });
});
