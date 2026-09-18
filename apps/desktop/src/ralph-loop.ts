import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  buildTaskBrief,
  defaultHarnessSettings,
  toExtensions,
  type HarnessSettings,
  latestReports,
  planConversation,
  planLoop,
  type HarnessId,
  type LoopStep,
  type RunState,
  type TaskReport,
} from "@berdloop/agent";
import {
  setAgentTaskStatus,
  type Project,
  type Task,
  type TaskWorkspace,
} from "@berdloop/core";

/**
 * Runs the Ralph loop for one ticket.
 *
 * Every task gets a fresh agent, its own worktree and its own branch. The
 * decision of what to start next is `planLoop`; this only carries it out.
 *
 * ponytail: the loop lives in the window, so closing the app stops handing out
 * new work. Work already running keeps going, because each worker is its own
 * process and reports to disk. Move this to the Tauri backend if runs need to
 * survive the window.
 */

const TICK_MS = 3000;

/** Workers a project runs at once when it has not said otherwise. */
export const defaultWorkers = 3;

export interface LoopOptions {
  workspace: TaskWorkspace;
  update: (change: (current: TaskWorkspace) => TaskWorkspace) => void;
  project?: Project;
  ticket?: Task;
  harness?: HarnessId;
  slots?: number;
  /** Start one agent and return its run id, worktree and session. */
  startAgent: (input: {
    key: string;
    cwd: string;
    plan: ReturnType<typeof planConversation>;
  }) => Promise<string>;
}

export interface LoopStatus {
  running: boolean;
  note: string;
  active: Record<string, RunState>;
  start: () => void;
  /** Stop handing out new work. Workers already running keep going. */
  pause: () => void;
}

export function useRalphLoop(options: LoopOptions): LoopStatus {
  const { workspace, update, project, ticket } = options;
  const harness = options.harness ?? "claude-code";
  const slots = options.slots ?? defaultWorkers;

  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("Not started.");
  const [active, setActive] = useState<Record<string, RunState>>({});

  // The loop reads fresh state every tick, so it must not close over a stale
  // copy of it.
  const latest = useRef({ workspace, project, ticket, active });
  latest.current = { workspace, project, ticket, active };

  const prepared = useRef(false);
  const ticketOpen = useRef(false);
  const busy = useRef(false);

  const setTaskStatus = useCallback(
    (taskId: string, status: "running" | "complete" | "blocked") => {
      update((current) => {
        try {
          return setAgentTaskStatus(current, taskId, status);
        } catch {
          // A status the task system refuses, such as completing work whose
          // dependencies were reopened. Leave the workspace as it is.
          return current;
        }
      });
    },
    [update],
  );

  /** Read what finished workers wrote, and record their outcomes. */
  const collect = useCallback(
    async (projectId: string) => {
      const reports = await invoke<TaskReport[]>("git_task_reports", {
        projectId,
      }).catch(() => [] as TaskReport[]);
      if (!reports.length) return;

      const newest = latestReports(reports);
      for (const [taskId, report] of Object.entries(newest)) {
        const current = latest.current.workspace.agentTasks.find(
          (item: { id: string; status: string }) => item.id === taskId,
        );
        if (!current || current.status !== "running") continue;
        const activeRunId = latest.current.active[taskId]?.runId;
        if (activeRunId && report.runId !== activeRunId) continue;
        const parent = latest.current.workspace.tasks.find(
          (item) => item.id === current.parentTaskId,
        );
        if (parent?.ticket !== report.ticket || parent.projectId !== projectId)
          continue;
        if (report.at < Date.parse(current.updatedAt)) continue;
        setTaskStatus(taskId, report.status);
        setActive((live) => ({ ...live, [taskId]: { state: "finished" } }));
        // Blocked work may contain the only copy of a partial fix. Keep it
        // available for inspection or a later attempt.
        if (report.status === "complete") {
          await invoke("git_close_task", {
            projectId,
            ticket: report.ticket,
            taskId,
          }).catch(() => undefined);
        }
      }
    },
    [setTaskStatus],
  );

  const step = useCallback(async () => {
    const { project: currentProject, ticket: currentTicket } = latest.current;
    if (!currentProject?.path || !currentTicket) {
      setNote("Choose a project folder and a ticket first.");
      return;
    }
    const projectId = currentProject.id;

    await collect(projectId);

    const steps = planLoop({
      workspace: latest.current.workspace,
      ticketId: currentTicket.id,
      active: latest.current.active,
      prepared: prepared.current,
      ticketOpen: ticketOpen.current,
      paused: currentTicket.status === "paused",
      slots,
    });

    for (const next of steps) {
      await run(next);
    }

    async function run(next: LoopStep) {
      switch (next.kind) {
        case "prepare": {
          const ready = await invoke<{ baseBranch: string }>("git_prepare", {
            projectId,
            source: currentProject!.path,
          });
          baseBranch.current = ready.baseBranch;
          prepared.current = true;
          setNote(`Staging ready on ${ready.baseBranch}.`);
          return;
        }
        case "open-ticket": {
          await invoke("git_start_ticket", {
            projectId,
            ticket: currentTicket!.ticket,
            baseBranch: baseBranch.current,
          });
          ticketOpen.current = true;
          setNote(`Ticket branch open for ${currentTicket!.ticket}.`);
          return;
        }
        case "start-task": {
          const task = next.task;
          // Claim the slot before anything can go wrong, so a failure cannot
          // let the same task be handed out again on the next tick.
          setActive((live) => ({ ...live, [task.id]: { state: "starting" } }));
          try {
            const tree = await invoke<{ path: string }>("git_open_task", {
              projectId,
              ticket: currentTicket!.ticket,
              taskId: task.id,
            });
            const plan = planConversation({
              harness,
              role: "worker",
              cwd: tree.path,
              prompt: buildTaskBrief({
                ticket: currentTicket!,
                task,
                siblings: latest.current.workspace.agentTasks.filter(
                  (item: { parentTaskId: string }) =>
                    item.parentTaskId === currentTicket!.id,
                ),
                worktree: tree.path,
              }),
              sessionId: crypto.randomUUID(),
              binary: binary.current,
              home: home.current,
              trust: settings.current.trust,
              extensions: toExtensions(settings.current, mcpConfig.current),
            });
            setTaskStatus(task.id, "running");
            const runId = await options.startAgent({
              key: task.id,
              cwd: tree.path,
              plan,
            });
            setActive((live) => ({
              ...live,
              [task.id]: { state: "running", runId },
            }));
            setNote(`Started ${task.title}.`);
          } catch (cause) {
            setActive((live) => ({
              ...live,
              [task.id]: { state: "finished" },
            }));
            setTaskStatus(task.id, "blocked");
            setNote(`Could not start ${task.title}: ${cause}`);
          }
          return;
        }
        case "ticket-done":
          setNote(
            "Every task is complete. Review the ticket, then open a pull request.",
          );
          setRunning(false);
          return;
        case "wait":
          setNote(next.reason);
          return;
      }
    }
  }, [collect, harness, options, setTaskStatus, slots]);

  const baseBranch = useRef("main");
  // Where berdloop-worker lives, so agents are told a path that resolves.
  const binary = useRef("berdloop-worker");
  // A harness configuration directory of ours, so agents read none of the
  // user's own MCP servers, skills or plugins.
  const home = useRef<string | undefined>(undefined);
  // What every agent here is allowed to do and load. Set once, app wide.
  const settings = useRef<HarnessSettings>(defaultHarnessSettings());
  const mcpConfig = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isTauri()) return;
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
    void invoke<HarnessSettings>("load_harness_settings")
      .then((saved) => {
        settings.current = saved;
      })
      .catch(() => undefined);
    void invoke<string>("harness_mcp_config")
      .then((path) => {
        mcpConfig.current = path || undefined;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!running || !isTauri()) return;
    let live = true;
    const tick = async () => {
      // Ticks never overlap. A slow git call must not start a second pass.
      if (busy.current) return;
      busy.current = true;
      try {
        await step();
      } catch (cause) {
        setNote(String(cause));
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => live && void tick(), TICK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, step]);

  return {
    running,
    note,
    active,
    start: () => {
      if (!isTauri()) {
        setNote("The loop needs the desktop app.");
        return;
      }
      setRunning(true);
    },
    pause: () => {
      setRunning(false);
      setNote("Paused. Workers already running keep going.");
    },
  };
}
