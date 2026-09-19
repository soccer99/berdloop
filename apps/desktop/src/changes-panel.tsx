import { Fragment, useState } from "react";
import { Button, Checkbox, Loader, SegmentedControl } from "@mantine/core";
import { isTauri } from "@tauri-apps/api/core";
import { parseDiff, quoteLine, type DiffLine } from "./diff";
import type { ChangesBase, TaskChanges } from "./use-task-changes";

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R";
  fingerprint: string;
  /** Unified diff for this one file. */
  diff: string;
}
export interface Changes {
  base: string;
  baseLabel: string;
  files: ChangedFile[];
}

const bases = [
  { value: "ticket", label: "Ticket branch" },
  { value: "commit", label: "Last commit" },
  { value: "turn", label: "Last turn" },
];

/** Seen marks are per task and per file, and lapse when the file changes. */
function readSeen(taskId: string): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(`berdloop.seen.${taskId}`) ?? "{}",
    );
    return stored && typeof stored === "object"
      ? (stored as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}
function writeSeen(taskId: string, seen: Record<string, string>) {
  try {
    localStorage.setItem(`berdloop.seen.${taskId}`, JSON.stringify(seen));
  } catch {
    // A blocked or full store only costs the marks.
  }
}

/**
 * The Changes tab's body. The fetching lives in the worker detail page above
 * it (see `useTaskChanges`), so the thread reads the same value and a shut tab
 * never polls.
 */
export function ChangesPanel({
  taskId,
  changes,
  onQuote,
}: {
  taskId: string;
  changes: TaskChanges;
  onQuote: (text: string) => void;
}) {
  const { base, setBase, data, error, loading, refresh } = changes;
  const [picked, setPicked] = useState("");
  const [seen, setSeen] = useState(() => readSeen(taskId));

  if (!isTauri()) return null;

  function mark(file: ChangedFile, checked: boolean) {
    setSeen((current) => {
      const next = { ...current };
      if (checked) next[file.path] = file.fingerprint;
      else delete next[file.path];
      writeSeen(taskId, next);
      return next;
    });
  }
  function pick(file: ChangedFile, key: string, line?: DiffLine) {
    setPicked(key);
    onQuote(quoteLine(file.path, line));
  }

  return (
    <section className="wf-changes" aria-label="Changes">
      <div className="wf-changes-heading">
        <h3>Changes</h3>
        <SegmentedControl
          size="xs"
          data={bases}
          value={base}
          onChange={(value) => setBase(value as ChangesBase)}
        />
        <Button variant="subtle" size="xs" onClick={refresh}>
          Refresh
        </Button>
        {loading && <Loader size="xs" />}
        {data && <small>{data.baseLabel}</small>}
      </div>
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      {!error && !loading && data?.files.length === 0 && (
        <small>No changes against this base yet.</small>
      )}
      {data?.files.map((file) => {
        const read = seen[file.path] === file.fingerprint;
        return (
          <article className="wf-file" key={file.path}>
            <div className="wf-file-head">
              <button
                className="wf-file-path"
                title="Quote this file in the composer"
                onClick={() => pick(file, file.path)}
              >
                <span
                  className={`wf-file-status wf-file-status-${file.status}`}
                >
                  {file.status}
                </span>
                {file.path}
              </button>
              <Checkbox
                size="xs"
                label="Seen"
                checked={read}
                onChange={(event) => mark(file, event.currentTarget.checked)}
              />
            </div>
            {!read && (
              <table className="wf-diff">
                <tbody>
                  {parseDiff(file.diff).map((hunk, hunkIndex) => (
                    <Fragment key={hunkIndex}>
                      <tr className="diff-hunk">
                        <td colSpan={3}>{hunk.header}</td>
                      </tr>
                      {hunk.lines.map((line, lineIndex) => {
                        const key = `${file.path}:${hunkIndex}:${lineIndex}`;
                        return (
                          <tr
                            key={key}
                            className={`diff-${line.kind}${picked === key ? " diff-picked" : ""}`}
                            title="Quote this line in the composer"
                            onClick={() => pick(file, key, line)}
                          >
                            <td className="diff-no">{line.old ?? ""}</td>
                            <td className="diff-no">{line.new ?? ""}</td>
                            <td className="diff-text">{line.text}</td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        );
      })}
    </section>
  );
}
