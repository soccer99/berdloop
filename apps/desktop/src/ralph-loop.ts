import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  defaultHarnessSettings,
  betaEnabled,
  toExtensions,
  type HarnessId,
  type HarnessSettings,
} from "@berdloop/agent";
import type { Project, Task, TaskWorkspace } from "@berdloop/core";
import {
  LoopEngine,
  type ActiveRun,
  type LoopDeps,
  type LoopSnapshot,
} from "./loop-engine";

/**
 * The Ralph loop as a React hook. The loop itself is `LoopEngine`; this only
 * feeds it the latest props and ticks it while it runs.
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
  projects: Project[];
  /** The project the window shows. Pinned by the loop when it starts. */
  projectId: string;
  /** A ticket a person pointed the loop at. */
  preferredTicketId?: string;
  harness?: HarnessId;
  reviewHarness?: HarnessId;
  slots?: number;
  startAgent: LoopDeps["startAgent"];
  startPlanner: LoopDeps["startPlanner"];
}

export interface LoopStatus {
  running: boolean;
  note: string;
  active: Record<string, ActiveRun>;
  /** The ticket workers are being handed, while the loop runs. */
  currentTicketId?: string;
  /** The project the loop is pinned to, while it runs. */
  currentProjectId?: string;
  start: () => void;
  /** Stop handing out new work. Workers already running keep going. */
  pause: () => void;
}

export function useRalphLoop(options: LoopOptions): LoopStatus {
  // The engine reads fresh props every step, so it must not close over a
  // stale copy of them.
  const latest = useRef(options);
  latest.current = options;

  // Where berdloop-worker lives, a private harness home, and what agents may
  // load. Read once, app wide.
  const launch = useRef({
    binary: "berdloop-worker",
    home: undefined as string | undefined,
    settings: defaultHarnessSettings() as HarnessSettings,
    mcpConfig: undefined as string | undefined,
  });

  const [snapshot, setSnapshot] = useState<LoopSnapshot>({
    running: false,
    note: "Not started.",
    active: {},
  });

  const engine = useRef<LoopEngine | null>(null);
  if (!engine.current) {
    engine.current = new LoopEngine({
      invoke: (command, args) => invoke(command, args),
      read: () => ({
        workspace: latest.current.workspace,
        projects: latest.current.projects,
        projectId: latest.current.projectId,
        preferredTicketId: latest.current.preferredTicketId,
        slots: latest.current.slots ?? defaultWorkers,
        harness: latest.current.harness ?? "claude-code",
        reviewHarness: latest.current.reviewHarness ?? "claude-code",
      }),
      update: (change) => latest.current.update(change),
      launch: () => ({
        binary: launch.current.binary,
        home: launch.current.home,
        trust: launch.current.settings.trust,
        extensions: toExtensions(
          launch.current.settings,
          launch.current.mcpConfig,
        ),
        beta: betaEnabled(launch.current.settings),
      }),
      startAgent: (input) => latest.current.startAgent(input),
      startPlanner: (ticket: Task, project: Project, prompt: string) =>
        latest.current.startPlanner(ticket, project, prompt),
      onChange: setSnapshot,
    });
  }

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string>("worker_command")
      .then((path) => {
        launch.current.binary = path;
      })
      .catch(() => undefined);
    void invoke<string>("harness_home")
      .then((path) => {
        launch.current.home = path;
      })
      .catch(() => undefined);
    void invoke<HarnessSettings>("load_harness_settings")
      .then((saved) => {
        launch.current.settings = saved;
      })
      .catch(() => undefined);
    void invoke<string>("harness_mcp_config")
      .then((path) => {
        launch.current.mcpConfig = path || undefined;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!snapshot.running || !isTauri()) return;
    const loop = engine.current!;
    void loop.tick();
    const timer = setInterval(() => void loop.tick(), TICK_MS);
    return () => clearInterval(timer);
  }, [snapshot.running]);

  return {
    running: snapshot.running,
    note: snapshot.note,
    active: snapshot.active,
    currentTicketId: snapshot.ticketId,
    currentProjectId: snapshot.projectId,
    start: () => {
      if (!isTauri()) {
        setSnapshot((current) => ({
          ...current,
          note: "The loop needs the desktop app.",
        }));
        return;
      }
      engine.current!.start();
    },
    pause: () => engine.current!.pause(),
  };
}
