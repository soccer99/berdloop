import { describe, expect, test } from "bun:test";
import type { AgentTask, Project, Task, TaskWorkspace } from "@berdloop/core";
import { emptyTaskWorkspace } from "@berdloop/core";
import type { TaskReport } from "@berdloop/agent";
import { LoopEngine, NO_TASKS, type LoopWorld } from "./loop-engine";

/**
 * A stand-in for the Rust side: reports on disk, git calls that just record
 * themselves, and a publish that flips the ticket the way the app does.
 */
class Bench {
  world: LoopWorld;
  calls: { command: string; args?: Record<string, unknown> }[] = [];
  reports: Record<string, TaskReport[]> = {};
  started: { key: string; role: string; ticket: string }[] = [];
  planned: string[] = [];
  clock = 1_000_000;
  /** Resolve the next git_open_task by hand, to test what happens mid-call. */
  holdOpenTask?: () => void;
  holdPrepare?: () => void;
  startFails?: string;
  runIds = 0;
  /** Agent ids the Rust side would report as streaming right now. */
  streamingAgents: string[] = [];
  /** Agent ids the app is starting again after it was stopped mid-run. */
  interruptedAgents: string[] = [];
  /** Set to make the host refuse, as a missing sign-in would. */
  forgeError?: string;
  engine: LoopEngine;

  constructor(
    projects: Project[],
    workspace: TaskWorkspace,
    projectId: string,
  ) {
    this.world = {
      workspace,
      projects,
      projectId,
      slots: 2,
      harness: "claude-code",
      model: "",
      reviewHarness: "claude-code",
      reviewModel: "",
    };
    this.engine = new LoopEngine({
      invoke: <T>(command: string, args?: Record<string, unknown>) =>
        this.invoke(command, args) as Promise<T>,
      read: () => this.world,
      update: (change) => {
        this.world = { ...this.world, workspace: change(this.world.workspace) };
      },
      launch: () => ({
        binary: "/bin/bw",
        trust: "full",
        extensions: {},
        beta: false,
      }),
      startAgent: async ({ key, role, ticket }) => {
        if (this.startFails) throw new Error(this.startFails);
        this.started.push({ key, role, ticket: ticket.id });
        return `run-${++this.runIds}`;
      },
      startPlanner: async (ticket) => {
        this.planned.push(ticket.id);
      },
      now: () => this.clock,
    });
  }

  private async invoke(command: string, args?: Record<string, unknown>) {
    this.calls.push({ command, args });
    switch (command) {
      case "git_task_reports":
        return this.reports[args!.projectId as string] ?? [];
      case "devenv_serve":
        return [];
      case "forge_check":
        if (this.forgeError) throw new Error(this.forgeError);
        return "GitHub team/repo, signed in as tester";
      case "git_prepare":
        if (this.holdPrepare === undefined) return { baseBranch: "main" };
        await new Promise<void>((resolve) => {
          this.holdPrepare = resolve;
        });
        return { baseBranch: "main" };
      case "git_open_task":
        if (this.holdOpenTask === undefined)
          return { path: `/work/${args!.taskId}` };
        await new Promise<void>((resolve) => {
          this.holdOpenTask = resolve;
        });
        return { path: `/work/${args!.taskId}` };
      case "agent_conversations":
        return [
          ...this.streamingAgents.map((agentId) => ({
            agentId,
            streaming: true,
          })),
          ...this.interruptedAgents.map((agentId) => ({
            agentId,
            streaming: false,
            interrupted: true,
          })),
        ];
      case "publish_ticket_pr": {
        const id = args!.ticketId as string;
        this.world = {
          ...this.world,
          workspace: {
            ...this.world.workspace,
            tasks: this.world.workspace.tasks.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: "review",
                    pullRequest: {
                      url: "https://example.test/pr/1",
                      head: "abc",
                      baseBranch: "main",
                      review: "pending",
                    },
                  }
                : item,
            ),
          },
        };
        return { path: "/review/t", head: "abc", baseBranch: "main", url: "u" };
      }
      case "pr_review_context":
        return { path: "/review/t", head: "abc", baseBranch: "main", url: "u" };
      case "ticket_pr_sync": {
        const id = args!.ticketId as string;
        this.world = {
          ...this.world,
          workspace: {
            ...this.world.workspace,
            tasks: this.world.workspace.tasks.map((item) =>
              item.id === id ? { ...item, status: "complete" } : item,
            ),
          },
        };
        return { state: "merged", url: "u" };
      }
      default:
        return undefined;
    }
  }

  named(command: string) {
    return this.calls.filter((call) => call.command === command);
  }

  task(id: string) {
    return this.world.workspace.agentTasks.find((item) => item.id === id)!;
  }

  ticket(id: string) {
    return this.world.workspace.tasks.find((item) => item.id === id)!;
  }

  report(projectId: string, report: TaskReport) {
    (this.reports[projectId] ??= []).push(report);
  }

  /** Edit records the way the window or a coordinator would. */
  edit(change: (workspace: TaskWorkspace) => TaskWorkspace) {
    this.world = { ...this.world, workspace: change(this.world.workspace) };
  }
}

const project = (id: string): Project => ({
  id,
  organizationId: "org",
  name: id,
  description: "",
  path: `/repos/${id}`,
});

const ticket = (
  id: string,
  projectId: string,
  status: Task["status"],
): Task => ({
  id,
  projectId,
  title: `Ticket ${id}`,
  source: "Local",
  ticket: id.toUpperCase(),
  stage: "Engineer",
  status,
  criteria: "do it",
});

const task = (
  id: string,
  parentTaskId: string,
  status: AgentTask["status"] = "ready",
): AgentTask => ({
  id,
  parentTaskId,
  title: `Task ${id}`,
  criteria: "check it",
  status,
  dependencyIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function workspace(tasks: Task[], agentTasks: AgentTask[]): TaskWorkspace {
  return { ...emptyTaskWorkspace(), tasks, agentTasks };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("LoopEngine", () => {
  /**
   * The deadlock this guards against: a worker dies, its task keeps saying
   * "running", nothing hands it out again, and everything waiting behind it
   * waits forever while the workers sit idle.
   */
  test("requeues work whose worker is gone, so a dead agent cannot wedge the loop", async () => {
    const chain = [
      task("a", "t1", "running"),
      { ...task("b", "t1", "queued"), dependencyIds: ["a"] },
    ];
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("t1", "p1", "running")], chain),
      "p1",
    );
    bench.engine.start();
    // prepare, open the ticket branch, then hand the recovered task out.
    for (let i = 0; i < 4; i++) {
      await bench.engine.tick();
      await settle();
    }

    // Handed out again, which is the whole point. It reads as running once
    // more, but this time there is a worker behind it.
    expect(bench.started.map((item) => item.key)).toEqual(["a"]);

    // A task whose worker is genuinely alive is left where it is.
    const live = new Bench(
      [project("p1")],
      workspace([ticket("t2", "p1", "running")], [task("c", "t2", "running")]),
      "p1",
    );
    live.streamingAgents = ["c"];
    live.engine.start();
    for (let i = 0; i < 4; i++) {
      await live.engine.tick();
      await settle();
    }
    expect(live.task("c").status).toBe("running");
    expect(live.started).toHaveLength(0);

    // A worker the app is putting back to work after a restart is not gone.
    // Handing its task out as well would put two workers in one worktree.
    const resuming = new Bench(
      [project("p1")],
      workspace([ticket("t3", "p1", "running")], [task("d", "t3", "running")]),
      "p1",
    );
    resuming.interruptedAgents = ["d"];
    resuming.engine.start();
    for (let i = 0; i < 4; i++) {
      await resuming.engine.tick();
      await settle();
    }
    expect(resuming.task("d").status).toBe("running");
    expect(resuming.started).toHaveLength(0);
  });

  test("opens each ticket on its own branch, and prepares a project once", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace(
        [ticket("a", "p1", "queued"), ticket("b", "p1", "queued")],
        [task("a1", "a"), task("b1", "b")],
      ),
      "p1",
    );
    bench.engine.start();
    await bench.engine.tick(); // prepare
    await bench.engine.tick(); // open a
    await bench.engine.tick(); // start a1
    expect(bench.named("git_prepare")).toHaveLength(1);
    expect(bench.named("git_start_ticket")[0]!.args!.ticket).toBe("A");
    expect(bench.ticket("a").status).toBe("running");
    expect(bench.started.map((s) => s.key)).toEqual(["a1"]);
    expect(bench.engine.snapshot().ticketId).toBe("a");

    // a1 finishes; ticket a is published and goes to review. The loop moves
    // on to b, which must get its own branch: nothing from a is reused.
    bench.report("p1", {
      ticket: "A",
      task: "a1",
      status: "complete",
      detail: "done",
      at: Date.now(),
      runId: "run-1",
    });
    await bench.engine.tick(); // collect a1, publish a
    expect(bench.task("a1").status).toBe("complete");
    expect(bench.named("git_close_task")).toHaveLength(1);
    expect(bench.named("publish_ticket_pr")).toHaveLength(1);
    expect(bench.ticket("a").status).toBe("review");
    await bench.engine.tick(); // review agent for a starts; open b
    expect(bench.started.map((s) => s.role)).toContain("pr-code-review");
    expect(bench.named("git_start_ticket").map((c) => c.args!.ticket)).toEqual([
      "A",
      "B",
    ]);
    expect(bench.named("git_prepare")).toHaveLength(1);
    await bench.engine.tick(); // start b1
    expect(
      bench.started.filter((s) => s.role === "worker").map((s) => s.ticket),
    ).toEqual(["a", "b"]);
  });

  test("navigating to another project does not move work, and old reports still land", async () => {
    const bench = new Bench(
      [project("p1"), project("p2")],
      workspace(
        [ticket("a", "p1", "queued"), ticket("z", "p2", "queued")],
        [task("a1", "a"), task("z1", "z")],
      ),
      "p1",
    );
    bench.engine.start();
    for (let i = 0; i < 3; i++) await bench.engine.tick();
    expect(bench.started.map((s) => s.ticket)).toEqual(["a"]);

    // The window now shows p2. The running loop stays on p1.
    bench.world = { ...bench.world, projectId: "p2" };
    await bench.engine.tick();
    expect(bench.engine.snapshot().projectId).toBe("p1");
    expect(bench.named("git_prepare").map((c) => c.args!.projectId)).toEqual([
      "p1",
    ]);

    // Pause, then start again from p2: that is an explicit choice.
    bench.engine.pause();
    bench.engine.start();
    for (let i = 0; i < 3; i++) await bench.engine.tick();
    expect(bench.engine.snapshot().projectId).toBe("p2");
    expect(bench.started.map((s) => s.ticket)).toEqual(["a", "z"]);
    // p2 was prepared on its own; p1's staging was not reused for it.
    expect(bench.named("git_prepare").map((c) => c.args!.projectId)).toEqual([
      "p1",
      "p2",
    ]);

    // p1's worker finishes while the loop is pinned to p2. Its report is
    // still collected, against p1, and its slot is freed.
    bench.report("p1", {
      ticket: "A",
      task: "a1",
      status: "complete",
      detail: "done",
      at: Date.now(),
      runId: "run-1",
    });
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("complete");
    expect(bench.named("git_close_task")[0]!.args!.projectId).toBe("p1");
    expect(bench.engine.snapshot().active.a1!.state).toBe("finished");
  });

  test("a pause during preparation stops the next step", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.holdPrepare = () => {};
    bench.engine.start();
    const ticking = bench.engine.tick();
    await settle();
    bench.engine.pause();
    bench.holdPrepare!();
    await ticking;
    expect(bench.named("git_start_ticket")).toHaveLength(0);
    // The staging area is still remembered as prepared: that is true.
    bench.engine.start();
    bench.holdPrepare = undefined;
    await bench.engine.tick();
    expect(bench.named("git_prepare")).toHaveLength(1);
    expect(bench.named("git_start_ticket")).toHaveLength(1);
  });

  test("a pause while a worktree is being made hands nothing out", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.engine.start();
    await bench.engine.tick();
    await bench.engine.tick();
    bench.holdOpenTask = () => {};
    const ticking = bench.engine.tick();
    await settle();
    expect(bench.engine.snapshot().active.a1!.state).toBe("starting");
    bench.engine.pause();
    bench.holdOpenTask!();
    await ticking;
    expect(bench.started).toHaveLength(0);
    expect(bench.task("a1").status).toBe("ready");
    expect(bench.engine.snapshot().active.a1).toBeUndefined();
  });

  test("a ticket paused or removed mid-step is left alone", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.engine.start();
    await bench.engine.tick();
    await bench.engine.tick();
    bench.holdOpenTask = () => {};
    const ticking = bench.engine.tick();
    await settle();
    bench.edit((w) => ({
      ...w,
      tasks: w.tasks.map((t) => ({ ...t, status: "paused" as const })),
    }));
    bench.holdOpenTask!();
    await ticking;
    expect(bench.started).toHaveLength(0);
    expect(bench.task("a1").status).toBe("ready");
  });

  test("a report from an earlier attempt never closes a retry", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.engine.start();
    for (let i = 0; i < 3; i++) await bench.engine.tick();
    bench.report("p1", {
      ticket: "A",
      task: "a1",
      status: "blocked",
      detail: "stuck",
      at: Date.now(),
      runId: "run-1",
    });
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("blocked");
    expect(bench.named("git_close_task")).toHaveLength(0);

    // A person edits the task and sends it back to the queue.
    bench.edit((w) => ({
      ...w,
      agentTasks: w.agentTasks.map((t) => ({
        ...t,
        status: "ready" as const,
        updatedAt: new Date().toISOString(),
      })),
    }));
    await bench.engine.tick();
    expect(bench.started).toHaveLength(2);
    expect(bench.engine.snapshot().active.a1!.runId).toBe("run-2");

    // A late duplicate of the first run's report changes nothing.
    bench.report("p1", {
      ticket: "A",
      task: "a1",
      status: "complete",
      detail: "old news",
      at: Date.now() + 10,
      runId: "run-1",
    });
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("running");
    // The retry's own report does.
    bench.report("p1", {
      ticket: "A",
      task: "a1",
      status: "complete",
      detail: "done",
      at: Date.now() + 20,
      runId: "run-2",
    });
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("complete");
  });

  test("a worker that is still exiting is waited for, not called blocked", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.engine.start();
    await bench.engine.tick();
    await bench.engine.tick();
    bench.startFails = "This conversation already has a running agent.";
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("ready");
    expect(bench.engine.snapshot().note).toContain("Waiting");
    bench.startFails = undefined;
    await bench.engine.tick();
    expect(bench.task("a1").status).toBe("running");
    expect(bench.started).toHaveLength(1);
    // Any other failure is a real one.
    bench.edit((w) => ({
      ...w,
      agentTasks: [...w.agentTasks, task("a2", "a")],
    }));
    bench.startFails = "claude: command not found";
    await bench.engine.tick();
    expect(bench.task("a2").status).toBe("blocked");
  });

  test("a worker stopped from outside frees its slot", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace(
        [ticket("a", "p1", "queued")],
        [task("a1", "a"), task("a2", "a"), task("a3", "a")],
      ),
      "p1",
    );
    bench.engine.start();
    for (let i = 0; i < 3; i++) await bench.engine.tick();
    expect(bench.started).toHaveLength(2);
    // A task agent stops a1 and requeues it; the loop did not do this.
    bench.edit((w) => ({
      ...w,
      agentTasks: w.agentTasks.map((t) =>
        t.id === "a1" ? { ...t, status: "ready" as const } : t,
      ),
    }));
    await bench.engine.tick();
    // Too soon to trust: the run may simply not have settled yet.
    expect(bench.started).toHaveLength(2);
    bench.clock += 10_000;
    await bench.engine.tick();
    // The slot was freed and, since a1 is ready again, handed straight back
    // to it under a new run.
    expect(bench.started).toHaveLength(3);
    expect(bench.started[2]!.key).toBe("a1");
    expect(bench.engine.snapshot().active.a1).toMatchObject({
      state: "running",
      runId: "run-3",
    });
  });

  test("a project with no sign-in for its host starts no worker at all", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], [task("a1", "a")]),
      "p1",
    );
    bench.forgeError = "No saved sign-in for github.com.";
    bench.engine.start();
    for (let i = 0; i < 3; i++) await bench.engine.tick();
    // The whole point: nothing is spent on work that could not be published.
    expect(bench.started).toEqual([]);
    expect(bench.named("git_open_task")).toHaveLength(0);
    expect(bench.engine.snapshot().note).toContain("No saved sign-in");

    // Signing in is all it takes. Nothing has to be restarted.
    bench.forgeError = undefined;
    for (let i = 0; i < 4; i++) await bench.engine.tick();
    expect(bench.started.map((s) => s.ticket)).toEqual(["a"]);
  });

  test("an empty ticket gets its planner started exactly once", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "queued")], []),
      "p1",
    );
    bench.engine.start();
    for (let i = 0; i < 4; i++) await bench.engine.tick();
    expect(bench.planned).toEqual(["a"]);
    expect(bench.engine.snapshot().note).toBe(NO_TASKS);
  });

  test("an approved pull request is left to the watcher while the next ticket starts", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace(
        [
          {
            ...ticket("a", "p1", "review"),
            mergePolicy: "automatic",
            pullRequest: {
              url: "u",
              head: "abc",
              baseBranch: "main",
              review: "approved",
            },
          },
          ticket("b", "p1", "queued"),
        ],
        [task("a1", "a", "complete"), task("b1", "b")],
      ),
      "p1",
    );
    bench.engine.start();
    for (let i = 0; i < 4; i++) await bench.engine.tick();
    // Following the pull request belongs to the backend watcher, which does it
    // for every project and whether or not this loop is running. The loop only
    // has to stop waiting on it.
    expect(bench.named("ticket_pr_sync")).toHaveLength(0);
    expect(bench.started.map((s) => s.ticket)).toEqual(["b"]);
  });

  test("a publish that fails is retried later, not given up on", async () => {
    const bench = new Bench(
      [project("p1")],
      workspace([ticket("a", "p1", "running")], [task("a1", "a", "complete")]),
      "p1",
    );
    const publish = bench["invoke"].bind(bench);
    let fail = true;
    bench["invoke"] = async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "publish_ticket_pr" && fail) {
        bench.calls.push({ command, args });
        throw new Error("gh: not logged in");
      }
      return publish(command, args);
    };
    bench.engine.start();
    await bench.engine.tick();
    await bench.engine.tick();
    await bench.engine.tick();
    expect(bench.named("publish_ticket_pr")).toHaveLength(1);
    expect(bench.engine.snapshot().note).toContain("not logged in");
    fail = false;
    bench.clock += 31_000;
    await bench.engine.tick();
    expect(bench.named("publish_ticket_pr")).toHaveLength(2);
    expect(bench.ticket("a").status).toBe("review");
  });
});
