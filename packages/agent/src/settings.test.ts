import { describe, expect, test } from "bun:test";
import {
  defaultHarnessSettings,
  toExtensions,
  willNeedApproval,
} from "./settings";
import { planLaunch } from "./harness";
import type { AgentTask, Task } from "@berdloop/core";

const ticket: Task = {
  id: "tk",
  projectId: "p",
  title: "t",
  source: "Local",
  ticket: "T-1",
  stage: "Engineer",
  status: "running",
  criteria: "c",
};
const task: AgentTask = {
  id: "t1",
  parentTaskId: "tk",
  title: "task",
  criteria: "do it",
  status: "ready",
  dependencyIds: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const base = {
  ticket,
  task,
  siblings: [task],
  worktree: "/w",
  harness: "claude-code" as const,
};

describe("harness settings", () => {
  test("nothing is trusted or loaded until a person says so", () => {
    const settings = defaultHarnessSettings();
    expect(settings.trust).toBe("full");
    expect(settings.mcpServers).toEqual([]);
    expect(settings.userSkills).toBe(false);

    const extras = toExtensions(settings, "/tmp/mcp.json");
    // A config path is pointless when no server was turned on.
    expect(extras.mcpConfig).toBeUndefined();
    expect(extras.userSkills).toBe(false);
    expect(extras.settingSources).toEqual([]);
  });

  test("an enabled server reaches the launch plan", () => {
    const settings = {
      ...defaultHarnessSettings(),
      mcpServers: ["perplexity"],
    };
    const plan = planLaunch({
      ...base,
      extensions: toExtensions(settings, "/tmp/mcp.json"),
    });
    expect(plan.args[plan.args.indexOf("--mcp-config") + 1]).toBe(
      "/tmp/mcp.json",
    );
    // Still strict: only the ones handed over.
    expect(plan.args).toContain("--strict-mcp-config");
  });

  test("turning skills on removes the switch that disabled them", () => {
    const plan = planLaunch({
      ...base,
      extensions: toExtensions({
        ...defaultHarnessSettings(),
        userSkills: true,
      }),
    });
    expect(plan.args).not.toContain("--disable-slash-commands");
  });

  test("lowering trust changes what the agent may do unattended", () => {
    const careful = {
      ...defaultHarnessSettings(),
      trust: "workspace" as const,
    };
    expect(willNeedApproval(careful)).toBe(true);
    expect(willNeedApproval(defaultHarnessSettings())).toBe(false);

    const plan = planLaunch({ ...base, trust: careful.trust });
    expect(plan.args[plan.args.indexOf("--permission-mode") + 1]).toBe(
      "acceptEdits",
    );

    const codex = planLaunch({
      ...base,
      harness: "codex",
      trust: careful.trust,
    });
    expect(codex.args).toContain("workspace-write");
  });
});
