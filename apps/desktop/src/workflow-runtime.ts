import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBerdloop } from "@berdloop/state";
import {
  planConversation,
  type AgentRole,
  type HarnessId,
  type LaunchPlan,
  type Steering,
} from "@berdloop/agent";
import type {
  AgentThreadView,
  ThreadMessage,
  WorkflowAction,
  WorkflowRuntime,
} from "./workflow-ui";

/**
 * The agent system, as the interface sees it.
 *
 * Every thread is one running or finished process. Steering a live thread and
 * steering a queued one look identical from here on purpose: the caller sends
 * a message and the runtime decides whether it can be delivered now or has to
 * wait for the agent to be picked up.
 */

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

/** What the runtime tracks per conversation, beyond what the UI is shown. */
interface Thread extends AgentThreadView {
  runId?: string;
  sessionId?: string;
  harness: HarnessId;
  steering?: Steering;
  /** Messages sent before the agent started. Delivered with its first prompt. */
  pending: string[];
}

/** Thread keys, as the interface expects them. */
export const ticketAgentKey = (projectId: string) =>
  `ticket-agent:${projectId}`;
export const plannerKey = (ticketId: string) => `planner:${ticketId}`;

function roleOf(key: string): AgentRole {
  if (key.startsWith("ticket-agent:")) return "ticket-agent";
  if (key.startsWith("planner:")) return "task-agent";
  return "worker";
}

function message(
  role: ThreadMessage["role"],
  text: string,
  extra: Partial<ThreadMessage> = {},
): ThreadMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    at: new Date().toISOString(),
    ...extra,
  };
}

const empty: Thread = {
  agentId: "",
  activity: "queued",
  messages: [],
  harness: "claude-code",
  pending: [],
};

/** A worker that has stopped and needs a person before it can carry on. */
export interface HumanRequest {
  id: string;
  taskId: string;
  ticket: string;
  kind: string;
  question: string;
  command?: string;
}

export interface Runtime extends WorkflowRuntime {
  /** Everything waiting on a person, by task id. */
  requests: Record<string, HumanRequest[]>;
  /** Answer one. The worker is polling and carries straight on. */
  answer: (
    projectId: string,
    id: string,
    approved: boolean,
    text: string,
  ) => Promise<void>;
  /** Open a conversation with an agent that has not started yet. */
  start: (
    key: string,
    cwd: string,
    prompt: string,
    scope?: AgentScope,
  ) => Promise<void>;
  /** Run a launch plan the caller already built, and follow it as a thread. */
  launch: (
    key: string,
    plan: LaunchPlan,
    scope?: AgentScope,
  ) => Promise<string>;
}

interface AgentScope {
  organizationId: string;
  projectId: string;
  role: AgentRole;
}

export function useWorkflowRuntime(
  harness: HarnessId = "claude-code",
): Runtime {
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [mergeQueues, setMergeQueues] = useState<Record<string, string[]>>({});
  const [requests, setRequests] = useState<Record<string, HumanRequest[]>>({});
  const connected = isTauri();

  // Runs are addressed by run id on the event stream but by thread key here.
  const byRun = useRef<Record<string, string>>({});
  // Where our own worker command and harness configuration live.
  const binary = useRef("berdloop-worker");
  const home = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!connected) return;
    void invoke<string>("worker_command")
      .then((path) => {
        binary.current = path;
      })
      .catch(() => undefined);
    void invoke<string>("harness_home")
      .then((path) => {
        home.current = path;
      })
      .catch(() => undefined);
  }, [connected]);

  const patch = useCallback((key: string, change: Partial<Thread>) => {
    setThreads((current) => ({
      ...current,
      [key]: { ...empty, ...current[key], agentId: key, ...change },
    }));
  }, []);

  const append = useCallback((key: string, entry: ThreadMessage) => {
    setThreads((current) => {
      const thread = { ...empty, ...current[key], agentId: key };
      return {
        ...current,
        [key]: { ...thread, messages: [...thread.messages, entry] },
      };
    });
  }, []);

  useEffect(() => {
    if (!connected) return;
    const chunks = listen<AgentChunk>("agent://chunk", ({ payload }) => {
      const key = byRun.current[payload.runId];
      if (!key) return;
      if (payload.sessionId) patch(key, { sessionId: payload.sessionId });

      if (payload.kind === "text" && payload.text) {
        append(key, message("agent", payload.text));
      } else if (payload.kind === "tool") {
        // A tool line says what the agent is doing right now, which is what
        // the activity badge is for. It is not part of the conversation.
        patch(key, { activity: activityOf(payload.text) });
      }
    });
    const ends = listen<AgentEnd>("agent://end", ({ payload }) => {
      const key = byRun.current[payload.runId];
      if (!key) return;
      delete byRun.current[payload.runId];
      patch(key, {
        streaming: false,
        activity: payload.ok ? "done" : "blocked",
      });
      if (!payload.ok && payload.detail) {
        append(key, message("system", payload.detail));
      }
    });
    return () => {
      void chunks.then((stop) => stop());
      void ends.then((stop) => stop());
    };
  }, [connected, patch, append]);

  /** Start a conversation, handing it anything said while it was queued. */
  const start = useCallback(
    async (key: string, cwd: string, prompt: string, scope?: AgentScope) => {
      const role = roleOf(key);
      const waiting = threads[key]?.pending ?? [];
      const opening = waiting.length
        ? `${prompt}\n\n## Since this was queued\n${waiting.map((note) => `- ${note}`).join("\n")}`
        : prompt;

      const plan: LaunchPlan = planConversation({
        harness,
        role,
        cwd,
        prompt: opening,
        sessionId: crypto.randomUUID(),
        binary: binary.current,
        home: home.current,
      });
      const run = await invoke<{ runId: string; sessionId: string | null }>(
        "agent_start",
        {
          plan,
          harness,
          sessionId: null,
          organizationId: scope?.organizationId,
          projectId: scope?.projectId,
          role: scope?.role ?? role,
        },
      );
      byRun.current[run.runId] = key;
      patch(key, {
        runId: run.runId,
        sessionId: run.sessionId ?? undefined,
        steering: plan.steering,
        harness,
        streaming: true,
        activity: "coding",
        pending: [],
      });
    },
    [harness, patch, threads],
  );

  /**
   * Send a message to one thread.
   *
   * A running conversation is interrupted. One that has not started keeps the
   * message until it does, so steering early is never lost.
   */
  const send = useCallback(
    async (key: string, text: string, clientMessageId?: string) => {
      const thread = threads[key];
      const live = thread?.streaming && thread.sessionId;

      append(
        key,
        message("user", text, {
          id: clientMessageId ?? crypto.randomUUID(),
          delivery: live ? "delivered" : "pending",
        }),
      );
      if (!live || !thread) {
        patch(key, { pending: [...(thread?.pending ?? []), text] });
        return;
      }

      const steering = thread.steering ?? { via: "stdin" };
      if (steering.via === "stdin") {
        await invoke("agent_steer", { runId: thread.runId, message: text });
      } else {
        await invoke("agent_steer_command", {
          program: steering.program,
          args: steering.args,
          sessionId: thread.sessionId,
          message: text,
        });
      }
    },
    [threads, append, patch],
  );

  const dispatch = useCallback(
    async (action: WorkflowAction) => {
      const key =
        action.target === "ticket-agent"
          ? ticketAgentKey(action.projectId)
          : action.target === "planner" && action.ticketId
            ? plannerKey(action.ticketId)
            : (action.taskId ?? "");

      switch (action.kind) {
        case "message": {
          if (!action.text?.trim()) return;
          if (action.target === "all-workers") {
            // One instruction, every worker on the ticket. Each decides for
            // itself whether it can be interrupted now.
            await Promise.all(
              Object.keys(threads)
                .filter((id) => roleOf(id) === "worker")
                .map((id) => send(id, action.text!, undefined)),
            );
            return;
          }
          await send(key, action.text, action.clientMessageId);
          return;
        }
        case "stop-agent": {
          const runId = threads[key]?.runId;
          if (runId) await invoke("agent_stop", { runId });
          patch(key, { streaming: false, activity: "paused" });
          return;
        }
        case "pause-ticket":
        case "resume-ticket":
        case "start-ticket":
          // Ticket lifecycle is the ticket agent's own decision, so it is
          // asked rather than told.
          patch(ticketAgentKey(action.projectId), {
            activity: action.kind === "pause-ticket" ? "paused" : "coding",
          });
          return;
      }
    },
    [threads, send, patch],
  );

  // Questions live on disk, like the merge queue, because the worker asking
  // is a separate process and the question must outlive this window.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = () =>
      invoke<HumanRequest[]>("human_requests", { projectId: "" })
        .then((open) => {
          if (!live) return;
          const byTask: Record<string, HumanRequest[]> = {};
          for (const request of open) {
            (byTask[request.taskId] ??= []).push(request);
          }
          setRequests(byTask);
          // A worker that is waiting is not coding, and should not look like
          // it is. The badge and the icon both read from this.
          setThreads((current) => {
            let changed = false;
            const next = { ...current };
            for (const [key, thread] of Object.entries(current)) {
              const asking = Boolean(byTask[key]?.length);
              const activity = asking
                ? "waiting-for-human"
                : thread.activity === "waiting-for-human"
                  ? "coding"
                  : thread.activity;
              if (activity !== thread.activity) {
                next[key] = { ...thread, activity };
                changed = true;
              }
            }
            return changed ? next : current;
          });
        })
        .catch(() => undefined);
    read();
    const timer = setInterval(read, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connected]);

  // The merge queue is on disk so that workers in other processes share it.
  useEffect(() => {
    if (!connected) return;
    const tickets = new Set(
      Object.keys(threads)
        .filter((key) => key.startsWith("planner:"))
        .map((key) => key.slice("planner:".length)),
    );
    if (!tickets.size) return;
    let live = true;
    const read = () =>
      Promise.all(
        [...tickets].map((ticket) =>
          invoke<string[]>("merge_line", { projectId: "", ticket })
            .then((line) => [ticket, line] as const)
            .catch(() => [ticket, []] as const),
        ),
      ).then((pairs) => live && setMergeQueues(Object.fromEntries(pairs)));
    read();
    const timer = setInterval(read, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connected, threads]);

  /** Run a plan the caller built, and follow it as a thread. */
  const launch = useCallback(
    async (key: string, plan: LaunchPlan, scope?: AgentScope) => {
      const pending = threads[key]?.pending ?? [];
      const appended = pending.length
        ? `${plan.prompt}\n\n## Instructions received while queued\n${pending.map((item) => `- ${item}`).join("\n")}`
        : plan.prompt;
      const readyPlan = pending.length
        ? {
            ...plan,
            prompt: appended,
            args:
              plan.delivery === "argv"
                ? [...plan.args.slice(0, -1), appended]
                : plan.args,
          }
        : plan;
      const run = await invoke<{ runId: string; sessionId: string | null }>(
        "agent_start",
        {
          plan: readyPlan,
          harness,
          sessionId: null,
          organizationId: scope?.organizationId,
          projectId: scope?.projectId,
          role: scope?.role ?? roleOf(key),
        },
      );
      byRun.current[run.runId] = key;
      patch(key, {
        runId: run.runId,
        sessionId: run.sessionId ?? undefined,
        steering: readyPlan.steering,
        harness,
        streaming: true,
        activity: "coding",
        worktree: readyPlan.cwd,
        pending: [],
      });
      return run.runId;
    },
    [harness, patch, threads],
  );

  // Shared UI reads the central store, so every snapshot lands there too.
  // The queues are not set here: they are files, and `queue-watcher` reads
  // them, so one writer owns each line in the store.
  useEffect(() => {
    useBerdloop.getState().setWorkers(
      Object.entries(threads).map(([id, thread]) => ({
        id,
        activity: thread.activity,
        harness: thread.harness,
        branch: thread.branch,
        worktree: thread.worktree,
        streaming: thread.streaming,
        projectId: id.startsWith("ticket-agent:")
          ? id.slice("ticket-agent:".length)
          : undefined,
        ticketId: id.startsWith("planner:")
          ? id.slice("planner:".length)
          : undefined,
        // A key with no prefix is an agent task running on its own worker.
        agentTaskId: id.includes(":") ? undefined : id,
      })),
    );
  }, [threads]);

  const answer = useCallback(
    async (projectId: string, id: string, approved: boolean, text: string) => {
      await invoke("human_answer", { projectId, id, approved, text });
      setRequests((current) => {
        const next: Record<string, HumanRequest[]> = {};
        for (const [taskId, list] of Object.entries(current)) {
          const kept = list.filter((request) => request.id !== id);
          if (kept.length) next[taskId] = kept;
        }
        return next;
      });
    },
    [],
  );

  return {
    connected,
    threads,
    mergeQueues,
    requests,
    answer,
    dispatch,
    start,
    launch,
  };
}

/** Read what an agent is doing from the tool it just reached for. */
function activityOf(tool: string): AgentThreadView["activity"] {
  const name = tool.toLowerCase();
  if (name.includes("merge-wait") || name.includes("merge-request")) {
    return "waiting-to-merge";
  }
  if (name.includes("merge-sync") || name.includes("merge-land"))
    return "merging";
  if (name.includes("test") || name.includes("check")) return "testing";
  return "coding";
}
