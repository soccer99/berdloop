/** Summarising a changed file down to the one line the chat thread shows. */
import type { ChangedFile } from "./changes-panel";
import { parseDiff } from "./diff";

export type Verb = "added" | "edited" | "deleted" | "renamed";

/** How wide the path may be before it is shortened, in characters. */
export const PATH_WIDTH = 48;

/** The leading mark that says the start of the path was cut away. */
const ELLIPSIS = "…";

const verbs: Record<ChangedFile["status"], Verb> = {
  A: "added",
  M: "edited",
  D: "deleted",
  R: "renamed",
};

export interface DiffCounts {
  added: number;
  removed: number;
}

export interface FileSummary {
  verb: Verb;
  /** The path as shown, shortened from the left when it is too long. */
  display: string;
  /** The whole path, for the title attribute and for opening the file. */
  path: string;
  added: number;
  removed: number;
}

/**
 * Added and removed line counts for one file's unified diff.
 *
 * Counted from `parseDiff`, the same reading the Changes tab renders, so the
 * row's `+n -n` and the red and green lines in the tab can never disagree.
 * Reading only inside the hunks is what keeps the count right for a removed
 * line whose own text starts with `--`, or an added one starting with `++`:
 * the file headers sit in the preamble, which `parseDiff` drops.
 */
export function countDiffLines(diff: string): DiffCounts {
  let added = 0;
  let removed = 0;
  for (const hunk of parseDiff(diff)) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
  }
  return { added, removed };
}

/** The word for a git status: A, M, D or R. */
export function verbFor(status: ChangedFile["status"]): Verb {
  return verbs[status];
}

/**
 * Shorten a path from the left, keeping whole trailing segments.
 *
 * The filename is what the eye reads, so it is never cut, even when it alone
 * is wider than `width`.
 */
export function truncatePath(path: string, width = PATH_WIDTH): string {
  if (path.length <= width) return path;
  const parts = path.split("/");
  let kept = parts.pop() ?? path;
  while (parts.length) {
    const wider = `${parts.at(-1)}/${kept}`;
    if (wider.length + ELLIPSIS.length > width) break;
    kept = wider;
    parts.pop();
  }
  return `${ELLIPSIS}${kept}`;
}

/** Everything the chat's one-line row needs about a changed file. */
export function summariseFile(
  file: ChangedFile,
  width = PATH_WIDTH,
): FileSummary {
  const { added, removed } = countDiffLines(file.diff);
  return {
    verb: verbFor(file.status),
    display: truncatePath(file.path, width),
    path: file.path,
    added,
    removed,
  };
}
