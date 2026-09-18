/**
 * `useDraft` as a component actually uses it: rendered, unmounted, remounted.
 *
 * The sibling `drafts.test.ts` covers the pure functions the hook is built
 * from. Those can be checked against a plain object, but they leave the hook's
 * own code unrun: the render-phase reset when the key or the base moves, the
 * effect that writes, and `clearDraft`, which removes through Mantine's
 * `useLocalStorage` rather than through `saveDraft`. Everything here goes
 * through a real React root against a real `window.localStorage`, so a change
 * that broke any of those three would be caught.
 *
 * The hook writes through Mantine and reads through `readDraft`, so a test
 * cannot hand it a stand-in store: the two halves would end up looking at
 * different places. It gets the window's own storage and its own `prefix`
 * instead, cleared between tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  readDraftRecord,
  useDraft,
  type DraftOptions,
  type UseDraftResult,
} from "./drafts";

// React refuses to flush effects inside `act` without this.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Namespace for this file alone, so a real draft is never read or written. */
const prefix = "berdloop.test-draft.";

type EditorOptions = Omit<DraftOptions, "prefix" | "storage">;

const openEditors: Array<() => void> = [];

/**
 * One mounted editor: an empty component whose only job is to call the hook.
 * `reopen` re-renders it with new props, which is an editor being pointed at
 * another subject or at a record that has since been saved by somebody else.
 */
function mount(key: string, options: EditorOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let live: UseDraftResult | null = null;

  function Editor(props: { subject: string; options: EditorOptions }) {
    live = useDraft(props.subject, { ...props.options, prefix });
    return null;
  }

  let subject = key;
  let settings = options;
  const draw = () => {
    act(() => {
      root.render(<Editor subject={subject} options={settings} />);
    });
  };

  const unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  openEditors.push(unmount);

  draw();

  return {
    get value() {
      return live![0];
    },
    type(next: string | ((current: string) => string)) {
      act(() => {
        live![1](next);
      });
    },
    clear() {
      act(() => {
        live![2]();
      });
    },
    /** A send that succeeds and takes its composer down in the same tick. */
    clearAndUnmount() {
      act(() => {
        live![2]();
        root.unmount();
      });
      container.remove();
    },
    reopen(nextKey: string, nextOptions: EditorOptions = {}) {
      subject = nextKey;
      settings = nextOptions;
      draw();
    },
    unmount,
  };
}

function stored(key: string) {
  return readDraftRecord(key, { prefix });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const close of openEditors.splice(0)) {
    close();
  }
  localStorage.clear();
});

describe("a rendered useDraft", () => {
  test("text typed into a composer comes back after unmount and remount", () => {
    const composer = mount("ticket-agent:project-1");
    composer.type("Ship the login fix once the");

    // The coordinator collapses, the view changes, a ticket is selected: the
    // body unmounts. Mounting again is the whole point of the ticket.
    composer.unmount();

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
    composer.unmount();
    expect(mount("worker:task-7").value).toBe("");
  });

  test("a send that unmounts the composer still forgets the draft", () => {
    const composer = mount("worker:task-7");
    composer.type("Re-run the failing migration");

    // A composer usually goes away the instant its send succeeds, so the
    // removal cannot wait for an effect that will never run.
    composer.clearAndUnmount();

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
    // clearDraft is never reached, which is the point: nothing cleared it.

    composer.unmount();
    expect(mount("worker:task-7").value).toBe("Re-run the failing migration");
  });

  test("two subjects never share a draft", () => {
    const first = mount("ticket-agent:project-1");
    first.type("Notes for the first project");
    const second = mount("ticket-agent:project-2");
    second.type("Notes for the second project");

    expect(first.value).toBe("Notes for the first project");
    expect(second.value).toBe("Notes for the second project");
    expect(mount("task-editor:new").value).toBe("");
  });

  test("changing subject without unmounting swaps the draft over", () => {
    // The composer is keyed by project, so picking another project re-renders
    // it with a new key rather than tearing it down.
    const composer = mount("ticket-agent:project-1");
    composer.type("Notes for the first project");

    composer.reopen("ticket-agent:project-2");
    expect(composer.value).toBe("");

    composer.type("Notes for the second project");
    composer.reopen("ticket-agent:project-1");
    expect(composer.value).toBe("Notes for the first project");
    expect(stored("ticket-agent:project-2")?.text).toBe(
      "Notes for the second project",
    );
  });

  test("a seeded draft is discarded when its record changed underneath", () => {
    const editor = mount("task-editor:task-3", {
      seed: "Restore the queue filters",
      base: "rev-1",
    });
    editor.type("Restore the queue filters and the sort");
    expect(stored("task-editor:task-3")?.base).toBe("rev-1");

    // Somebody else saved the task while this editor was open. The draft was
    // written against rev-1, so it no longer describes what is on screen.
    editor.reopen("task-editor:task-3", {
      seed: "Restore the queue filters and the grouping",
      base: "rev-2",
    });

    expect(editor.value).toBe("Restore the queue filters and the grouping");
    expect(stored("task-editor:task-3")).toBeNull();
  });

  test("a seeded draft survives while its record is unchanged", () => {
    const options = { seed: "Restore the queue filters", base: "rev-1" };
    const editor = mount("task-editor:task-3", options);
    editor.type("Restore the queue filters and the sort");
    editor.unmount();

    expect(mount("task-editor:task-3", options).value).toBe(
      "Restore the queue filters and the sort",
    );
  });

  test("editing a seeded field back to the seed stores nothing", () => {
    const seed = "Restore the queue filters";
    const editor = mount("task-editor:task-3", { seed });
    editor.type(`${seed} and the sort`);
    expect(stored("task-editor:task-3")).not.toBeNull();

    editor.type(seed);

    expect(stored("task-editor:task-3")).toBeNull();
  });

  test("an updater sees the live text, and emptying removes the entry", () => {
    const composer = mount("ticket-agent:project-1");
    composer.type("Half");
    composer.type((current) => `${current} a thought`);
    expect(composer.value).toBe("Half a thought");
    expect(stored("ticket-agent:project-1")?.text).toBe("Half a thought");

    composer.type("");

    expect(stored("ticket-agent:project-1")).toBeNull();
  });
});
