import { describe, expect, test } from "bun:test";
import {
  planConversation,
  planLaunch,
  standingOrders,
  type LaunchInput,
} from "./harness";
import { berdloopTools, renderTools, shellCall, toolsFor } from "./tools";
import { forRole, rules, skills } from "./rules";
import type { AgentTask, Task } from "@berdloop/core";

const ticket: Task = {
  id: "ticket-1",
  projectId: "p",
  title: "Invite teammates",
  source: "Linear",
  ticket: "ENG-42",
  stage: "Engineer",
  status: "running",
  criteria: "A member can invite a teammate by email.",
};

const task: AgentTask = {
  id: "task-a",
  parentTaskId: "ticket-1",
  title: "Add the invite endpoint",
  criteria: "POST /invites accepts an email and returns 201.",
  status: "ready",
  dependencyIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const input: LaunchInput = {
  harness: "claude-code",
  ticket,
  task,
  siblings: [task],
  worktree: "/work/task-a",
};

describe("standingOrders", () => {
  const orders = standingOrders("worker");

  test("carries every rule, skill and tool for the role", () => {
    for (const rule of forRole(rules, "worker"))
      expect(orders).toContain(rule.title);
    for (const skill of forRole(skills, "worker"))
      expect(orders).toContain(skill.when);
    for (const tool of toolsFor("worker")) expect(orders).toContain(tool.name);
  });

  test("a role is never given another role's tools", () => {
    // A worker must not be able to reorder the ticket queue.
    expect(orders).not.toContain("ticket_reorder");
    expect(orders).not.toContain("task_steer");

    const ticketAgent = standingOrders("ticket-agent");
    expect(ticketAgent).toContain("ticket_edit");
    expect(ticketAgent).not.toContain("merge_land");

    const taskAgent = standingOrders("task-agent");
    expect(taskAgent).toContain("task_steer");
    expect(taskAgent).not.toContain("ticket_pause");
  });

  test("both planners get the same six operations on their own queue", () => {
    // They are one agent pointed at two queues. If the sets ever drift, the
    // tools were hand-written again instead of generated.
    const operations = (role: "ticket-agent" | "task-agent", noun: string) =>
      toolsFor(role)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith(`${noun}_`))
        .map((name) => name.slice(noun.length + 1))
        .sort();
    const six = ["add", "edit", "merge", "remove", "reorder", "split"];
    expect(operations("ticket-agent", "ticket")).toEqual(
      [...six, "import", "pause", "replan", "resume"].sort(),
    );
    expect(operations("task-agent", "task")).toEqual(
      [...six, "steer", "stop"].sort(),
    );
    for (const role of ["ticket-agent", "task-agent"] as const)
      expect(standingOrders(role)).toContain("queue_show");
  });

  test("the ticket agent is told how to import a provider's issue", () => {
    // The picker hands the agent a provider and a reference and nothing else,
    // so the brief has to name the command that turns those into a ticket.
    expect(toolsFor("ticket-agent").map((tool) => tool.name)).toContain(
      "ticket_import",
    );
    const rendered = renderTools(toolsFor("ticket-agent"));
    expect(rendered).toContain(
      "berdloop-worker ticket-import --provider <provider> --reference <reference>",
    );
    expect(standingOrders("ticket-agent")).toContain("ticket-import");
  });

  test("every tool belongs to at least one role", () => {
    const covered = new Set(
      (
        ["ticket-agent", "task-agent", "worker", "pr-code-review"] as const
      ).flatMap((role) =>
        toolsFor(role, berdloopTools, true).map((t) => t.name),
      ),
    );
    for (const tool of berdloopTools) expect(covered.has(tool.name)).toBe(true);
  });

  test("a beta tool is absent until the beta is on", () => {
    // An agent that is told about a tool will use it, so a tool that would
    // refuse must not be described at all.
    // "### decide" is the tool heading. A plain "decide" also matches the word
    // in another tool's description, which is not what this is asking.
    expect(standingOrders("task-agent")).not.toContain("### decide");
    expect(toolsFor("task-agent").map((tool) => tool.name)).not.toContain(
      "decide",
    );
    expect(
      toolsFor("task-agent", berdloopTools, true).map((tool) => tool.name),
    ).toContain("decide");
  });

  test("the beta tool is offered to the agents that make judgments, not to workers", () => {
    const named = (role: Parameters<typeof toolsFor>[0]) =>
      toolsFor(role, berdloopTools, true).map((tool) => tool.name);
    expect(named("ticket-agent")).toContain("decide");
    expect(named("task-agent")).toContain("decide");
    expect(named("pr-code-review")).toContain("decide");
    // A worker writes code for one task. Its commands are screened for it.
    expect(named("worker")).not.toContain("decide");
  });

  test("turning the beta on changes nothing else about the orders", () => {
    const off = standingOrders("task-agent");
    const on = standingOrders(
      "task-agent",
      toolsFor("task-agent", berdloopTools, true),
    );
    expect(on).toContain("### decide");
    for (const tool of toolsFor("task-agent")) expect(on).toContain(tool.name);
    expect(off.length).toBeLessThan(on.length);
  });

  test("the beta tool is described with a command the agent can run", () => {
    const on = standingOrders(
      "ticket-agent",
      toolsFor("ticket-agent", berdloopTools, true),
    );
    expect(on).toContain("berdloop-worker decide --questions <questions>");
  });

  test("shows how to actually call a tool", () => {
    expect(orders).toContain("berdloop-worker merge-request --task <task>");
  });

  test("an absolute path is used when the app knows one", () => {
    // A bare name is not found: harnesses rebuild PATH from a shell snapshot.
    const located = standingOrders(
      "worker",
      undefined,
      "/opt/berdloop/bin/berdloop-worker",
    );
    expect(located).toContain(
      "/opt/berdloop/bin/berdloop-worker merge-request --task <task>",
    );
    expect(planLaunch({ ...input, binary: "/opt/b/bw" }).system).toContain(
      "/opt/b/bw merge-land",
    );
  });

  test("is the same whichever harness is running", () => {
    const claude = planLaunch(input);
    const codex = planLaunch({ ...input, harness: "codex" });
    // Codex has no separate channel, so the orders ride in its prompt.
    expect(codex.prompt).toContain(claude.system);
  });
});

describe("planLaunch", () => {
  test("Claude Code keeps standing orders out of the conversation", () => {
    const plan = planLaunch({ ...input, sessionId: "fixed-id" });
    expect(plan.program).toBe("claude");
    expect(plan.args).toContain("--append-system-prompt");
    expect(plan.args).toContain("--verbose");
    expect(plan.args[plan.args.indexOf("--session-id") + 1]).toBe("fixed-id");
    // The prompt travels over standard input, which is also the channel that
    // later steering messages use.
    expect(plan.delivery).toBe("stdin");
    expect(plan.args).toContain("--input-format");
    expect(plan.args).not.toContain(plan.prompt);
    expect(plan.prompt).not.toContain("# Berdloop worker");
  });

  test("an agent is trusted to run its own checks by default", () => {
    const plan = planLaunch(input);
    const mode = plan.args[plan.args.indexOf("--permission-mode") + 1];
    expect(mode).toBe("bypassPermissions");

    // The tighter setting is available, and is what it says it is.
    const careful = planLaunch({ ...input, trust: "workspace" });
    expect(careful.args[careful.args.indexOf("--permission-mode") + 1]).toBe(
      "acceptEdits",
    );
  });

  test("Codex is given its own sandbox rather than a blunt override", () => {
    const careful = planLaunch({
      ...input,
      harness: "codex",
      trust: "workspace",
    });
    expect(careful.args).toContain("workspace-write");
    expect(careful.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );

    const full = planLaunch({ ...input, harness: "codex" });
    expect(full.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("nothing of the user's is loaded unless they turned it on", () => {
    // Measured on a real machine: an un-isolated worker inherited nine MCP
    // servers, Gmail and Google Drive among them, while running with
    // permissions bypassed.
    const plan = planLaunch(input);
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.args).toContain("--disable-slash-commands");
    expect(plan.args[plan.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(plan.args).not.toContain("--mcp-config");

    const codex = planLaunch({ ...input, harness: "codex" });
    expect(codex.args).toContain("mcp_servers={}");
    expect(codex.args).toContain("skills={}");
  });

  test("a person can hand specific extensions back", () => {
    const plan = planLaunch({
      ...input,
      extensions: {
        mcpConfig: "/berdloop/mcp.json",
        settingSources: ["project"],
        userSkills: true,
        pluginDirs: ["/berdloop/plugins/a"],
      },
    });
    expect(plan.args[plan.args.indexOf("--mcp-config") + 1]).toBe(
      "/berdloop/mcp.json",
    );
    expect(plan.args[plan.args.indexOf("--setting-sources") + 1]).toBe(
      "project",
    );
    expect(plan.args[plan.args.indexOf("--plugin-dir") + 1]).toBe(
      "/berdloop/plugins/a",
    );
    // Skills stay on, but MCP is still limited to what was handed over.
    expect(plan.args).not.toContain("--disable-slash-commands");
    expect(plan.args).toContain("--strict-mcp-config");
  });

  test("a low-trust worker can still reach its own tools", () => {
    // Denying every command would shut the escape hatch as well: the worker
    // could not merge, and could not even ask a person for approval.
    const plan = planLaunch({
      ...input,
      trust: "workspace",
      binary: "/opt/bw",
    });
    expect(plan.args[plan.args.indexOf("--allowed-tools") + 1]).toBe(
      "Bash(/opt/bw:*)",
    );

    // At full trust nothing needs allowing, because nothing is denied.
    expect(planLaunch(input).args).not.toContain("--allowed-tools");
  });

  test("Codex is given a configuration home of ours", () => {
    const plan = planLaunch({
      ...input,
      harness: "codex",
      home: "/berdloop/harness/codex",
    });
    expect(plan.env).toEqual({ CODEX_HOME: "/berdloop/harness/codex" });
    // The config overrides stay as well, so isolation does not depend on the
    // home being supplied.
    expect(plan.args).toContain("mcp_servers={}");
  });

  test("Claude Code needs no separate home, because its flags do the work", () => {
    // Its own config directory holds the credentials, so moving it would cost
    // the subscription login.
    expect(planLaunch(input).env).toEqual({});
  });

  test("Claude Code is steered down its own standard input", () => {
    expect(planLaunch(input).steering).toEqual({ via: "stdin" });
  });

  test("Codex is steered by a separate command naming the thread", () => {
    const plan = planLaunch({ ...input, harness: "codex" });
    expect(plan.delivery).toBe("argv");
    expect(plan.steering).toEqual({
      via: "command",
      program: "codex",
      args: ["queue", "--thread", "{session}", "--message", "{message}"],
    });
  });

  test("an agent is given the tools for its role", () => {
    const plan = planLaunch({ ...input, role: "task-agent" });
    expect(plan.system).toContain("task_steer");
    expect(plan.system).not.toContain("merge_land");
  });

  test("messages sent while queued arrive with the brief", () => {
    const plan = planLaunch({
      ...input,
      pending: ["the API moved to /v2", "skip the migration"],
    });
    expect(plan.prompt).toContain("Since this task was written");
    expect(plan.prompt).toContain("the API moved to /v2");
    expect(plan.prompt).toContain("skip the migration");
  });

  test("Codex puts everything in the one prompt it accepts", () => {
    const plan = planLaunch({ ...input, harness: "codex" });
    expect(plan.program).toBe("codex");
    expect(plan.args[0]).toBe("exec");
    expect(plan.args).toContain("--json");
    expect(plan.system).toBe("");
    expect(plan.prompt).toContain("# Berdloop worker");
    expect(plan.prompt).toContain("Add the invite endpoint");
  });

  test("resuming replaces the chosen session id", () => {
    const plan = planLaunch({ ...input, sessionId: "fixed-id", resume: "old" });
    expect(plan.args).not.toContain("--session-id");
    expect(plan.args[plan.args.indexOf("--resume") + 1]).toBe("old");

    const codex = planLaunch({
      ...input,
      harness: "codex",
      resume: "thread-9",
    });
    expect(codex.args.slice(0, 3)).toEqual(["exec", "resume", "thread-9"]);
    // The prompt stays last, after whatever sandbox flags were added.
    expect(codex.args.at(-1)).toBe(codex.prompt);
  });

  test("a worker always runs in its own worktree", () => {
    expect(planLaunch(input).cwd).toBe("/work/task-a");
    expect(planLaunch({ ...input, harness: "codex" }).cwd).toBe("/work/task-a");
  });

  test("both harnesses receive the same task", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      const plan = planLaunch({ ...input, harness });
      expect(plan.prompt).toContain("POST /invites");
      expect(plan.prompt).toContain("ENG-42");
    }
  });
});

describe("renderTools", () => {
  test("a different call style changes only the call line", () => {
    const rendered = renderTools(berdloopTools, (tool) => `mcp:${tool.name}`);
    expect(rendered).toContain("mcp:merge_request");
    expect(rendered).not.toContain("berdloop-worker merge-request");
    // The tool names and guidance are untouched.
    expect(rendered).toContain("Ask for a place in the merge queue.");
  });

  test("the shell form names every required argument", () => {
    const report = berdloopTools.find((tool) => tool.name === "task_report")!;
    expect(shellCall(report)).toBe(
      "berdloop-worker task-report --task <task> --status <status> --detail <detail>",
    );
  });
});

describe("per-worker runtime", () => {
  // Several workers share one machine. Ports and connection strings reach the
  // agent's own process, not only the worktree's env file, so a command the
  // agent types by hand still lands on its own port and its own database.
  const runtime = {
    PORT: "41060",
    DATABASE_URL: "postgres://localhost/app_wt3",
  };

  for (const harness of ["claude-code", "codex"] as const) {
    test(`${harness} runs with this worker's own ports and database`, () => {
      const plan = planConversation({
        harness,
        role: "worker",
        cwd: "/work/t1",
        prompt: "Task",
        runtime,
      });
      expect(plan.env.PORT).toBe("41060");
      expect(plan.env.DATABASE_URL).toBe("postgres://localhost/app_wt3");
    });
  }

  test("a project with no .berd/ setup adds nothing to the environment", () => {
    const plan = planConversation({
      harness: "claude-code",
      role: "worker",
      cwd: "/work/t1",
      prompt: "Task",
    });
    expect(plan.env).toEqual({});
  });

  test("a private harness home is kept alongside the worker's ports", () => {
    const plan = planConversation({
      harness: "codex",
      role: "worker",
      cwd: "/work/t1",
      prompt: "Task",
      home: "/private/codex",
      runtime,
    });
    expect(plan.env.CODEX_HOME).toBe("/private/codex");
    expect(plan.env.PORT).toBe("41060");
  });
});
