/**
 * Drafts: unsent text that a person typed but has not committed yet.
 *
 * Every composer, editor and modal in the desktop app keeps its text in this
 * one place, so navigating away and back never throws typing away. This module
 * is the only code that touches localStorage for drafts; components call
 * `useDraft` and nothing else.
 *
 * ## The hook
 *
 *     const [text, setText, clearDraft] = useDraft(key, options)
 *
 * - `key` names the *subject* being written about, never the component:
 *   `"ticket-agent:<projectId>"`, `"task-editor:<taskId|new>"`,
 *   `"worker:<taskId>"`. The same subject reached from two places shares one
 *   draft; two subjects never share. Every key is stored under the single
 *   `berdloop.draft.` namespace.
 * - `text` is the live value. Bind it straight to the input.
 * - `setText(next)` accepts a string or an updater, like `useState`.
 * - `clearDraft()` drops the stored draft and returns the input to its seed.
 *   Call it after a send succeeds, never before: a draft that survives a
 *   failed send is the whole point.
 *
 * ## Options
 *
 * - `seed` — the committed text an editor opens with (a ticket's title, say).
 *   Composers leave it out. A value equal to the seed is not a draft, so it is
 *   never stored: editing a field back to what it was clears the draft.
 * - `base` — what the draft was taken from, stored next to the text. When the
 *   caller passes a base that differs from the stored one, the underlying
 *   record moved on underneath the draft, so the draft is discarded and the
 *   seed wins. Same base, and the stored draft wins over the seed. Defaults to
 *   `seed`, which is right whenever the committed text is itself the version
 *   marker; pass an explicit base (an `updatedAt`, a revision id) when the seed
 *   changes while the person is still typing.
 * - `prefix` — the localStorage namespace. Only tests should set it.
 *
 * Whitespace-only text is never written, and setting a value back to empty
 * removes the stored entry.
 *
 * `pruneDrafts(liveKeys)` removes stored drafts whose subject is gone.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocalStorage } from "@mantine/hooks";

/** Namespace every draft shares, so drafts are recognisable and prunable. */
export const draftStoragePrefix = "berdloop.draft.";

/** What is kept in localStorage for one subject. */
export interface DraftRecord {
  /** The unsent text. Never empty or whitespace only. */
  text: string;
  /** The value the draft was taken from, when the caller seeded the editor. */
  base?: string;
}

export interface DraftOptions {
  /** Committed text the editor opens with. Composers leave this out. */
  seed?: string;
  /** Version marker of the record the seed came from. Defaults to `seed`. */
  base?: string;
  /** localStorage namespace. Only tests should set it. */
  prefix?: string;
  /** Storage to read and write. Defaults to the window's localStorage. */
  storage?: DraftStorage;
}

/** The part of the Storage interface drafts need. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export type UseDraftResult = [
  value: string,
  setValue: (next: string | ((current: string) => string)) => void,
  clearDraft: () => void,
];

function resolveStorage(options: DraftOptions): DraftStorage | null {
  if (options.storage) {
    return options.storage;
  }
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A webview can refuse storage entirely. Drafts are a convenience, so we
    // carry on without them rather than taking the editor down with us.
    return null;
  }
}

/** The localStorage key a subject is stored under. */
export function draftStorageKey(key: string, options: DraftOptions = {}) {
  return `${options.prefix ?? draftStoragePrefix}${key}`;
}

/** The subject a localStorage key belongs to, or null when it is not a draft. */
export function draftSubject(storageKey: string, options: DraftOptions = {}) {
  const prefix = options.prefix ?? draftStoragePrefix;
  return storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : null;
}

/** What the draft was taken from. The seed doubles as the version marker. */
function baseOf(options: DraftOptions) {
  return options.base ?? options.seed;
}

function isBlank(value: string) {
  return value.trim() === "";
}

/** Reads one record, tolerating anything an older or broken write left behind. */
export function parseDraftRecord(raw: string | null): DraftRecord | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as { text?: unknown; base?: unknown };
  if (typeof record.text !== "string" || isBlank(record.text)) {
    return null;
  }
  return typeof record.base === "string"
    ? { text: record.text, base: record.base }
    : { text: record.text };
}

export function readDraftRecord(key: string, options: DraftOptions = {}) {
  const storage = resolveStorage(options);
  if (!storage) {
    return null;
  }
  return parseDraftRecord(storage.getItem(draftStorageKey(key, options)));
}

/** The text an editor should show: the stored draft unless it went stale. */
export function resolveDraftValue(
  record: DraftRecord | null,
  options: DraftOptions = {},
) {
  const seed = options.seed ?? "";
  if (!record || record.base !== baseOf(options)) {
    return seed;
  }
  return record.text;
}

/** What should be stored for a value, or null when nothing should be. */
export function nextDraftRecord(
  value: string,
  options: DraftOptions = {},
): DraftRecord | null {
  if (isBlank(value) || value === (options.seed ?? "")) {
    return null;
  }
  const base = baseOf(options);
  return base === undefined ? { text: value } : { text: value, base };
}

/** The text to show when an editor opens on this subject. */
export function readDraft(key: string, options: DraftOptions = {}) {
  return resolveDraftValue(readDraftRecord(key, options), options);
}

/** Stores a value, or removes the entry when the value is not a draft. */
export function saveDraft(
  key: string,
  value: string,
  options: DraftOptions = {},
) {
  const storage = resolveStorage(options);
  if (!storage) {
    return null;
  }
  const record = nextDraftRecord(value, options);
  const storageKey = draftStorageKey(key, options);
  if (!record) {
    storage.removeItem(storageKey);
    return null;
  }
  storage.setItem(storageKey, JSON.stringify(record));
  return record;
}

/** Forgets a subject's draft. */
export function removeDraft(key: string, options: DraftOptions = {}) {
  resolveStorage(options)?.removeItem(draftStorageKey(key, options));
}

/** Every subject that currently has a stored draft. */
export function storedDraftKeys(options: DraftOptions = {}) {
  const storage = resolveStorage(options);
  if (!storage) {
    return [];
  }
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    const subject = storageKey && draftSubject(storageKey, options);
    if (subject) {
      keys.push(subject);
    }
  }
  return keys;
}

/**
 * Removes drafts whose subject is gone: a deleted ticket, a finished task.
 * Returns the subjects it dropped. Pass every key that is still live, in the
 * same form the callers use.
 */
export function pruneDrafts(
  liveKeys: Iterable<string>,
  options: DraftOptions = {},
) {
  const live = new Set(liveKeys);
  const dropped = storedDraftKeys(options).filter((key) => !live.has(key));
  for (const key of dropped) {
    removeDraft(key, options);
  }
  return dropped;
}

interface DraftState {
  storageKey: string;
  base: string | undefined;
  value: string;
}

/**
 * Keeps one subject's unsent text, surviving unmount, remount and navigation.
 * See the notes at the top of this file for the key, the options and when to
 * call `clearDraft`.
 */
export function useDraft(
  key: string,
  options: DraftOptions = {},
): UseDraftResult {
  const { seed, base, prefix, storage } = options;
  const settings: DraftOptions = { seed, base, prefix, storage };
  const storageKey = draftStorageKey(key, settings);
  const recordBase = baseOf(settings);

  // localStorage is written through Mantine's hook, the pattern the rest of
  // the app already uses. Its value is not read back: the live text belongs to
  // the state below, so that clearing a seeded field does not snap the seed
  // back into the input. `sync` is off for the same reason.
  const [, setRecord, removeRecord] = useLocalStorage<DraftRecord>({
    key: storageKey,
    getInitialValueInEffect: false,
    sync: false,
  });

  const [state, setState] = useState<DraftState>(() => ({
    storageKey,
    base: recordBase,
    value: readDraft(key, settings),
  }));

  // A new subject, or a record that moved on underneath the draft, re-reads
  // during render so the input never shows the previous subject's text.
  if (state.storageKey !== storageKey || state.base !== recordBase) {
    setState({
      storageKey,
      base: recordBase,
      value: readDraft(key, settings),
    });
  }

  useEffect(() => {
    if (state.storageKey !== storageKey) {
      return;
    }
    const record = nextDraftRecord(state.value, { seed, base });
    if (record) {
      setRecord(record);
    } else {
      removeRecord();
    }
  }, [state, storageKey, seed, base, setRecord, removeRecord]);

  const setValue = useCallback(
    (next: string | ((current: string) => string)) => {
      setState((current) => ({
        ...current,
        value: typeof next === "function" ? next(current.value) : next,
      }));
    },
    [],
  );

  const clearDraft = useCallback(() => {
    // Removed straight away, not in the effect: a composer usually unmounts
    // the moment its send succeeds, and an effect would never run.
    removeRecord();
    setState((current) => ({ ...current, value: seed ?? "" }));
  }, [removeRecord, seed]);

  return [state.value, setValue, clearDraft];
}
