import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TaskWorkspace } from "@berdloop/core";
import { useBerdloop } from "@berdloop/state";
import {
  betaEnabled,
  planConversation,
  toExtensions,
  type HarnessSettings,
  type HarnessId,
  type LaunchPlan,
} from "@berdloop/agent";
import type {
  MergeEntry,
  WorkflowAction,
  WorkflowRuntime,
} from "./workflow-ui";
import { detectStall } from "./jev";
import {
  resolveRolePreference,
  type AgentPreferences,
} from "./agent-preferences";
import {
  conversationKey,
  mergeConversations,
  messageScopes,
  type AgentScope,
  type ConversationSnapshot,
} from "./conversation-routing";

/**
 * What an agent is told when it is started again after the app stopped.
 *
 * Short on purpose: it is resumed on its own session, so its own transcript
 * is the record of what it was doing. Only the interruption is news.
 */
function resumePrompt(role: AgentScope["role"]): string {
  const carry =
    "Berdloop restarted and cut your last run off. Read your own recent messages, work out where you had reached, and carry on.";
  return role === "worker"
    ? `${carry} Your worktree and your commits are exactly as you left them. Merge and report as usual.`
    : carry;
}

export const ticketAgentKey = (projectId: string) =>
  `ticket-agent:${projectId}`;
export const plannerKey = (ticketId: string) => `planner:${ticketId}`;

export interface HumanRequest {
  id: string;
  taskId: string;
  ticket: string;
  kind: string;
  question: string;
  command?: string;
}

export interface Runtime extends WorkflowRuntime {
  threads: Record<string, ConversationSnapshot>;
  requests: Record<string, HumanRequest[]>;
  /**
   * Beta: worker threads that look stuck, by conversation key.
   *
   * A label, not an action. Nothing is stopped and nothing is retried: the
   * loop keeps its own limits, and this only tells a person where to look.
   */
  stalled: Record<string, boolean>;
  /**
   * The gateway answering the beta features, or empty when they are off.
   *
   * The native side decides this from the keys it holds, so the interface
   * never has to work out whether a control would do anything.
   */
  beta: string;
  answer: (
    projectId: string,
    id: string,
    approved: boolean,
    text: string,
  ) => Promise<void>;
  start: (
    key: string,
    cwd: string,
    prompt: string,
    scope: AgentScope,
    clientMessageId?: string,
  ) => Promise<void>;
  launch: (key: string, plan: LaunchPlan, scope: AgentScope) => Promise<string>;
}

/** Rust owns the processes, routing and message lists. React only renders snapshots. */
export function useWorkflowRuntime(
  harness: HarnessId = "claude-code",
): Runtime {
  const native = isTauri();
  const [ready, setReady] = useState(false);
  const [threads, setThreads] = useState<Record<string, ConversationSnapshot>>(
    {},
  );
  const [mergeQueues, setMergeQueues] = useState<Record<string, MergeEntry[]>>(
    {},
  );
  const [requests, setRequests] = useState<Record<string, HumanRequest[]>>({});
  const [stalled, setStalled] = useState<Record<string, boolean>>({});
  const [beta, setBeta] = useState("");
  const projects = useBerdloop((state) => state.projects);
  const tickets = useBerdloop((state) => state.tickets);

  const apply = useCallback((snapshots: ConversationSnapshot[]) => {
    setThreads((current) => mergeConversations(current, snapshots));
  }, []);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      // Subscribe before fetching so a fast process cannot fall between them.
      const stop = await listen<ConversationSnapshot>(
        "agent://conversation",
        ({ payload }) => {
          if (active) apply([payload]);
        },
      );
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
      const snapshots = await invoke<ConversationSnapshot[]>(
        "agent_conversations",
      );
      if (active) {
        apply(snapshots);
        setReady(true);
      }
    })().catch(() => {
      if (active) setReady(false);
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [native, apply]);

  const start = useCallback(
    async (
      key: string,
      cwd: string,
      prompt: string,
      scope: AgentScope,
      clientMessageId: string = crypto.randomUUID(),
    ) => {
      if (key !== conversationKey(scope))
        throw new Error("The chat and agent address do not match.");
      const current = (
        await invoke<ConversationSnapshot[]>("agent_conversations")
      ).find((thread) => thread.agentId === key);
      if (current?.streaming) {
        await invoke("agent_send_message", {
          scope,
          message: { id: clientMessageId, text: prompt },
        });
        return;
      }
      const [binary, home, settings, mcpConfig, preferences] =
        await Promise.all([
          invoke<string>("worker_command"),
          invoke<string>("harness_home"),
          invoke<HarnessSettings>("load_harness_settings"),
          invoke<string>("harness_mcp_config"),
          invoke<AgentPreferences>("load_agent_preferences"),
        ]);
      const preference = resolveRolePreference(
        preferences,
        scope.organizationId,
        scope.projectId,
        scope.role,
      );
      const chosenHarness = current?.sessionId
        ? current.harness
        : (preference.harness ?? harness);
      // A model belongs to the harness that names it. A thread resumed on an
      // earlier harness keeps that harness, so the model must not follow.
      const model =
        chosenHarness === preference.harness ? preference.model : "";
      const sessionId = current?.sessionId ?? crypto.randomUUID();
      const plan = planConversation({
        harness: chosenHarness,
        model,
        role: scope.role,
        cwd,
        prompt,
        sessionId,
        resume: current?.sessionId,
        binary,
        home,
        trust: settings.trust,
        extensions: toExtensions(settings, mcpConfig || undefined),
        // The decide tool is only put in an agent's orders when a gateway is
        // set up, so it is never told about a command that would refuse it.
        beta: betaEnabled(settings),
      });
      await invoke("agent_start", {
        plan,
        harness: chosenHarness,
        scope,
        sessionId: chosenHarness === "claude-code" ? sessionId : null,
        opening: { id: clientMessageId, text: prompt },
      });
    },
    [harness],
  );

  const dispatch = useCallback(async (action: WorkflowAction) => {
    if (
      action.kind === "start-ticket" ||
      action.kind === "pause-ticket" ||
      action.kind === "resume-ticket"
    ) {
      // The same command a ticket agent uses, so the two cannot disagree.
      // Pausing stops new work being handed out; running workers finish.
      if (!action.ticketId) throw new Error("Choose a ticket first.");
      await invoke("ticket_control", {
        scope: {
          organizationId: action.organizationId ?? "",
          projectId: action.projectId,
          role: "ticket-agent",
        },
        ticket: action.ticketId,
        paused: action.kind === "pause-ticket",
      });
      return;
    }
    const workspace = await invoke<TaskWorkspace>("load_task_workspace");
    const scopes = messageScopes(action, workspace.tasks, workspace.agentTasks);
    if (action.kind === "stop-agent") {
      await invoke("agent_stop", { scope: scopes[0] });
      return;
    }
    if (!action.text?.trim()) return;
    const id = action.clientMessageId ?? crypto.randomUUID();
    const results = await Promise.allSettled(
      scopes.map((scope) =>
        invoke("agent_send_message", {
          scope,
          message: { id, text: action.text!.trim(), target: action.target },
        }),
      ),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${conversationKey(scopes[index]!)}: ${String(result.reason)}`]
        : [],
    );
    if (failures.length) throw new Error(failures.join("\n"));
  }, []);

  const launch = useCallback(
    async (key: string, plan: LaunchPlan, scope: AgentScope) => {
      if (key !== conversationKey(scope))
        throw new Error("The worker and conversation address do not match.");
      const chosenHarness: HarnessId =
        plan.program === "codex" ? "codex" : "claude-code";
      const sessionAt = plan.args.indexOf("--session-id");
      const run = await invoke<{ runId: string }>("agent_start", {
        plan,
        harness: chosenHarness,
        scope,
        sessionId:
          chosenHarness === "claude-code" && sessionAt >= 0
            ? plan.args[sessionAt + 1]
            : null,
      });
      return run.runId;
    },
    [],
  );

  // Agents the app was running when it stopped.
  //
  // A rebuild, a reload or a crash takes the processes with it, but not the
  // work: the worktrees, the commits and each harness's own transcript are all
  // still there. Each thread is started again on its own saved session, so the
  // app coming back up looks like it never went away. A thread that had already
  // reported an outcome is left alone; the native side does not mark it.
  const resumed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!native) return;
    for (const thread of Object.values(threads)) {
      if (!thread.interrupted || thread.streaming) continue;
      if (resumed.current.has(thread.agentId)) continue;
      const project = projects.find(
        (item) => item.id === thread.scope.projectId,
      );
      // A worker carries on in its own worktree; everyone else in the project.
      const cwd = thread.worktree ?? project?.path;
      // The projects may not have been read yet. Try again next render.
      if (!cwd) continue;
      // Once per window: a start that fails must not be retried on every
      // render. Anything queued for this thread rides along with the restart,
      // because a starting agent is handed whatever is still pending.
      resumed.current.add(thread.agentId);
      void start(
        thread.agentId,
        cwd,
        resumePrompt(thread.scope.role),
        thread.scope,
      ).catch(() => undefined);
    }
  }, [native, threads, projects, start]);

  // An instruction queued for a coordinator that is not running, such as a
  // ticket agent's replan request to a stopped planner, would otherwise wait
  // until a person happened to open that chat. Wake it once per revision.
  const woken = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!native) return;
    for (const thread of Object.values(threads)) {
      if (thread.streaming || thread.scope.role === "worker") continue;
      // A thread being started again after a restart carries its own queued
      // instructions with it. Waking it here as well would race that.
      if (thread.interrupted) continue;
      const pending = thread.messages.find(
        (message) => message.role === "user" && message.delivery === "pending",
      );
      if (!pending) continue;
      if (woken.current[thread.agentId] === thread.revision) continue;
      woken.current[thread.agentId] = thread.revision;
      const project = projects.find(
        (item) => item.id === thread.scope.projectId,
      );
      if (!project?.path) continue;
      void start(
        thread.agentId,
        project.path,
        pending.text,
        thread.scope,
        pending.id,
      ).catch(() => undefined);
    }
  }, [native, threads, projects, start]);

  // Read each real project directory. A blank project ID is not a wildcard.
  useEffect(() => {
    if (!native) return;
    let active = true;
    const read = async () => {
      const results = await Promise.all(
        projects.map(async (project) => {
          try {
            return await invoke<HumanRequest[]>("human_requests", {
              projectId: project.id,
            });
          } catch {
            return [];
          }
        }),
      );
      if (!active) return;
      const byTask: Record<string, HumanRequest[]> = {};
      for (const request of results.flat())
        (byTask[request.taskId] ??= []).push(request);
      setRequests(byTask);
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [native, projects]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    const read = async () => {
      const pairs = await Promise.all(
        tickets.map(async (ticket) => {
          try {
            return [
              ticket.id,
              await invoke<MergeEntry[]>("merge_line", {
                projectId: ticket.projectId,
                ticket: ticket.ticket,
              }),
            ] as const;
          } catch {
            return [ticket.id, [] as MergeEntry[]] as const;
          }
        }),
      );
      if (active) setMergeQueues(Object.fromEntries(pairs));
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [native, tickets]);

  useEffect(() => {
    useBerdloop.getState().setWorkers(
      Object.values(threads).map((thread) => ({
        id: thread.agentId,
        activity: requests[thread.agentId]?.length
          ? "waiting-for-human"
          : thread.activity,
        harness: thread.harness,
        branch: thread.branch,
        worktree: thread.worktree,
        streaming: thread.streaming,
        projectId: thread.scope.projectId,
        ticketId: thread.scope.ticketId,
        agentTaskId: thread.scope.taskId,
      })),
    );
  }, [threads, requests]);

  // Which gateway, if any, is answering. Re-read on every settings change,
  // which is why the whole window remounts this hook after a save.
  useEffect(() => {
    if (!native) return;
    let active = true;
    void invoke<string>("jev_provider")
      .then((provider) => active && setBeta(provider))
      .catch(() => active && setBeta(""));
    return () => {
      active = false;
    };
  }, [native]);

  // Beta: watch the running workers for one going round in circles.
  //
  // Every thirty seconds, and only for workers whose output has changed since
  // the last look. A worker that says nothing new is not worth asking about
  // twice, and the check costs a fraction of a cent either way.
  const lastJudged = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!native || !beta) return;
    let active = true;
    const look = async () => {
      const workers = Object.values(threads).filter(
        (thread) => thread.streaming && thread.scope.taskId,
      );
      for (const thread of workers) {
        const transcript = thread.messages
          .filter((message) => message.role !== "user")
          .map((message) => message.text)
          .join("\n");
        if (lastJudged.current[thread.agentId] === transcript) continue;
        lastJudged.current[thread.agentId] = transcript;
        const stuck = await detectStall(transcript);
        if (!active) return;
        setStalled((current) =>
          current[thread.agentId] === stuck
            ? current
            : { ...current, [thread.agentId]: stuck },
        );
      }
    };
    void look();
    const timer = setInterval(() => void look(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [native, beta, threads]);

  const answer = useCallback(
    async (projectId: string, id: string, approved: boolean, text: string) => {
      await invoke("human_answer", { projectId, id, approved, text });
      setRequests((current) =>
        Object.fromEntries(
          Object.entries(current).map(([taskId, list]) => [
            taskId,
            list.filter((request) => request.id !== id),
          ]),
        ),
      );
    },
    [],
  );

  return {
    connected: native && ready,
    threads,
    mergeQueues,
    pullRequests: Object.fromEntries(
      tickets
        .filter((ticket) => ticket.pullRequest)
        .map((ticket) => [
          ticket.id,
          { url: ticket.pullRequest!.url, status: ticket.pullRequest!.review },
        ]),
    ),
    requests,
    stalled,
    beta,
    answer,
    dispatch,
    start,
    launch,
  };
}
