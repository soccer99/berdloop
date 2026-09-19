/**
 * What a thread draws, message by message: the words, and the file rows.
 *
 * A file the agent touched is one row, and the rows come from the tool calls
 * that wrote the files, not from diff text. That matters because a harness
 * only ever sends prose in an agent message: an Edit or a Write arrives as a
 * tool call, so a worker that quietly edits two files and says nothing about
 * them still owes the thread two rows. A diff an agent pastes into its own
 * prose is read as well, for the case where that is all there is.
 *
 * A file is rowed once per thread, at the first place it was touched, so an
 * agent that edits one file five times leaves one line and not five. The line
 * counts are the repository's running total either way, so a second row would
 * only repeat the first.
 */
import { diffFiles, stripDiffBodies, type TouchedFile } from "./diff";
import type { ThreadMessage } from "./workflow-ui";

export interface ThreadRow extends ThreadMessage {
  /** What was said, with any pasted diff taken out of it. */
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

/** The files one message names: its tool call's, or its pasted diff's. */
function filesOf(message: ThreadMessage): TouchedFile[] {
  if (message.role === "tool")
    return message.path ? [{ path: message.path, status: TOOL_STATUS }] : [];
  return diffFiles(message.text);
}

/**
 * The messages a thread shows, each with the file rows that belong to it.
 *
 * Messages come back in their own order, so the rows read in the order the
 * agent touched the files. One with neither words nor a row of its own is
 * dropped: that is every repeat edit, and every message that was nothing but
 * a diff already named above.
 */
export function threadRows(messages: ThreadMessage[]): ThreadRow[] {
  const seen = new Set<string>();
  const rows: ThreadRow[] = [];
  for (const message of messages) {
    const files = filesOf(message).filter(
      (file) => !seen.has(file.path) && !!seen.add(file.path),
    );
    const text = message.role === "tool" ? "" : stripDiffBodies(message.text);
    if (!text && !files.length) continue;
    rows.push({ ...message, text, files });
  }
  return rows;
}

/**
 * The last thing a thread actually said, for a one-line preview.
 *
 * A `tool` message is a file row and has no words in it, so reading the very
 * last message would blank the preview every time an agent finished on an
 * edit. This reads back to the last message that spoke.
 */
export function lastSaid(messages: ThreadMessage[] = []): string {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.role !== "tool" && message.text) return message.text;
  }
  return "";
}
