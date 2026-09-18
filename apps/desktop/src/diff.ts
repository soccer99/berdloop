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
