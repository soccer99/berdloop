/**
 * The file rows that stand where an agent's pasted diff used to be.
 *
 * One file, one line: the verb, the path and the counts, reading `edited
 * apps/desktop/src/queue.tsx  +24 -7`. Several files touched in one message
 * are several rows, in the order the agent wrote them, never one block.
 *
 * The line counts are read from the Changes the repository reports, the same
 * value the Changes tab draws, so a row never repeats a number an agent made
 * up. A file the changes command does not report — untracked, ignored, or put
 * back before the fetch — still gets its row, marked as having no diff and
 * left unclickable rather than leading to an empty tab.
 */
import type { Changes, ChangedFile } from "./changes-panel";
import { summariseFile, truncatePath, verbFor } from "./diff-summary";
import type { TouchedFile } from "./diff";

export function ThreadFiles({
  files,
  changes,
  onOpen,
}: {
  files: TouchedFile[];
  /** The task's changes, absent for a thread that has no worktree to diff. */
  changes?: Changes;
  /** Show this file in the Changes tab. Left out where there is no tab. */
  onOpen?: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="wf-touched">
      {files.map((file) => (
        <ThreadFile
          key={file.path}
          file={file}
          changed={changes?.files.find((item) => item.path === file.path)}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function ThreadFile({
  file,
  changed,
  onOpen,
}: {
  file: TouchedFile;
  changed?: ChangedFile;
  onOpen?: (path: string) => void;
}) {
  // What the repository says wins over what the agent's diff claimed, because
  // the tab this row opens shows the repository's version.
  const summary = changed && summariseFile(changed);
  const body = (
    <>
      <span className="wf-touched-verb">
        {summary ? summary.verb : verbFor(file.status)}
      </span>
      <span className="wf-touched-path" title={file.path}>
        {summary ? summary.display : truncatePath(file.path)}
      </span>
      {summary ? (
        <span className="wf-touched-counts">
          <span className="wf-touched-added">+{summary.added}</span>
          <span className="wf-touched-removed">-{summary.removed}</span>
        </span>
      ) : (
        <span className="wf-touched-none">no diff to show</span>
      )}
    </>
  );
  return (
    <li className="wf-touched-row">
      {summary && onOpen ? (
        <button
          type="button"
          className="wf-touched-line"
          aria-label={`Show ${file.path} in Changes`}
          onClick={() => onOpen(file.path)}
        >
          {body}
        </button>
      ) : (
        <span className="wf-touched-line">{body}</span>
      )}
    </li>
  );
}
