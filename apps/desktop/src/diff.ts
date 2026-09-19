/** Unified diff parsing for the Changes panel. One file per diff. */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** Line number in the old file, absent for added lines. */
  old?: number;
  /** Line number in the new file, absent for removed lines. */
  new?: number;
  /** The line without its +/-/space marker. */
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Hunks with old and new line numbers. Text before the first @@ is dropped. */
export function parseDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the diff's own trailing newline
  for (const line of lines) {
    const start = HUNK.exec(line);
    if (start) {
      oldNo = Number(start[1]);
      newNo = Number(start[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    // "\ No newline at end of file" is a note, not content.
    if (!hunk || line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (line.startsWith("+"))
      hunk.lines.push({ kind: "add", new: newNo++, text });
    else if (line.startsWith("-"))
      hunk.lines.push({ kind: "del", old: oldNo++, text });
    else if (line.startsWith(" ") || line === "")
      hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text });
  }
  return hunks;
}

/** The quote pasted into the composer so the worker knows the exact spot. */
export function quoteLine(path: string, line?: DiffLine): string {
  if (!line) return `In \`${path}\`:\n\n`;
  const where =
    line.kind === "del" ? `old line ${line.old}` : `line ${line.new}`;
  return `In \`${path}\` ${where}:\n> ${line.text}\n\n`;
}

/** A fence, with whatever language was written after the backticks. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/;
const DIFF_FENCE = /^(diff|patch|udiff)$/i;
/** `--- a/foo` and `+++ b/foo`. The space is what keeps `---` a rule apart. */
const FILE_HEADER = /^(---|\+\+\+) /;
const GIT_HEADER = /^diff --git /;
const DIFF_META =
  /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;
/** A line inside a hunk: added, removed, context, or the no-newline note. */
const HUNK_BODY = /^[-+\\ ]/;

/**
 * A message's text with every diff in it taken out.
 *
 * Diffs belong in the Changes tab, so a hunk an agent pasted into its own
 * prose never reaches the thread. Only diff content goes: a line is read as
 * diff only when it sits under a `@@` header, a `diff --git` line or a
 * `---`/`+++` pair, or inside a fence that holds a diff. That is what leaves
 * a `- like this` bullet, a `--- ` rule and a `+1` alone.
 *
 * Text with no diff in it is returned exactly as it came.
 */
export function stripDiffBodies(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let dropped = false;
  let at = 0;
  while (at < lines.length) {
    const fence = FENCE.exec(lines[at]!);
    if (fence) {
      const end = fenceEnd(lines, at, fence[1]!);
      const body = lines.slice(at + 1, end);
      // A labelled fence is taken at its word; an unlabelled one is read.
      if (DIFF_FENCE.test(fence[2]!) || (!fence[2] && holdsDiff(body)))
        dropped = true;
      else kept.push(...lines.slice(at, Math.min(end + 1, lines.length)));
      at = end + 1;
      continue;
    }
    const end = diffRunEnd(lines, at);
    if (end > at) {
      dropped = true;
      at = end;
      continue;
    }
    kept.push(lines[at]!);
    at += 1;
  }
  if (!dropped) return text;
  // Removing a diff from the middle of a message leaves the blank lines that
  // sat either side of it. Close the gap, so nothing shows where it was.
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The line holding the closing fence, or the end of the text if it is missing. */
function fenceEnd(lines: string[], open: number, marker: string): number {
  for (let at = open + 1; at < lines.length; at += 1) {
    const end = FENCE_END.exec(lines[at]!);
    if (end && end[1]![0] === marker[0] && end[1]!.length >= marker.length)
      return at;
  }
  return lines.length;
}

/** Whether a fence with no language on it is a diff after all. */
function holdsDiff(body: string[]): boolean {
  if (body.some((line) => HUNK.test(line) || GIT_HEADER.test(line)))
    return true;
  return (
    body.some((line) => line.startsWith("--- ")) &&
    body.some((line) => line.startsWith("+++ "))
  );
}

/**
 * Where the diff starting at `at` ends, or `at` when none starts there.
 *
 * A diff may begin at its `diff --git` line, at a `---`/`+++` pair or at a
 * bare `@@` hunk, because agents quote all three.
 */
function diffRunEnd(lines: string[], at: number): number {
  const first = lines[at]!;
  const starts =
    GIT_HEADER.test(first) ||
    HUNK.test(first) ||
    (first.startsWith("--- ") && (lines[at + 1] ?? "").startsWith("+++ "));
  if (!starts) return at;
  let end = at;
  let inHunk = false;
  while (end < lines.length) {
    const line = lines[end]!;
    if (HUNK.test(line)) {
      inHunk = true;
      end += 1;
      continue;
    }
    if (!inHunk) {
      // The preamble: the headers that come before the first hunk.
      if (
        end === at ||
        GIT_HEADER.test(line) ||
        DIFF_META.test(line) ||
        FILE_HEADER.test(line)
      ) {
        end += 1;
        continue;
      }
      break;
    }
    if (HUNK_BODY.test(line)) {
      end += 1;
      continue;
    }
    // A hunk whose trailing spaces were stripped has empty context lines. One
    // only stays part of the diff when diff follows it, and never when that is
    // a `-` line, which is far likelier to be prose picking up as a bullet.
    const next = lines[end + 1];
    if (
      line === "" &&
      next !== undefined &&
      (HUNK.test(next) || GIT_HEADER.test(next) || /^[+\\ ]/.test(next))
    ) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}
