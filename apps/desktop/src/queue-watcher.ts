import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { watch } from "@tauri-apps/plugin-fs";
import { useBerdloop, type Queues } from "@berdloop/state";

/**
 * The connector that keeps the queues in the store true to the disk.
 *
 * The lines are files, and the agents that reorder them are separate
 * processes, so the window learns about a change the same way anything else
 * would: by watching the files. Every change re-reads the whole snapshot
 * rather than applying a difference, because a line is short and a partial
 * update that drifts is worse than a read that repeats itself.
 *
 * The web build has no file system. It will keep the same store filled from
 * its own connector.
 */

/** How long to let a burst of writes settle before reading. */
const SETTLE_MS = 120;

function apply(snapshot: Queues) {
  const store = useBerdloop.getState();
  store.setQueues("ticket", snapshot.ticket);
  store.setQueues("agentTask", snapshot.agentTask);
  store.setQueues("merge", snapshot.merge);
  store.setQueues("worker", snapshot.worker);
}

/** Read every line of one project. */
export async function readQueues(projectId: string): Promise<void> {
  const snapshot = await invoke<Queues>("queues_snapshot", { projectId });
  apply(snapshot);
}

/** Replace one line, the same write an agent makes through its command. */
export async function writeQueue(
  projectId: string,
  kind: keyof Queues,
  key: string,
  ids: string[],
): Promise<void> {
  if (kind === "merge") {
    throw new Error("The merge queue is held by the workers, not the window.");
  }
  await invoke("queues_set", { projectId, kind, key, ids });
  await readQueues(projectId);
}

/**
 * Follow one project's queue files for as long as the component lives.
 *
 * Nothing happens without a project, and nothing happens in the browser
 * preview, where there are no files to read.
 */
export function useQueueWatcher(projectId: string) {
  useEffect(() => {
    if (!projectId || !isTauri()) return;
    let stop: (() => void) | undefined;
    let active = true;

    const store = useBerdloop.getState();
    store.loading("queues");
    void (async () => {
      try {
        const paths = await invoke<string[]>("queues_watch_paths", {
          projectId,
        });
        await readQueues(projectId);
        // `watch` settles a burst of writes for us. An agent rewriting a
        // line touches two files, and both arrive as one change.
        const unwatch = await watch(
          paths,
          () => {
            void readQueues(projectId).catch((cause: unknown) =>
              useBerdloop.getState().failed("queues", cause),
            );
          },
          { recursive: true, delayMs: SETTLE_MS },
        );
        // The component may have gone while the watcher was being set up.
        if (active) stop = unwatch;
        else unwatch();
      } catch (cause) {
        if (active) useBerdloop.getState().failed("queues", cause);
      }
    })();

    return () => {
      active = false;
      stop?.();
    };
  }, [projectId]);
}
