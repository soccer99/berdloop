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
 * A message split into the prose it keeps and the diffs taken out of it.
 *
 * Only diff content is taken: a line is read as diff only when it sits under
 * a `@@` header, a `diff --git` line or a `---`/`+++` pair, or inside a fence
 * that holds a diff. That is what leaves a `- like this` bullet, a `--- ` rule
 * and a `+1` alone.
 *
 * The thread's text and its file rows are both read from here, so the rows
 * name exactly the files whose hunks went, and never one whose did not.
 */
function scanDiffs(text: string): { kept: string[]; diffs: string[][] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const diffs: string[][] = [];
  let at = 0;
  while (at < lines.length) {
    const fence = FENCE.exec(lines[at]!);
    if (fence) {
      const end = fenceEnd(lines, at, fence[1]!);
      const body = lines.slice(at + 1, end);
      // A labelled fence is taken at its word; an unlabelled one is read.
      if (DIFF_FENCE.test(fence[2]!) || (!fence[2] && holdsDiff(body)))
        diffs.push(body);
      else kept.push(...lines.slice(at, Math.min(end + 1, lines.length)));
      at = end + 1;
      continue;
    }
    const end = diffRunEnd(lines, at);
    if (end > at) {
      diffs.push(lines.slice(at, end));
      at = end;
      continue;
    }
    kept.push(lines[at]!);
    at += 1;
  }
  return { kept, diffs };
}

/**
 * A message's text with every diff in it taken out.
 *
 * Diffs belong in the Changes tab, so a hunk an agent pasted into its own
 * prose never reaches the thread. What was taken out is named instead by
 * `diffFiles`, one row per file.
 *
 * Text with no diff in it is returned exactly as it came.
 */
export function stripDiffBodies(text: string): string {
  const { kept, diffs } = scanDiffs(text);
  if (!diffs.length) return text;
  // Removing a diff from the middle of a message leaves the blank lines that
  // sat either side of it. Close the gap, so nothing shows where it was.
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A file a message's own diff said it had changed. */
export interface TouchedFile {
  path: string;
  /** The git status the diff's own headers spell out: A, M, D or R. */
  status: "A" | "M" | "D" | "R";
}

/** `diff --git a/old b/new`. Paths holding a space are beyond telling apart. */
const GIT_PAIR = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_HEADER = /^--- (.+)$/;
const NEW_HEADER = /^\+\+\+ (.+)$/;
const RENAME_TO = "rename to ";
const NOTHING = "/dev/null";

/**
 * The files a message's diffs named, in the order they were written.
 *
 * These are the rows the thread shows where the hunks used to be. The status
 * is only what the agent's own diff claimed; the line counts come from the
 * Changes the repository reports, never from here.
 *
 * A file quoted twice in one message is one row, kept at its first place.
 */
export function diffFiles(text: string): TouchedFile[] {
  const seen = new Set<string>();
  return scanDiffs(text)
    .diffs.flatMap(filesInDiff)
    .filter((file) => !seen.has(file.path) && !!seen.add(file.path));
}

/** The path a `---` or `+++` header names, without its prefix or timestamp. */
function headerPath(raw: string): string {
  const path = raw.split("\t")[0]!.trimEnd();
  return path === NOTHING ? path : path.replace(/^[ab]\//, "");
}

function filesInDiff(lines: string[]): TouchedFile[] {
  const files: TouchedFile[] = [];
  let open: TouchedFile | undefined;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    const git = GIT_PAIR.exec(line);
    if (git) {
      open = { path: git[2]!, status: git[1] === git[2] ? "M" : "R" };
      files.push(open);
      continue;
    }
    if (open) {
      if (line.startsWith("new file mode")) open.status = "A";
      else if (line.startsWith("deleted file mode")) open.status = "D";
      else if (line.startsWith(RENAME_TO)) {
        open.path = line.slice(RENAME_TO.length);
        open.status = "R";
      }
    }
    // Only a `---` with a `+++` under it counts, so a removed line that reads
    // `--- something` inside a hunk is never mistaken for a file header.
    const old = OLD_HEADER.exec(line);
    const next = old && NEW_HEADER.exec(lines[at + 1] ?? "");
    if (!old || !next) continue;
    at += 1;
    const from = headerPath(old[1]!);
    const to = headerPath(next[1]!);
    if (open) {
      // `diff --git` already named both sides; the pair only says which way.
      if (from === NOTHING) open.status = "A";
      else if (to === NOTHING) open.status = "D";
      open = undefined;
      continue;
    }
    if (to !== NOTHING)
      files.push({ path: to, status: from === NOTHING ? "A" : "M" });
    else if (from !== NOTHING) files.push({ path: from, status: "D" });
  }
  return files;
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

/**
 * The tool inputs that are the change itself, rather than words about it.
 *
 * An `Edit` call carries the file's text before and after in `old_string` and
 * `new_string`; a `Write` call carries the whole new file in `content`. Those
 * are the before and after of a change under another name, so they belong in
 * the Changes tab exactly as a `@@` hunk does.
 */
const CHANGE_KEYS = new Set([
  "old_string",
  "new_string",
  "old_str",
  "new_str",
  "content",
  "new_content",
  "new_source",
]);

/** What stands in a change body's place, so the line still says it had one. */
const ELSEWHERE = "… read it in the Changes tab";

/** A field of a pretty-printed JSON object, one per line: key, then value. */
const JSON_FIELD = /^(\s*)"([^"]+)"(\s*:\s*)(.*)$/;
/** A complete JSON string value, and whether a comma closes the field. */
const JSON_STRING = /^"((?:[^"\\]|\\.)*)"(,?)$/;

/**
 * A tool line with the change bodies taken out of its input.
 *
 * The native side gives a tool message as its head line — `Edit · some/path`
 * — and the whole call input pretty-printed under it, which the thread opens
 * on a click. That input is not prose: for an `Edit` it is the file's text
 * before and after, and for a `Bash` it may be a patch inside the command.
 * Either way it is a diff arriving by a second door, so it is taken out here
 * on the way to the thread, the same as one pasted into an agent's own words.
 *
 * The head line is left alone: it names the tool and the file, which is the
 * one compact line this ticket wants. Every other field of the input — a
 * description, a pattern, a path — is left exactly as it came.
 */
export function stripToolBodies(text: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return text;
  const head = text.slice(0, newline);
  const detail = text
    .slice(newline + 1)
    .split("\n")
    .map(stripField)
    .join("\n");
  // A harness that sends a raw command rather than JSON has no fields to
  // read, so the body is swept for a diff the same way an agent's prose is.
  return `${head}\n${stripDiffBodies(detail)}`;
}

/** One line of a pretty-printed input, with any change body taken out of it. */
function stripField(line: string): string {
  const field = JSON_FIELD.exec(line);
  if (!field) return line;
  const indent = field[1]!;
  const key = field[2]!;
  const colon = field[3]!;
  const value = field[4]!;
  if (!value.startsWith('"')) return line;
  const quoted = JSON_STRING.exec(value);
  // An input clamped for length ends mid-string. A change key is still a
  // change key, so it goes; anything else is left rather than guessed at.
  if (!quoted)
    return CHANGE_KEYS.has(key)
      ? `${indent}"${key}"${colon}${JSON.stringify(ELSEWHERE)}`
      : line;
  const comma = quoted[2]!;
  if (CHANGE_KEYS.has(key))
    return `${indent}"${key}"${colon}${JSON.stringify(ELSEWHERE)}${comma}`;
  // Not a change field, but a command can still carry a patch inside it.
  const written = JSON.parse(`"${quoted[1]!}"`) as string;
  const kept = stripDiffBodies(written);
  if (kept === written) return line;
  return `${indent}"${key}"${colon}${JSON.stringify(kept)}${comma}`;
}
