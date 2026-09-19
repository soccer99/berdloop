import {
  buildTaskBrief,
  latestReports,
  planConversation,
  planLoop,
  type Extensions,
  type HarnessId,
  type LaunchPlan,
  type LoopStep,
  type RunState,
  type TaskReport,
  type Trust,
} from "@berdloop/agent";
import {
  setAgentTaskStatus,
  type AgentTask,
  type AgentTaskStatus,
  type Project,
  type Task,
  type TaskWorkspace,
} from "@berdloop/core";
import { nextWorkerTicket } from "./ticket-scheduling";

/**
 * The Ralph loop, without React.
 *
 * Everything the loop remembers is keyed by what it belongs to: staging by
 * project, ticket branches by ticket, runs by task. The window's selection
 * is read once, when the loop starts, and pins the project; navigating
 * elsewhere afterwards changes what the window shows, never where work goes.
 *
 * Every step checks that it is still wanted after each await, so a pause or
 * a ticket that was removed while git was busy cannot start a stale worker.
 */

/** How long a start failure or forge error waits before it is retried. */
const RETRY_MS = 30_000;
/** A run this young is still settling; do not reconcile it against records. */
const SETTLE_MS = 5_000;
/** Review agents that exit without submitting are restarted at most this often. */
const REVIEW_ATTEMPTS = 3;

export interface LoopWorld {
  workspace: TaskWorkspace;
  projects: Project[];
  /** The project the window is looking at. Read only when the loop starts. */
  projectId: string;
  /** A ticket a person pointed the loop at, if any. */
  preferredTicketId?: string;
  slots: number;
  harness: HarnessId;
  /** Empty leaves the harness on its own default. */
  model: string;
  reviewHarness: HarnessId;
  reviewModel: string;
}

export interface LaunchContext {
  binary: string;
  home?: string;
  trust: Trust;
  extensions: Extensions;
  /** Whether agents are given the beta `decide` tool. */
  beta: boolean;
}

export interface ActiveRun extends RunState {
  projectId: string;
  ticketId: string;
  /** When this run was claimed, from `now()`. */
  since: number;
}

export interface LoopSnapshot {
  running: boolean;
  note: string;
  active: Record<string, ActiveRun>;
  /** The project the loop is pinned to while it runs. */
  projectId?: string;
  /** The ticket workers are being handed, if any. */
  ticketId?: string;
}

export interface LoopDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** The world as it is right now. Read at every step, never cached. */
  read: () => LoopWorld;
  update: (change: (current: TaskWorkspace) => TaskWorkspace) => void;
  /** Where the helper lives and what agents may load. */
  launch: () => LaunchContext;
  /** Start one agent process and return its run id. */
  startAgent: (input: {
    key: string;
    cwd: string;
    plan: LaunchPlan;
    role: "worker" | "pr-code-review";
    ticket: Task;
  }) => Promise<string>;
  /** Wake a ticket's planning agent with an opening instruction. */
  startPlanner: (
    ticket: Task,
    project: Project,
    prompt: string,
  ) => Promise<void>;
  onChange?: (snapshot: LoopSnapshot) => void;
  now?: () => number;
}

export const NO_TASKS = "No tasks planned yet.";

/** What a planning agent is told when a ticket has no tasks at all. */
export function planningPrompt(ticket: Task): string {
  return [
    `Plan ticket ${ticket.ticket}: ${ticket.title}.`,
    "",
    "Break it into tasks a fresh worker can each finish alone, with task-add.",
    "Give every task acceptance criteria that name a check. Use --after for order that matters.",
    "",
    "Requirements:",
    ticket.criteria.trim() || "(none recorded)",
  ].join("\n");
}

export class LoopEngine {
  private running = false;
  private note = "Not started.";
  private active: Record<string, ActiveRun> = {};
  private pinned?: string;
  private ticketId?: string;
  /** Set on start: check for tasks left running by workers that are gone. */
  private recover = false;
  private prepared = new Map<string, string>();
  private ticketOpen = new Set<string>();
  private reviewStarted = new Map<string, string>();
  private reviewAttempts = new Map<string, number>();
  private planned = new Set<string>();
  private retryAt = new Map<string, number>();
  private generation = 0;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: LoopDeps) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): LoopSnapshot {
    return {
      running: this.running,
      note: this.note,
      active: { ...this.active },
      projectId: this.pinned,
      ticketId: this.ticketId,
    };
  }

  start(): void {
    this.pinned = this.deps.read().projectId;
    this.generation += 1;
    this.retryAt.clear();
    this.running = true;
    // Worker processes do not survive the window closing, but their task status
    // does. Anything left saying "running" is checked against what is actually
    // alive before the loop plans around it.
    this.recover = true;
    this.say("Starting.");
  }

  pause(): void {
    this.running = false;
    this.generation += 1;
    this.say("Paused. Workers already running keep going.");
  }

  /** One pass. Passes never overlap: a slow git call must not start another. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } catch (cause) {
      this.say(String(cause));
    } finally {
      this.busy = false;
    }
  }

  private say(note: string) {
    this.note = note;
    this.emit();
  }

  private emit() {
    this.deps.onChange?.(this.snapshot());
  }

  /** True once a pause or restart happened after `generation` was read. */
  private stale(generation: number): boolean {
    return !this.running || generation !== this.generation;
  }

  /** True when a step planned for this ticket must not go on. */
  private abandoned(generation: number, ticketId: string): boolean {
    if (this.stale(generation)) return true;
    const ticket = this.deps
      .read()
      .workspace.tasks.find((item) => item.id === ticketId);
    return (
      !ticket ||
      ticket.projectId !== this.pinned ||
      !["queued", "running"].includes(ticket.status)
    );
  }

  /**
   * Put back any task that says it is running with nobody running it.
   *
   * A worker is its own process: it dies with the app, or crashes, and the
   * status it left behind outlives it. Nothing else notices, and because a
   * running task is never handed out again, everything waiting on it waits
   * forever while workers sit idle. This is the only thing that clears that.
   */
  /** Tasks that say they are running without this loop having handed them out. */
  private claimingWork(projectId: string): AgentTask[] {
    const { workspace } = this.deps.read();
    const tickets = new Set(
      workspace.tasks
        .filter((item) => item.projectId === projectId)
        .map((item) => item.id),
    );
    return workspace.agentTasks.filter(
      (item) =>
        tickets.has(item.parentTaskId) &&
        item.status === "running" &&
        this.active[item.id]?.state !== "running" &&
        this.active[item.id]?.state !== "starting",
    );
  }

  private async requeueAbandoned(claiming: AgentTask[]): Promise<void> {
    const live = await this.deps
      .invoke<{ agentId: string; streaming: boolean; interrupted?: boolean }[]>(
        "agent_conversations",
      )
      .catch(() => []);
    // An interrupted thread is one the app is already starting again on its
    // own session and its own worktree. Handing its task out as well would put
    // two workers on it, so it counts as taken.
    const taken = new Set(
      live
        .filter((item) => item.streaming || item.interrupted)
        .map((item) => item.agentId),
    );
    // A worker's conversation is keyed by its task id.
    const abandoned = claiming.filter((item) => !taken.has(item.id));
    if (!abandoned.length) return;
    const complete = new Set(
      this.deps
        .read()
        .workspace.agentTasks.filter((item) => item.status === "complete")
        .map((item) => item.id),
    );
    for (const task of abandoned) {
      this.setActive(task.id, undefined);
      // "queued" alone would never be picked up again: promotion to "ready"
      // only happens to a task's siblings, never to the one being written.
      this.setTaskStatus(
        task.id,
        task.dependencyIds.every((id) => complete.has(id)) ? "ready" : "queued",
      );
    }
    this.say(
      abandoned.length === 1
        ? `${abandoned[0].title} had no worker. Queued it again.`
        : `${abandoned.length} tasks had no worker. Queued them again.`,
    );
  }

  private setTaskStatus(taskId: string, status: AgentTaskStatus) {
    this.deps.update((current) => {
      try {
        return setAgentTaskStatus(current, taskId, status);
      } catch {
        // A status the task system refuses, such as completing work whose
        // dependencies were reopened. Leave the workspace as it is.
        return current;
      }
    });
  }

  private setActive(taskId: string, run: ActiveRun | undefined) {
    if (run) this.active[taskId] = run;
    else delete this.active[taskId];
    this.emit();
  }

  private activeIn(projectId: string): Record<string, RunState> {
    return Object.fromEntries(
      Object.entries(this.active).filter(
        ([, run]) => run.projectId === projectId && run.state !== "finished",
      ),
    );
  }

  private async step(): Promise<void> {
    const generation = this.generation;
    const world = this.deps.read();
    const project = world.projects.find((item) => item.id === this.pinned);
    if (!project?.path) {
      this.say("Choose a project folder first.");
      return;
    }

    if (this.recover) {
      this.recover = false;
      // Checked without awaiting anything, so a start with nothing to recover
      // reaches its first real step on this very tick.
      const claiming = this.claimingWork(project.id);
      if (claiming.length) {
        await this.requeueAbandoned(claiming);
        if (this.stale(generation)) return;
      }
    }

    await this.collect();
    if (this.stale(generation)) return;

    await this.reviews(project, generation);
    if (this.stale(generation)) return;

    const { workspace, preferredTicketId, slots } = this.deps.read();
    const preferred = workspace.tasks.find(
      (item) => item.id === preferredTicketId && item.projectId === project.id,
    );
    const ticket = nextWorkerTicket(workspace, project.id, preferred?.id);
    if (this.ticketId !== ticket?.id) {
      this.ticketId = ticket?.id;
      this.emit();
    }
    if (!ticket) {
      this.say(
        workspace.tasks.some(
          (item) => item.projectId === project.id && item.status === "review",
        )
          ? this.note
          : "No ticket is ready for workers.",
      );
      return;
    }

    const steps = planLoop({
      workspace,
      ticketId: ticket.id,
      active: this.activeIn(project.id),
      prepared: this.prepared.has(project.id),
      ticketOpen: this.ticketOpen.has(ticket.id),
      paused: ticket.status === "paused",
      slots,
    });
    for (const next of steps) {
      if (this.abandoned(generation, ticket.id)) return;
      await this.run(next, project, ticket, generation);
    }
  }

  /** Read what finished workers wrote, for every project with work out. */
  private async collect(): Promise<void> {
    const projectIds = new Set<string>();
    if (this.pinned) projectIds.add(this.pinned);
    for (const run of Object.values(this.active)) {
      if (run.state !== "finished") projectIds.add(run.projectId);
    }
    for (const projectId of projectIds) {
      // Workers cannot make their own databases: Berdloop holds the
      // credentials, deliberately. A worker that asked for one is waiting on
      // this call, so it runs on the same tick as everything else.
      for (const line of await this.deps
        .invoke<string[]>("devenv_serve", { projectId })
        .catch(() => [] as string[]))
        this.say(line);
      const reports = await this.deps
        .invoke<TaskReport[]>("git_task_reports", { projectId })
        .catch(() => [] as TaskReport[]);
      for (const [taskId, report] of Object.entries(latestReports(reports))) {
        const { workspace } = this.deps.read();
        const task = workspace.agentTasks.find((item) => item.id === taskId);
        if (!task || task.status !== "running") continue;
        const run = this.active[taskId];
        // A run that has not been given its id yet cannot be matched, and a
        // report from an earlier attempt must never close the current one.
        if (run?.state === "starting") continue;
        if (run?.runId && report.runId !== run.runId) continue;
        const parent = workspace.tasks.find(
          (item) => item.id === task.parentTaskId,
        );
        if (parent?.ticket !== report.ticket || parent.projectId !== projectId)
          continue;
        if (report.at < Date.parse(task.updatedAt)) continue;
        this.setTaskStatus(taskId, report.status);
        this.setActive(taskId, {
          projectId,
          ticketId: parent.id,
          since: run?.since ?? this.now(),
          state: "finished",
        });
        // Blocked work may contain the only copy of a partial fix. Keep it
        // available for inspection or a later attempt.
        if (report.status === "complete") {
          await this.deps
            .invoke("git_close_task", {
              projectId,
              ticket: report.ticket,
              taskId,
            })
            .catch(() => undefined);
        }
      }
    }
    // A worker stopped or requeued from outside the loop frees its slot.
    const { workspace } = this.deps.read();
    for (const [taskId, run] of Object.entries(this.active)) {
      if (run.state !== "running" || this.now() - run.since < SETTLE_MS)
        continue;
      const task = workspace.agentTasks.find((item) => item.id === taskId);
      if (!task || task.status !== "running") {
        this.setActive(taskId, { ...run, state: "finished" });
      }
    }
  }

  /**
   * Tickets in review need a reviewer.
   *
   * Only starting one happens here, because only the window can launch an
   * agent. What the forge says about the pull request afterwards - its build,
   * its merge - is followed by the backend watcher, for every project and
   * whether or not this loop is running.
   */
  private async reviews(project: Project, generation: number): Promise<void> {
    const tickets = this.deps
      .read()
      .workspace.tasks.filter(
        (item) =>
          item.projectId === project.id &&
          item.status === "review" &&
          item.pullRequest,
      );
    for (const ticket of tickets) {
      if (ticket.pullRequest!.review === "pending") {
        await this.startReview(ticket, project);
      }
      if (this.stale(generation)) return;
    }
  }

  private async startReview(ticket: Task, project: Project): Promise<void> {
    const head = ticket.pullRequest!.head;
    const key = `pr-code-review:${ticket.id}`;
    if (this.reviewStarted.get(key) !== head) this.reviewAttempts.set(key, 0);
    const threads = await this.deps
      .invoke<{ agentId: string; streaming: boolean }[]>("agent_conversations")
      .catch(() => []);
    if (threads.find((thread) => thread.agentId === key)?.streaming) {
      this.reviewStarted.set(key, head);
      return;
    }
    const attempts = this.reviewAttempts.get(key) ?? 0;
    if (this.reviewStarted.get(key) === head && attempts >= REVIEW_ATTEMPTS) {
      this.say(
        `PR review for ${ticket.ticket} exited without a report ${REVIEW_ATTEMPTS} times. Check its chat.`,
      );
      return;
    }
    this.reviewStarted.set(key, head);
    this.reviewAttempts.set(key, attempts + 1);
    try {
      const context = await this.deps.invoke<{
        path: string;
        head: string;
        baseBranch: string;
        url: string;
      }>("pr_review_context", { projectId: project.id, ticketId: ticket.id });
      const launch = this.deps.launch();
      const plan = planConversation({
        harness: this.deps.read().reviewHarness,
        model: this.deps.read().reviewModel,
        role: "pr-code-review",
        cwd: context.path,
        prompt: [
          `Review pull request ${context.url} for ticket ${ticket.ticket}: ${ticket.title}`,
          "",
          "Requirements:",
          ticket.criteria,
          "",
          `Published head: ${context.head}`,
          `Base: ${context.baseBranch}`,
          "",
          `Use git diff origin/${context.baseBranch}...${context.head} or the PR diff.`,
          `Submit with pr-review-submit --head ${context.head} --summary <summary> --findings <JSON array>.`,
        ].join("\n"),
        sessionId: crypto.randomUUID(),
        ...launch,
      });
      await this.deps.startAgent({
        key,
        cwd: context.path,
        plan,
        role: "pr-code-review",
        ticket,
      });
      this.say(`Review of ${ticket.ticket} started.`);
    } catch (cause) {
      this.say(`Could not start PR review for ${ticket.ticket}: ${cause}`);
    }
  }

  private async run(
    next: LoopStep,
    project: Project,
    ticket: Task,
    generation: number,
  ): Promise<void> {
    const projectId = project.id;
    switch (next.kind) {
      case "prepare": {
        const ready = await this.deps.invoke<{ baseBranch: string }>(
          "git_prepare",
          { projectId, source: project.path },
        );
        // Whether a pull request can be opened at all is settled here, before
        // a single worker runs. Finding out afterwards meant a whole ticket's
        // worth of tokens was already spent on work that could not be
        // published.
        const forge = await this.deps
          .invoke<string>("forge_check", { path: project.path })
          .then(
            (who) => ({ ready: true, detail: who }),
            (cause: unknown) => ({ ready: false, detail: String(cause) }),
          );
        if (!forge.ready) {
          // Nothing is marked prepared, so no worker starts and this is tried
          // again next tick. Signing in is all it takes to get going.
          this.say(`No pull requests for this project yet. ${forge.detail}`);
          return;
        }
        this.prepared.set(projectId, ready.baseBranch);
        this.say(
          `Staging ready on ${ready.baseBranch}. Publishing to ${forge.detail}.`,
        );
        return;
      }
      case "open-ticket": {
        await this.deps.invoke("git_start_ticket", {
          projectId,
          ticket: ticket.ticket,
          baseBranch: this.prepared.get(projectId) ?? "main",
        });
        this.ticketOpen.add(ticket.id);
        if (this.abandoned(generation, ticket.id)) return;
        // A ticket with a branch is being worked on, whatever the queue said.
        this.deps.update((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === ticket.id && item.status === "queued"
              ? {
                  ...item,
                  status: "running",
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        }));
        this.say(`Ticket branch open for ${ticket.ticket}.`);
        return;
      }
      case "start-task": {
        const task = next.task;
        // Claim the slot before anything can go wrong, so a failure cannot
        // let the same task be handed out again on the next tick.
        this.setActive(task.id, {
          state: "starting",
          projectId,
          ticketId: ticket.id,
          since: this.now(),
        });
        try {
          const tree = await this.deps.invoke<{
            path: string;
            provision?: { env?: Record<string, string>; notes?: string[] };
          }>("git_open_task", {
            projectId,
            ticket: ticket.ticket,
            taskId: task.id,
          });
          // Ports, connection strings and env for this worker alone. Empty
          // for a project with no .berd/, which then behaves as it always did.
          const runtime = tree.provision?.env ?? {};
          for (const note of tree.provision?.notes ?? [])
            this.say(`${task.id}: ${note}`);
          if (this.abandoned(generation, ticket.id)) {
            // Nothing has been started. Give the slot back untouched.
            this.setActive(task.id, undefined);
            return;
          }
          const plan = planConversation({
            harness: this.deps.read().harness,
            model: this.deps.read().model,
            role: "worker",
            taskId: task.id,
            cwd: tree.path,
            prompt: buildTaskBrief({
              ticket,
              task,
              siblings: this.deps
                .read()
                .workspace.agentTasks.filter(
                  (item) => item.parentTaskId === ticket.id,
                ),
              worktree: tree.path,
            }),
            sessionId: crypto.randomUUID(),
            runtime,
            ...this.deps.launch(),
          });
          this.setTaskStatus(task.id, "running");
          const runId = await this.deps.startAgent({
            key: task.id,
            cwd: tree.path,
            plan,
            role: "worker",
            ticket,
          });
          this.setActive(task.id, {
            state: "running",
            runId,
            projectId,
            ticketId: ticket.id,
            since: this.now(),
          });
          this.say(`Started ${task.title}.`);
        } catch (cause) {
          this.setActive(task.id, {
            state: "finished",
            projectId,
            ticketId: ticket.id,
            since: this.now(),
          });
          if (String(cause).includes("already has a running agent")) {
            // The earlier worker on this task is still exiting. Try again
            // next tick rather than calling the task blocked.
            this.setTaskStatus(task.id, "ready");
            this.say(
              `Waiting for the earlier worker on ${task.title} to exit.`,
            );
          } else {
            this.setTaskStatus(task.id, "blocked");
            this.say(`Could not start ${task.title}: ${cause}`);
          }
        }
        return;
      }
      case "ticket-done": {
        if (this.now() < (this.retryAt.get(ticket.id) ?? 0)) return;
        try {
          await this.deps.invoke("publish_ticket_pr", {
            projectId,
            ticketId: ticket.id,
            source: project.path,
          });
          this.retryAt.delete(ticket.id);
          this.say(`Published ${ticket.ticket}. Its review is starting.`);
        } catch (cause) {
          this.retryAt.set(ticket.id, this.now() + RETRY_MS);
          this.say(`Could not publish ${ticket.ticket}: ${cause}. Retrying.`);
        }
        return;
      }
      case "wait": {
        if (next.reason === NO_TASKS && !this.planned.has(ticket.id)) {
          this.planned.add(ticket.id);
          try {
            await this.deps.startPlanner(
              ticket,
              project,
              planningPrompt(ticket),
            );
            this.say(
              `Asked the planning agent to break ${ticket.ticket} into tasks.`,
            );
          } catch (cause) {
            this.say(`Could not start planning for ${ticket.ticket}: ${cause}`);
          }
          return;
        }
        this.say(next.reason);
        return;
      }
    }
  }
}
