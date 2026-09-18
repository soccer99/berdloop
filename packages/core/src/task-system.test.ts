import { describe, expect, test } from "bun:test";
import {
  addAgentTask,
  canCompleteParent,
  emptyTaskWorkspace,
  importIssue,
  setAgentTaskStatus,
  TaskRepository,
  type CloudWorkspaceStore,
  type TaskWorkspace,
  type WorkspaceStore,
} from "./index";

const issue = {
  provider: "Linear" as const,
  id: "issue-uuid",
  key: "BRD-128",
  url: "https://linear.app/example/issue/BRD-128",
  title: "Add invitations",
  description: "Owners can invite members.",
  status: "Todo",
};

describe("source issue and agent work", () => {
  test("reimport updates the provider snapshot without replacing local identity or child work", () => {
    const first = importIssue(
      emptyTaskWorkspace(),
      issue,
      "project",
      "2026-01-01",
      () => "local-1",
    );
    const withChild = addAgentTask(
      first.workspace,
      {
        parentTaskId: first.task.id,
        title: "Check roles",
        criteria: "Members cannot invite.",
        dependencyIds: [],
      },
      "2026-01-02",
      () => "child-1",
    );
    const again = importIssue(
      withChild,
      { ...issue, title: "Add invitation flow", status: "In Progress" },
      "other-project",
      "2026-01-03",
    );
    expect(again.workspace.tasks).toHaveLength(1);
    expect(again.task.id).toBe("local-1");
    expect(again.task.projectId).toBe("project");
    expect(again.task.criteria).toBe(issue.description);
    expect(again.workspace.agentTasks[0].parentTaskId).toBe("local-1");
  });

  test("Jira numeric IDs are scoped to the Cloud site", () => {
    const firstIssue = {
      ...issue,
      provider: "Jira" as const,
      id: "10001",
      key: "APP-1",
      url: "https://first.atlassian.net/browse/APP-1",
    };
    const first = importIssue(
      emptyTaskWorkspace(),
      firstIssue,
      "project",
      "2026-01-01",
      () => "first",
    );
    const second = importIssue(
      first.workspace,
      { ...firstIssue, url: "https://second.atlassian.net/browse/APP-1" },
      "project",
      "2026-01-02",
      () => "second",
    );
    expect(second.workspace.tasks.map((task) => task.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("dependencies stay under one parent and unlock in order", () => {
    const parent = importIssue(
      emptyTaskWorkspace(),
      issue,
      "project",
      "2026-01-01",
      () => "parent",
    ).workspace;
    const first = addAgentTask(
      parent,
      {
        parentTaskId: "parent",
        title: "First",
        criteria: "Done",
        dependencyIds: [],
      },
      "2026-01-02",
      () => "a",
    );
    const second = addAgentTask(
      first,
      {
        parentTaskId: "parent",
        title: "Second",
        criteria: "Done",
        dependencyIds: ["a"],
      },
      "2026-01-03",
      () => "b",
    );
    expect(second.agentTasks.map((task) => task.status)).toEqual([
      "ready",
      "queued",
    ]);
    expect(() => setAgentTaskStatus(second, "b", "running")).toThrow(
      "Complete dependencies",
    );
    expect(() =>
      addAgentTask(second, {
        parentTaskId: "parent",
        title: "Bad",
        criteria: "Done",
        dependencyIds: ["outside"],
      }),
    ).toThrow("same parent");
    const done = setAgentTaskStatus(second, "a", "complete", "2026-01-04");
    expect(done.agentTasks[1].status).toBe("ready");
    expect(canCompleteParent(done, "parent")).toBe(false);
    expect(
      canCompleteParent(setAgentTaskStatus(done, "b", "complete"), "parent"),
    ).toBe(true);
  });
});

describe("local-first persistence", () => {
  test("cloud is used only with a signed-in session and local save happens first", async () => {
    const writes: string[] = [];
    let saved: TaskWorkspace | null = null;
    const local: WorkspaceStore = {
      load: async () => saved,
      save: async (value) => {
        saved = value;
        writes.push("local");
      },
    };
    const cloud: CloudWorkspaceStore = {
      load: async () => {
        writes.push("cloud-load");
        return null;
      },
      save: async () => {
        writes.push("cloud-save");
      },
    };
    const repository = new TaskRepository(local, cloud);
    const workspace = emptyTaskWorkspace();
    await repository.load();
    await repository.save(workspace);
    expect(writes).toEqual(["local"]);
    await repository.load({ userId: "user", accessToken: "token" });
    await repository.save(workspace, { userId: "user", accessToken: "token" });
    expect(writes).toEqual(["local", "cloud-load", "local", "cloud-save"]);
  });
  test("does not send a local workspace to a different cloud account", async () => {
    const sent: string[] = [];
    let saved: TaskWorkspace = {
      ...emptyTaskWorkspace(),
      cloudUserId: "first-user",
    };
    const local: WorkspaceStore = {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    };
    const cloud: CloudWorkspaceStore = {
      load: async () => {
        sent.push("load");
        return null;
      },
      save: async () => {
        sent.push("save");
      },
    };
    const repository = new TaskRepository(local, cloud);
    const other = { userId: "second-user", accessToken: "token" };
    await expect(repository.load(other)).rejects.toThrow(
      "another cloud account",
    );
    await expect(repository.save(saved, other)).rejects.toThrow(
      "another cloud account",
    );
    expect(sent).toEqual([]);
  });
});
