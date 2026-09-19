/**
 * The ticket list's search box, rendered as the real `QueueView` renders it.
 *
 * The filter is a draft like any other, so it has to survive leaving the queue
 * view and coming back, and switching project and coming back. The bug this
 * guards against was not in `useDraft` but in the view around it: an effect
 * that called `setSearch("")` on mount and on every project change, which the
 * draft's own write effect then read as "this subject is empty" and deleted.
 * A test of the hook alone cannot see that, so this one mounts the component.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { emptyTaskWorkspace, type Project, type Task } from "@berdloop/core";
import { readDraftRecord } from "./drafts";
import { QueueView } from "./queue";

// React refuses to flush effects inside `act` without this.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Mantine's provider listens for a webfont swap. happy-dom has no font
// registry, and the tiny stand-in is enough for the provider to mount.
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      addEventListener() {},
      removeEventListener() {},
      ready: Promise.resolve(),
    },
  });
}

const projects: Project[] = [
  {
    id: "project-a",
    organizationId: "org-1",
    name: "Desktop",
    description: "",
  },
  {
    id: "project-b",
    organizationId: "org-1",
    name: "Sidecar",
    description: "",
  },
];

const ticket = (id: string, projectId: string, title: string): Task => ({
  id,
  projectId,
  title,
  source: "Local",
  ticket: id.toUpperCase(),
  stage: "Engineer",
  status: "queued",
  criteria: "",
});

const workspace = {
  ...emptyTaskWorkspace(),
  tasks: [
    ticket("login", "project-a", "Restore the login redirect"),
    ticket("export", "project-a", "Export the audit log"),
    ticket("sidecar", "project-b", "Restart the sidecar on crash"),
  ],
};

const openViews: Array<() => void> = [];

/** One mounted queue view, pointed at a project and re-pointable at another. */
function openQueue(projectId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  let target = projectId;
  const draw = () => {
    act(() => {
      root.render(
        <MantineProvider>
          <QueueView
            workspace={workspace}
            projects={projects}
            projectId={target}
            organizationId="org-1"
            onLinkProject={() => {}}
            selectedTicketId=""
            onSelectTicket={() => {}}
            loopTicketId=""
            onLoopTicket={() => {}}
            update={() => {}}
            onNewTicket={() => {}}
            onImportTicket={() => {}}
            onNewProject={() => {}}
            canImport={false}
            ticketSources={[]}
            onConfigureSources={() => {}}
            ready
          />
        </MantineProvider>,
      );
    });
  };

  const close = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  openViews.push(close);

  draw();

  const box = () => {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search tickets"]',
    );
    if (!input) {
      throw new Error("the queue view rendered no search box");
    }
    return input;
  };

  return {
    get filter() {
      return box().value;
    },
    /** The titles the ticket list is showing under the current filter. */
    get titles() {
      return [...container.querySelectorAll(".wf-ticket-open strong")].map(
        (node) => node.textContent?.trim(),
      );
    },
    type(text: string) {
      const input = box();
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      act(() => {
        setValue?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    /** Another project is chosen. The view stays mounted, as it does in App. */
    selectProject(next: string) {
      target = next;
      draw();
    },
    close,
  };
}

function stored(projectId: string) {
  return readDraftRecord(`ticket-search:${projectId}`);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const close of openViews.splice(0)) {
    close();
  }
  localStorage.clear();
});

describe("the ticket search filter", () => {
  test("is still there after the queue view is left and re-entered", () => {
    const queue = openQueue("project-a");
    queue.type("login");
    expect(stored("project-a")?.text).toBe("login");

    // The person opens another view. The queue view unmounts entirely.
    queue.close();

    const reopened = openQueue("project-a");
    expect(reopened.filter).toBe("login");
    // Read back, not read and destroyed: the entry is still in storage.
    expect(stored("project-a")?.text).toBe("login");
  });

  test("still filters the list it comes back to", () => {
    const queue = openQueue("project-a");
    queue.type("login");
    queue.close();

    expect(openQueue("project-a").titles).toEqual([
      "Restore the login redirect",
    ]);
  });

  test("comes back when its project is selected again", () => {
    const queue = openQueue("project-a");
    queue.type("login");

    queue.selectProject("project-b");
    expect(queue.filter).toBe("");

    queue.selectProject("project-a");
    expect(queue.filter).toBe("login");
    expect(stored("project-a")?.text).toBe("login");
  });

  test("is never shown under another project", () => {
    const queue = openQueue("project-a");
    queue.type("login");

    queue.selectProject("project-b");

    expect(queue.filter).toBe("");
    expect(queue.titles).toEqual(["Restart the sidecar on crash"]);
    expect(stored("project-b")).toBeNull();
  });

  test("each project keeps its own", () => {
    const queue = openQueue("project-a");
    queue.type("login");
    queue.selectProject("project-b");
    queue.type("sidecar");

    queue.selectProject("project-a");
    expect(queue.filter).toBe("login");
    queue.selectProject("project-b");
    expect(queue.filter).toBe("sidecar");
  });
});
