import { Fragment, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Loader, SegmentedControl } from "@mantine/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseDiff, quoteLine, type DiffLine } from "./diff";

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

type Base = "ticket" | "commit" | "turn";
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

export function ChangesPanel({
  projectId,
  ticket,
  taskId,
  streaming,
  messageCount,
  onCount,
  onQuote,
}: {
  projectId: string;
  /** Ticket key, for example ENG-42. */
  ticket: string;
  taskId: string;
  streaming?: boolean;
  messageCount: number;
  /** Reports how many files the current base turned up, for the tab label. */
  onCount?: (count: number) => void;
  onQuote: (text: string) => void;
}) {
  const [base, setBase] = useState<Base>("ticket");
  const [changes, setChanges] = useState<Changes>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [picked, setPicked] = useState("");
  const [seen, setSeen] = useState(() => readSeen(taskId));
  const was = useRef(false);
  const native = isTauri();

  // Reload once the agent stops writing, not while it writes.
  useEffect(() => {
    if (was.current && !streaming) setNonce((current) => current + 1);
    was.current = !!streaming;
  }, [streaming]);

  useEffect(() => {
    if (!native) return;
    let live = true;
    setLoading(true);
    invoke<Changes>("git_task_changes", { projectId, ticket, taskId, base })
      .then((result) => {
        if (!live) return;
        setChanges(result);
        setError("");
        onCount?.(result.files.length);
      })
      .catch((cause) => {
        if (!live) return;
        setChanges(undefined);
        setError(String(cause));
        onCount?.(0);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [native, projectId, ticket, taskId, base, messageCount, nonce]);

  if (!native) return null;

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
          onChange={(value) => setBase(value as Base)}
        />
        <Button
          variant="subtle"
          size="xs"
          onClick={() => setNonce((current) => current + 1)}
        >
          Refresh
        </Button>
        {loading && <Loader size="xs" />}
        {changes && <small>{changes.baseLabel}</small>}
      </div>
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      {!error && !loading && changes?.files.length === 0 && (
        <small>No changes against this base yet.</small>
      )}
      {changes?.files.map((file) => {
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
