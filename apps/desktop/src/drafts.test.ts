import { beforeEach, describe, expect, test } from "bun:test";
import {
  draftStorageKey,
  draftStoragePrefix,
  nextDraftRecord,
  parseDraftRecord,
  pruneDrafts,
  readDraft,
  readDraftRecord,
  removeDraft,
  resolveDraftValue,
  saveDraft,
  storedDraftKeys,
  type DraftOptions,
  type DraftStorage,
} from "./drafts";

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

  get keys() {
    return [...this.entries.keys()];
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

/**
 * One mounted editor, driven the way `useDraft` drives this module: it reads
 * the draft when it mounts, writes on every keystroke, and on `clear` forgets
 * the entry and falls back to the seed. Remounting is a second `mount` of the
 * same key, which is what a collapsed coordinator or a closed modal does.
 */
function mount(key: string, options: Omit<DraftOptions, "storage"> = {}) {
  const settings: DraftOptions = { ...options, storage };
  let value = readDraft(key, settings);
  saveDraft(key, value, settings);
  return {
    get value() {
      return value;
    },
    type(next: string) {
      value = next;
      saveDraft(key, next, settings);
    },
    clear() {
      removeDraft(key, settings);
      value = options.seed ?? "";
    },
  };
}

function stored(key: string) {
  return storage.getItem(draftStorageKey(key));
}

describe("a draft outliving its editor", () => {
  test("text typed into a composer comes back after unmount and remount", () => {
    const composer = mount("ticket-agent:project-1");
    composer.type("Ship the login fix once the");

    // The coordinator collapses, the view changes, a ticket is selected: the
    // body unmounts. Mounting again is the whole point of the ticket.
    expect(mount("ticket-agent:project-1").value).toBe(
      "Ship the login fix once the",
    );
  });

  test("a successful send clears the draft, so the next mount is empty", () => {
    const composer = mount("worker:task-7");
    composer.type("Re-run the failing migration");
    expect(stored("worker:task-7")).not.toBeNull();

    composer.clear();

    expect(composer.value).toBe("");
    expect(stored("worker:task-7")).toBeNull();
    expect(mount("worker:task-7").value).toBe("");
  });

  test("a send that throws leaves the draft where it was", () => {
    const composer = mount("worker:task-7");
    composer.type("Re-run the failing migration");

    const send = () => {
      throw new Error("sidecar not connected");
    };
    expect(send).toThrow("sidecar not connected");
    // clear() is never reached, which is the point: nothing cleared it.

    expect(mount("worker:task-7").value).toBe("Re-run the failing migration");
  });

  test("two subjects never share a draft", () => {
    mount("ticket-agent:project-1").type("Notes for the first project");
    mount("ticket-agent:project-2").type("Notes for the second project");

    expect(mount("ticket-agent:project-1").value).toBe(
      "Notes for the first project",
    );
    expect(mount("ticket-agent:project-2").value).toBe(
      "Notes for the second project",
    );
    expect(mount("task-editor:new").value).toBe("");
  });

  test("every draft lives under the one namespace", () => {
    mount("task-editor:new").type("Add the retry button");

    expect(storage.keys).toEqual([`${draftStoragePrefix}task-editor:new`]);
  });
});

describe("seeded editors", () => {
  const seed = "Restore the queue filters";

  test("a draft wins over the seed while the record is unchanged", () => {
    mount("task-editor:task-3", { seed }).type("Restore the queue filters and");

    expect(mount("task-editor:task-3", { seed }).value).toBe(
      "Restore the queue filters and",
    );
  });

  test("a draft is discarded when the record it was taken from changed", () => {
    mount("task-editor:task-3", { seed, base: "rev-1" }).type(
      "Restore the queue filters and the sort",
    );

    // Somebody else saved the task. The draft was written against rev-1, so it
    // no longer describes what is on screen.
    const reopened = mount("task-editor:task-3", {
      seed: "Restore the queue filters and the grouping",
      base: "rev-2",
    });

    expect(reopened.value).toBe("Restore the queue filters and the grouping");
    expect(stored("task-editor:task-3")).toBeNull();
  });

  test("the seed alone is the version marker when no base is given", () => {
    mount("task-editor:task-3", { seed }).type(`${seed} and the sort`);

    expect(
      mount("task-editor:task-3", { seed: "A different title" }).value,
    ).toBe("A different title");
  });

  test("editing back to the seed is not a draft", () => {
    const editor = mount("task-editor:task-3", { seed });
    editor.type(`${seed} and the sort`);
    editor.type(seed);

    expect(stored("task-editor:task-3")).toBeNull();
  });

  test("opening a seeded editor stores nothing on its own", () => {
    mount("task-editor:task-3", { seed });

    expect(storage.keys).toEqual([]);
  });
});

describe("what is never written", () => {
  test("an empty value is never stored", () => {
    mount("ticket-agent:project-1").type("");

    expect(storage.keys).toEqual([]);
  });

  test("whitespace-only text is never stored", () => {
    mount("ticket-agent:project-1").type("   \n\t ");

    expect(storage.keys).toEqual([]);
  });

  test("emptying a field removes the entry it had", () => {
    const composer = mount("ticket-agent:project-1");
    composer.type("Half a thought");
    expect(stored("ticket-agent:project-1")).not.toBeNull();

    composer.type("");

    expect(stored("ticket-agent:project-1")).toBeNull();
  });
});

describe("pruneDrafts", () => {
  test("drops drafts whose subject is gone and keeps the live ones", () => {
    mount("worker:task-1").type("Still being written");
    mount("worker:task-2").type("For a task that has since been deleted");
    mount("ticket-agent:project-1").type("Live project");

    const dropped = pruneDrafts(["worker:task-1", "ticket-agent:project-1"], {
      storage,
    });

    expect(dropped).toEqual(["worker:task-2"]);
    expect(storedDraftKeys({ storage }).sort()).toEqual([
      "ticket-agent:project-1",
      "worker:task-1",
    ]);
  });

  test("leaves everything outside the draft namespace alone", () => {
    storage.setItem("berdloop.preview.access-mode.v1", '"local"');
    mount("worker:task-1").type("Still being written");

    pruneDrafts([], { storage });

    expect(storage.keys).toEqual(["berdloop.preview.access-mode.v1"]);
  });
});

describe("reading what is stored", () => {
  test("a record written by the hook round-trips", () => {
    saveDraft("worker:task-1", "Half a thought", { storage, base: "rev-1" });

    expect(readDraftRecord("worker:task-1", { storage })).toEqual({
      text: "Half a thought",
      base: "rev-1",
    });
  });

  test("anything unreadable is treated as no draft at all", () => {
    expect(parseDraftRecord(null)).toBeNull();
    expect(parseDraftRecord("not json")).toBeNull();
    expect(parseDraftRecord('"a bare string"')).toBeNull();
    expect(parseDraftRecord('{"text":"   "}')).toBeNull();
    expect(parseDraftRecord('{"text":42}')).toBeNull();
    expect(parseDraftRecord('{"text":"kept"}')).toEqual({ text: "kept" });
  });

  test("no storage at all degrades to no draft rather than throwing", () => {
    // Neither a webview that refuses storage nor this test runner has one.
    expect(readDraft("worker:task-1")).toBe("");
    expect(saveDraft("worker:task-1", "typed")).toBeNull();
    expect(() => removeDraft("worker:task-1")).not.toThrow();
    expect(pruneDrafts([])).toEqual([]);
  });

  test("resolveDraftValue and nextDraftRecord agree on what counts", () => {
    expect(resolveDraftValue(null, { seed: "Seeded" })).toBe("Seeded");
    expect(resolveDraftValue({ text: "typed" }, {})).toBe("typed");
    expect(
      resolveDraftValue({ text: "typed", base: "rev-1" }, { base: "rev-2" }),
    ).toBe("");
    expect(nextDraftRecord("  ", {})).toBeNull();
    expect(nextDraftRecord("typed", {})).toEqual({ text: "typed" });
    expect(nextDraftRecord("typed", { seed: "typed" })).toBeNull();
  });
});
