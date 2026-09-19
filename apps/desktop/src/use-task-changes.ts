/**
 * Fetching a task's changes once, above the tabs that read them.
 *
 * The Changes tab and the thread's one-line file rows both need the same
 * Changes, so the fetch lives here rather than inside the panel: one value,
 * and no way for the two to disagree. A shut tab costs nothing, because a tick
 * that arrives while it is shut is only remembered, and paid for on opening.
 */
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Changes } from "./changes-panel";

export type ChangesBase = "ticket" | "commit" | "turn";

/** Everything a render knows that could call for a fetch. */
export interface ChangesTick {
  /** What is being diffed: project, ticket, task and base, as one string. */
  key: string;
  /** Bumped by the Refresh button. */
  refresh: number;
  messageCount: number;
  streaming: boolean;
  /** Whether the Changes tab is open. */
  visible: boolean;
}

export interface ChangesDecision {
  fetch: boolean;
  /** Carried to the next decision: a tick landed while the tab was shut. */
  stale: boolean;
}

/**
 * Whether this render should fetch, given the last one.
 *
 * A new task or base, and the Refresh button, always fetch: the tab label's
 * file count and the thread's line counts are wanted whether the tab is open
 * or not. After that only the open tab follows the agent. While it is shut a
 * tick sets `stale`, and opening spends that mark on a single catch-up fetch.
 */
export function decideFetch(
  before: ChangesTick | undefined,
  after: ChangesTick,
  stale: boolean,
): ChangesDecision {
  if (!before || before.key !== after.key || before.refresh !== after.refresh)
    return { fetch: true, stale: false };
  const ticked =
    before.messageCount !== after.messageCount ||
    (before.streaming && !after.streaming);
  const opened = !before.visible && after.visible;
  if (!ticked && !(opened && stale)) return { fetch: false, stale };
  if (!after.visible) return { fetch: false, stale: true };
  return { fetch: true, stale: false };
}

/** The changes, and the controls the panel draws for them. */
export interface TaskChanges {
  base: ChangesBase;
  setBase: (base: ChangesBase) => void;
  data?: Changes;
  error: string;
  loading: boolean;
  refresh: () => void;
}

export function useTaskChanges({
  projectId,
  /** Ticket key, for example ENG-42. */
  ticket,
  taskId,
  streaming,
  messageCount,
  visible,
  enabled = true,
}: {
  projectId: string;
  ticket: string;
  taskId: string;
  streaming?: boolean;
  messageCount: number;
  visible: boolean;
  enabled?: boolean;
}): TaskChanges {
  // Both are held against the task they were read for, so neither the base nor
  // a result leaks to the next task opened.
  const [chosen, setChosen] = useState<{ taskId: string; base: ChangesBase }>({
    taskId,
    base: "ticket",
  });
  const base = chosen.taskId === taskId ? chosen.base : "ticket";
  const [result, setResult] = useState<{
    key: string;
    data?: Changes;
    error: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const before = useRef<ChangesTick>(undefined);
  const stale = useRef(false);
  const serial = useRef(0);
  const native = isTauri();
  const key = [projectId, ticket, taskId, base].join("\u0000");

  useEffect(() => {
    if (!native || !enabled || !taskId) {
      // A task without a worktree has nothing to diff, so the next render that
      // does have one counts as the first.
      before.current = undefined;
      return;
    }
    const now: ChangesTick = {
      key,
      refresh: refreshes,
      messageCount,
      streaming: !!streaming,
      visible,
    };
    const decision = decideFetch(before.current, now, stale.current);
    before.current = now;
    stale.current = decision.stale;
    if (!decision.fetch) return;
    // The run is retired by a later one rather than by this effect's cleanup:
    // a render that decides not to fetch must not cancel the fetch in flight.
    const mine = ++serial.current;
    setLoading(true);
    invoke<Changes>("git_task_changes", { projectId, ticket, taskId, base })
      .then((data) => {
        if (serial.current === mine) setResult({ key, data, error: "" });
      })
      .catch((cause) => {
        if (serial.current === mine) setResult({ key, error: String(cause) });
      })
      .finally(() => {
        if (serial.current === mine) setLoading(false);
      });
  }, [native, enabled, key, refreshes, messageCount, streaming, visible]);

  const mine = result?.key === key ? result : undefined;
  return {
    base,
    setBase: (next) => setChosen({ taskId, base: next }),
    data: mine?.data,
    error: mine?.error ?? "",
    loading,
    refresh: () => setRefreshes((count) => count + 1),
  };
}
