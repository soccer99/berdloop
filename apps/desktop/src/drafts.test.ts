import { beforeEach, describe, expect, test } from "bun:test";
import {
  draftOwner,
  draftStorageKey,
  draftStoragePrefix,
  nextDraftRecord,
  packText,
  parseDraftRecord,
  pruneDrafts,
  pruneDraftsForOwners,
  readDraft,
  readDraftRecord,
  removeDraft,
  resolveDraftValue,
  saveDraft,
  storedDraftKeys,
  unpackText,
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
    /** `clearIfUnchanged`: only the text that was actually sent is cleared. */
    clearIfUnchanged(sent: string) {
      if (value !== sent) {
        return false;
      }
      removeDraft(key, settings);
      value = options.seed ?? "";
      return true;
    },
  };
}

function stored(key: string) {
  return storage.getItem(draftStorageKey(key));
}

/** Runs `body` in a world where reaching for localStorage throws, as a webview
 * that has been told to refuse storage does. */
function withStorageRefused(body: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage is disabled");
    },
  });
  try {
    body();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
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

  test("text typed during an in-flight send survives that send", async () => {
    const composer = mount("worker:task-7");
    composer.type("Re-run the failing migration");
    const sent = composer.value;

    // Nothing is disabled while the send is in flight, so the person carries
    // on typing the next instruction before the first one has resolved.
    const send = Promise.resolve();
    composer.type("And then check the logs");
    await send;
    expect(composer.clearIfUnchanged(sent)).toBe(false);

    expect(composer.value).toBe("And then check the logs");
    expect(mount("worker:task-7").value).toBe("And then check the logs");
  });

  test("a send nobody typed over clears the box and the storage", async () => {
    const composer = mount("worker:task-7");
    composer.type("Re-run the failing migration");
    const sent = composer.value;

    await Promise.resolve();
    expect(composer.clearIfUnchanged(sent)).toBe(true);

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

describe("packing a field whose empty value is an edit", () => {
  test("an emptied field is stored, unlike a blank one", () => {
    expect(nextDraftRecord(packText(""), { seed: packText("alice") })).toEqual({
      text: '""',
      base: '"alice"',
    });
    expect(nextDraftRecord("", { seed: "alice" })).toBeNull();
  });

  test("an untouched field is still not a draft", () => {
    expect(
      nextDraftRecord(packText("alice"), { seed: packText("alice") }),
    ).toBeNull();
  });

  test("text round-trips through packing", () => {
    for (const value of ["", "alice", 'a "quoted" name', "two\nlines", "123"]) {
      expect(unpackText(packText(value))).toBe(value);
    }
  });

  test("a draft stored before the field packed is kept as it stands", () => {
    // Nothing packed writes these, so they can only be a draft that was
    // already sitting in storage. Losing one is the bug this module exists
    // to stop.
    expect(unpackText("Half a typed thought")).toBe("Half a typed thought");
    expect(unpackText("[1,2]")).toBe("[1,2]");
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

describe("pruning drafts whose ticket or task is gone", () => {
  test("a deleted subject's draft is dropped and a live one is kept", () => {
    mount("worker:task-live").type("Still being written");
    mount("worker:task-gone").type("For a task that has since been deleted");
    mount("task-editor:task-gone:title").type("Half a title");
    mount("planner:ticket-gone").type("For a deleted ticket");
    mount("ticket-editor:ticket-live:criteria").type("Sharper wording");

    const dropped = pruneDraftsForOwners(["task-live", "ticket-live"], {
      storage,
    });

    expect(dropped.sort()).toEqual([
      "planner:ticket-gone",
      "task-editor:task-gone:title",
      "worker:task-gone",
    ]);
    expect(storedDraftKeys({ storage }).sort()).toEqual([
      "ticket-editor:ticket-live:criteria",
      "worker:task-live",
    ]);
  });

  test("subjects no ticket or task owns are never pruned", () => {
    // Nothing can delete a search box, a session field or a create form, so
    // pruning must not read them as gone the way a deleted task is.
    mount("ticket-search:project-1").type("auth");
    mount("agent-session:prompt").type("Half a prompt");
    mount("new-ticket:project-1:title").type("A ticket not yet made");
    mount("task-editor:new:title").type("A task not yet made");
    mount("ticket-agent:project-1").type("Live project");
    mount("worker:task-gone").type("For a deleted task");

    expect(pruneDraftsForOwners([], { storage })).toEqual(["worker:task-gone"]);
    expect(storedDraftKeys({ storage }).sort()).toEqual([
      "agent-session:prompt",
      "new-ticket:project-1:title",
      "task-editor:new:title",
      "ticket-agent:project-1",
      "ticket-search:project-1",
    ]);
  });

  test("draftOwner names who a subject dies with", () => {
    expect(draftOwner("worker:task-1")).toBe("task-1");
    expect(draftOwner("human-request:task-1:request-9")).toBe("task-1");
    expect(draftOwner("ticket-editor:ticket-1:title")).toBe("ticket-1");
    expect(draftOwner("planner:ticket-1")).toBe("ticket-1");
    expect(draftOwner("task-editor:new:title")).toBeNull();
    expect(draftOwner("ticket-search:project-1")).toBeNull();
    expect(draftOwner("agent-session:prompt")).toBeNull();
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
    // A webview can refuse storage outright. Drafts are a convenience, so
    // losing them must not take the editor down with them.
    withStorageRefused(() => {
      expect(readDraft("worker:task-1")).toBe("");
      expect(saveDraft("worker:task-1", "typed")).toBeNull();
      expect(() => removeDraft("worker:task-1")).not.toThrow();
      expect(pruneDrafts([])).toEqual([]);
    });
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
