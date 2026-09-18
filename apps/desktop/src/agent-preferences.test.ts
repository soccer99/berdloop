import { describe, expect, test } from "bun:test";
import {
  emptyAgentPreferences,
  resolveRolePreference,
  patchRolePreference,
  type AgentPreferences,
} from "./agent-preferences";

describe("role preferences", () => {
  const preferences: AgentPreferences = {
    ...emptyAgentPreferences,
    organizations: {
      org: {
        worker: {
          harness: "codex",
          model: "org-model",
          systemPrompt: "Org rules",
        },
      },
    },
    projects: {
      project: {
        worker: {
          harness: "claude-code",
          model: "",
          systemPrompt: "Project rules",
        },
      },
    },
  };

  test("project harness and default model override the entire inherited choice", () => {
    expect(
      resolveRolePreference(preferences, "org", "project", "worker"),
    ).toEqual({
      harness: "claude-code",
      model: "",
      systemPrompt: "Project rules",
    });
    expect(
      resolveRolePreference(preferences, "org", "other", "worker").harness,
    ).toBe("codex");
    expect(
      resolveRolePreference(preferences, "org", "project", "ticket-agent")
        .harness,
    ).toBe("claude-code");
  });

  test("older preferences preserve the saved model and use the legacy harness", () => {
    const legacy: AgentPreferences = {
      ...emptyAgentPreferences,
      organizations: { org: { worker: { model: "sonnet", systemPrompt: "" } } },
    };
    const choice = resolveRolePreference(legacy, "org", "project", "worker");
    expect(choice.harness ?? "claude-code").toBe("claude-code");
    expect(choice.model).toBe("sonnet");
  });
});

test("project dropdowns inherit until overridden, and restoring inheritance follows future org changes", () => {
  let settings = patchRolePreference(
    emptyAgentPreferences,
    "organizations",
    "org",
    "worker",
    {
      harness: "codex",
      model: "org-model",
      systemPrompt: "Org rules",
    },
  );
  settings = patchRolePreference(settings, "projects", "project", "worker", {
    systemPrompt: "Project rules",
  });
  expect(resolveRolePreference(settings, "org", "project", "worker")).toEqual({
    harness: "codex",
    model: "org-model",
    systemPrompt: "Project rules",
  });
  expect(settings.projects.project.worker?.harness).toBeUndefined();
  settings = patchRolePreference(settings, "projects", "project", "worker", {
    harness: "claude-code",
    model: "sonnet",
  });
  expect(
    resolveRolePreference(settings, "org", "project", "worker").model,
  ).toBe("sonnet");
  settings = patchRolePreference(settings, "projects", "project", "worker", {
    harness: undefined,
    model: undefined,
  });
  expect(settings.projects.project.worker).toEqual({
    systemPrompt: "Project rules",
  });
  settings = patchRolePreference(settings, "organizations", "org", "worker", {
    model: "new-org-model",
  });
  expect(
    resolveRolePreference(settings, "org", "project", "worker").model,
  ).toBe("new-org-model");
  settings = patchRolePreference(settings, "projects", "project", "worker", {
    systemPrompt: undefined,
  });
  expect(settings.projects.project.worker).toBeUndefined();
});

test("PR reviewer has independent harness, model and system prompt", () => {
  const preferences = patchRolePreference(
    emptyAgentPreferences,
    "projects",
    "project",
    "pr-code-review",
    {
      harness: "codex",
      model: "review-model",
      systemPrompt: "Review public API compatibility",
    },
  );
  expect(
    resolveRolePreference(preferences, "org", "project", "pr-code-review"),
  ).toEqual({
    harness: "codex",
    model: "review-model",
    systemPrompt: "Review public API compatibility",
  });
  expect(
    resolveRolePreference(preferences, "org", "project", "worker").model,
  ).toBe("");
});
