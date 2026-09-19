import { beforeEach, describe, expect, test } from "bun:test";
import { readDraft, removeDraft, saveDraft, type DraftStorage } from "./drafts";
import {
  appliedQuote,
  forgetQuote,
  type Quote,
  quotePrefill,
  rememberQuote,
} from "./quote-prefill";

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

const taskA = "worker:task-a";
const taskB = "worker:task-b";
const hunkA = "> src/queue.tsx:212\n> const applied = useRef(0);\n\n";
const hunkB = "> src/drafts.ts:88\n> function isBlank(value: string) {\n\n";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  // The memory of what each draft carries outlives a mount on purpose, so it
  // also outlives a test. Every test starts with both composers empty.
  forgetQuote(taskA);
  forgetQuote(taskB);
});

/**
 * The queue view. It holds the quote a hunk produced, and the composer tells
 * it once the quote has landed. `clears: false` is the view before this fix,
 * where the quote outlived the composer that had already taken it in.
 */
function queueView({ clears = true }: { clears?: boolean } = {}) {
  let quote: Quote | undefined;
  let quotes = 0;
  return {
    get quote() {
      return quote;
    },
    /** Quote on a hunk in ChangesPanel. Ids rise for the life of the view. */
    quoteHunk(text: string) {
      quotes += 1;
      quote = { id: quotes, text };
    },
    applied() {
      if (clears) {
        quote = undefined;
      }
    },
  };
}

type QueueView = ReturnType<typeof queueView>;

/**
 * One mounted composer, driven exactly as the component drives these two
 * modules: it reads its draft when it mounts, runs the quote effect on mount
 * and whenever the quote prop changes, writes on every keystroke, and on a
 * successful send forgets both the draft and the quote it carried.
 */
function mountComposer(view: QueueView, draftKey: string) {
  const settings = { storage };
  let value = readDraft(draftKey, settings);
  const effect = () => {
    const quote = view.quote;
    if (!quote) return;
    const prefill = quotePrefill(value, quote, appliedQuote(draftKey));
    if (prefill) {
      rememberQuote(draftKey, prefill.applied);
      if (prefill.text !== value) {
        value = prefill.text;
        saveDraft(draftKey, value, settings);
      }
    }
    view.applied();
  };
  effect();
  return {
    get value() {
      return value;
    },
    type(next: string) {
      value = next;
      saveDraft(draftKey, next, settings);
    },
    /** The quote prop changed, so the effect runs again. */
    quoted: effect,
    send() {
      removeDraft(draftKey, settings);
      forgetQuote(draftKey);
      value = "";
    },
  };
}

describe("a quote arriving at a composer", () => {
  test("goes in front of what the person typed", () => {
    const view = queueView();
    const composer = mountComposer(view, taskA);
    composer.type("This ref resets on every mount");

    view.quoteHunk(hunkA);
    composer.quoted();

    expect(composer.value).toBe(`${hunkA}This ref resets on every mount`);
    expect(readDraft(taskA, { storage })).toBe(composer.value);
  });

  test("replaces the previous quote rather than stacking on it", () => {
    const view = queueView();
    const composer = mountComposer(view, taskA);
    composer.type("Look at this instead");
    view.quoteHunk(hunkA);
    composer.quoted();

    view.quoteHunk(hunkB);
    composer.quoted();

    expect(composer.value).toBe(`${hunkB}Look at this instead`);
  });

  test("goes in front again once the person deleted the last one", () => {
    const view = queueView();
    const composer = mountComposer(view, taskA);
    view.quoteHunk(hunkA);
    composer.quoted();
    composer.type("Never mind that hunk");

    view.quoteHunk(hunkB);
    composer.quoted();

    expect(composer.value).toBe(`${hunkB}Never mind that hunk`);
  });
});

describe("a composer that unmounts and comes back", () => {
  test("the same quote is not applied to the restored draft twice", () => {
    // The view before the fix: the quote is still sitting in its state when
    // the thread panel unmounts and mounts again.
    const view = queueView({ clears: false });
    const composer = mountComposer(view, taskA);
    composer.type("Worth keeping");
    view.quoteHunk(hunkA);
    composer.quoted();
    const applied = composer.value;

    // Deselect the task, select it again: same quote prop, new composer.
    const reopened = mountComposer(view, taskA);

    expect(reopened.value).toBe(applied);
    expect(reopened.value).toBe(`${hunkA}Worth keeping`);
  });

  test("still not twice when nothing remembers the quote any more", () => {
    const view = queueView({ clears: false });
    const composer = mountComposer(view, taskA);
    composer.type("Worth keeping");
    view.quoteHunk(hunkA);
    composer.quoted();
    const applied = composer.value;

    // The app was reloaded, or the memory pruned: only the draft is left.
    forgetQuote(taskA);

    expect(mountComposer(view, taskA).value).toBe(applied);
  });

  test("the quote does not follow the person to the next task", () => {
    const view = queueView();
    const first = mountComposer(view, taskA);
    first.type("Fix this one");
    view.quoteHunk(hunkA);
    first.quoted();

    // Select task B. Its composer mounts with a draft of its own.
    saveDraft(taskB, "Different subject entirely", { storage });
    const second = mountComposer(view, taskB);

    expect(second.value).toBe("Different subject entirely");
    expect(readDraft(taskB, { storage })).toBe("Different subject entirely");
    expect(first.value).toBe(`${hunkA}Fix this one`);
  });

  test("an empty task's composer stays empty", () => {
    const view = queueView();
    const first = mountComposer(view, taskA);
    view.quoteHunk(hunkA);
    first.quoted();

    expect(mountComposer(view, taskB).value).toBe("");
  });
});

describe("after a send", () => {
  test("the draft and the quote it carried are both forgotten", () => {
    const view = queueView();
    const composer = mountComposer(view, taskA);
    composer.type("Ship it");
    view.quoteHunk(hunkA);
    composer.quoted();

    composer.send();

    expect(mountComposer(view, taskA).value).toBe("");
    expect(appliedQuote(taskA)).toBeUndefined();
  });
});

describe("the rule on its own", () => {
  test("an unseen quote goes in front of the draft", () => {
    expect(quotePrefill("note", { id: 1, text: "Q\n" })).toEqual({
      text: "Q\nnote",
      applied: { id: 1, text: "Q\n" },
    });
  });

  test("the quote a draft already carries is left alone", () => {
    expect(
      quotePrefill("Q\nnote", { id: 1, text: "Q\n" }, { id: 1, text: "Q\n" }),
    ).toBeNull();
  });

  test("a draft that already starts with the quote is not changed", () => {
    expect(quotePrefill("Q\nnote", { id: 1, text: "Q\n" })?.text).toBe(
      "Q\nnote",
    );
  });
});
