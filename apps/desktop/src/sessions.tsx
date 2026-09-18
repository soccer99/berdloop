import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Select, Textarea, TextInput } from "@mantine/core";
import {
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from "@tabler/icons-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A conversation the user's own CLI wrote to disk. We only ever read these. */
interface SessionSummary {
  id: string;
  harness: "Claude Code" | "Codex";
  cwd: string;
  title: string;
  modifiedMs: number;
  path: string;
}

interface AgentChunk {
  runId: string;
  sessionId: string | null;
  kind: "text" | "thinking" | "tool" | "done" | "error";
  text: string;
}

interface AgentEnd {
  runId: string;
  sessionId: string | null;
  ok: boolean;
  detail: string;
}

/** The command a user types in a plain terminal to pick a session back up. */
function resumeCommand(session: SessionSummary): string {
  return session.harness === "Codex"
    ? `codex resume ${session.id}`
    : `claude --resume ${session.id}`;
}

function when(ms: number): string {
  if (!ms) return "unknown";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  const [harness, setHarness] = useState<"Claude Code" | "Codex">(
    "Claude Code",
  );
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const tail = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!isTauri()) {
      setError("Session history needs the desktop app.");
      return;
    }
    invoke<SessionSummary[]>("sessions_list", { limit: 100 })
      .then((found) => {
        setSessions(found);
        setError("");
      })
      .catch((cause) => setError(String(cause)));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [output]);

  // One listener pair for the lifetime of the view. Chunks carry a run id so a
  // stale run from an earlier start can never write into the current output.
  useEffect(() => {
    if (!isTauri()) return;
    const chunks = listen<AgentChunk>("agent://chunk", ({ payload }) => {
      setRunId((active) => {
        if (payload.runId !== active) return active;
        const label =
          payload.kind === "tool"
            ? `· ${payload.text || "tool"}`
            : payload.kind === "thinking"
              ? "· thinking"
              : payload.text;
        if (label) setOutput((lines) => [...lines, label]);
        return active;
      });
    });
    const ends = listen<AgentEnd>("agent://end", ({ payload }) => {
      setRunId((active) => {
        if (payload.runId !== active) return active;
        setOutput((lines) => [
          ...lines,
          payload.ok ? "— finished —" : `— failed — ${payload.detail}`.trim(),
        ]);
        refresh();
        return null;
      });
    });
    return () => {
      void chunks.then((stop) => stop());
      void ends.then((stop) => stop());
    };
  }, [refresh]);

  function start(resume?: SessionSummary) {
    const target = resume ? resume.cwd : cwd.trim();
    if (!target || !prompt.trim()) {
      setError("A working directory and a prompt are both needed.");
      return;
    }
    setOutput([]);
    setError("");
    invoke<{ runId: string; sessionId: string | null }>("agent_start", {
      harness: resume ? resume.harness : harness,
      cwd: target,
      prompt: prompt.trim(),
      resume: resume ? resume.id : null,
    })
      .then((run) => setRunId(run.runId))
      .catch((cause) => setError(String(cause)));
  }

  function stop() {
    if (runId) void invoke("agent_stop", { runId });
    setRunId(null);
  }

  return (
    <main className="tools-view">
      <div className="page-heading">
        <div>
          <p className="app-eyebrow">BRING YOUR OWN HARNESS</p>
          <h1>Agent sessions.</h1>
          <p>
            Every conversation from your own Claude Code and Codex, whichever
            terminal started it. Work started here stays resumable outside here.
          </p>
        </div>
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} />}
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>

      {error && <p className="assignment-note">{error}</p>}

      <section className="surface">
        <h2>Run an agent</h2>
        <Select
          label="Harness"
          data={["Claude Code", "Codex"]}
          value={harness}
          allowDeselect={false}
          onChange={(value) => value && setHarness(value as typeof harness)}
        />
        <TextInput
          mt="md"
          label="Working directory"
          description="A git worktree. Codex needs one."
          placeholder="/Users/you/code/project"
          value={cwd}
          onChange={(event) => setCwd(event.currentTarget.value)}
        />
        <Textarea
          mt="md"
          label="Prompt"
          autosize
          minRows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
        <Button
          mt="md"
          leftSection={
            runId ? <IconPlayerStop size={16} /> : <IconPlayerPlay size={16} />
          }
          color={runId ? "red" : undefined}
          onClick={() => (runId ? stop() : start())}
        >
          {runId ? "Stop" : "Start"}
        </Button>

        {output.length > 0 && (
          <pre className="agent-output">
            {output.join("\n")}
            <div ref={tail} />
          </pre>
        )}
      </section>

      <section className="surface">
        <h2>History</h2>
        {!sessions.length && <p>No sessions found yet.</p>}
        {sessions.map((session) => (
          <div
            key={session.path}
            className={
              selected?.path === session.path ? "session selected" : "session"
            }
            onClick={() => setSelected(session)}
          >
            <Badge variant="light">{session.harness}</Badge>
            <strong>{session.title}</strong>
            <small>
              {session.cwd || "unknown directory"} · {when(session.modifiedMs)}
            </small>
            {selected?.path === session.path && (
              <div className="session-actions">
                <code>{resumeCommand(session)}</code>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() =>
                    void navigator.clipboard.writeText(resumeCommand(session))
                  }
                >
                  Copy
                </Button>
                <Button
                  size="xs"
                  disabled={!!runId || !session.cwd}
                  onClick={() => start(session)}
                >
                  Continue here
                </Button>
              </div>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
