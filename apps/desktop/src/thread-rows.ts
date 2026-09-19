/**
 * What a thread draws, message by message: the words, the tool lines, and the
 * file rows.
 *
 * A file the agent touched is one row, and the rows come from the tool calls
 * that wrote the files, not from diff text. That matters because a harness
 * only ever sends prose in an agent message: an Edit or a Write arrives as a
 * tool call, so a worker that quietly edits two files and says nothing about
 * them still owes the thread two rows. A diff an agent pastes into its own
 * prose is read as well, for the case where that is all there is.
 *
 * A tool call that wrote a file is drawn as that file's row and not also as a
 * tool line, because the row already says the verb, the path and the counts.
 * Every other tool call keeps its line.
 *
 * A file is rowed once per thread, at the first place it was touched, so an
 * agent that edits one file five times leaves one line and not five. The line
 * counts are the repository's running total either way, so a second row would
 * only repeat the first, and a repeat edit is dropped from the thread rather
 * than falling back to a tool line nobody needs.
 */
import {
  diffFiles,
  stripDiffBodies,
  stripToolBodies,
  type TouchedFile,
} from "./diff";
import type { ThreadMessage } from "./workflow-ui";

export interface ThreadRow extends ThreadMessage {
  /** What was said, or a tool's line. Empty on a message that is only rows. */
  text: string;
  /** The files this message is the first to name, one row each. */
  files: TouchedFile[];
}

/**
 * The status a tool call implies.
 *
 * A tool call says which file was written, never what git will make of it, so
 * this is only the fallback for a file the changes command does not report.
 * Where it does, the row takes the repository's own status instead.
 */
const TOOL_STATUS: TouchedFile["status"] = "M";

/** One message's words and the files it names, before deduplication. */
function draw(message: ThreadMessage): { text: string; files: TouchedFile[] } {
  if (message.role === "tool")
    return message.path
      ? { text: "", files: [{ path: message.path, status: TOOL_STATUS }] }
      : { text: stripToolBodies(message.text), files: [] };
  return {
    text: stripDiffBodies(message.text),
    files: diffFiles(message.text),
  };
}

/**
 * The messages a thread shows, each with the file rows that belong to it.
 *
 * Messages come back in their own order, so the rows read in the order the
 * agent touched the files. One left with neither words nor a row of its own
 * is dropped: that is every repeat edit, and every message that was nothing
 * but a diff already named above.
 */
export function threadRows(messages: ThreadMessage[]): ThreadRow[] {
  const seen = new Set<string>();
  const rows: ThreadRow[] = [];
  for (const message of messages) {
    const drawn = draw(message);
    const files = drawn.files.filter(
      (file) => !seen.has(file.path) && !!seen.add(file.path),
    );
    if (!drawn.text && !files.length) continue;
    rows.push({ ...message, text: drawn.text, files });
  }
  return rows;
}
