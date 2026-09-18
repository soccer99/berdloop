import { describe, expect, test } from "bun:test";
import { planLaunch, standingOrders, type LaunchInput } from "./harness";
import { berdloopTools, renderTools, shellCall, toolsFor } from "./tools";
import { rules, skills } from "./rules";
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
    for (const rule of rules) expect(orders).toContain(rule.title);
    for (const skill of skills) expect(orders).toContain(skill.when);
    for (const tool of toolsFor("worker")) expect(orders).toContain(tool.name);
  });

  test("a role is never given another role's tools", () => {
    // A worker must not be able to reorder the ticket queue.
    expect(orders).not.toContain("ticket_reorder");
    expect(orders).not.toContain("task_steer");

    const ticketAgent = standingOrders("ticket-agent");
    expect(ticketAgent).toContain("ticket_requirements");
    expect(ticketAgent).not.toContain("merge_land");

    const taskAgent = standingOrders("task-agent");
    expect(taskAgent).toContain("task_steer");
    expect(taskAgent).not.toContain("ticket_pause");
  });

  test("every tool belongs to at least one role", () => {
    const covered = new Set(
      (["ticket-agent", "task-agent", "worker"] as const).flatMap((role) =>
        toolsFor(role).map((tool) => tool.name),
      ),
    );
    for (const tool of berdloopTools) expect(covered.has(tool.name)).toBe(true);
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
