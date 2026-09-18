import { describe, expect, test } from "bun:test";
import {
  emptyAgentPreferences,
  patchIntegration,
  resolveIntegration,
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

function preferences(): AgentPreferences {
  return {
    ...emptyAgentPreferences,
    integrations: { organizations: {}, projects: {} },
  };
}

describe("integration settings", () => {
  test("nothing is connected before a person says so", () => {
    expect(
      resolveIntegration(preferences(), "org", "project", "Jira"),
    ).toBeUndefined();
  });

  test("the project's connection wins over the organization's", () => {
    let settings = patchIntegration(
      preferences(),
      "organizations",
      "org",
      "Jira",
      {
        jiraSite: "https://org.atlassian.net",
        jiraEmail: "org@example.com",
        connected: true,
      },
    );
    settings = patchIntegration(settings, "projects", "project", "Jira", {
      jiraSite: "https://project.atlassian.net",
      jiraEmail: "project@example.com",
      connected: true,
    });
    expect(
      resolveIntegration(settings, "org", "project", "Jira")?.jiraSite,
    ).toBe("https://project.atlassian.net");
  });

  test("a project without its own connection falls back to the organization", () => {
    const settings = patchIntegration(
      preferences(),
      "organizations",
      "org",
      "Jira",
      { jiraSite: "https://org.atlassian.net", connected: true },
    );
    expect(
      resolveIntegration(settings, "org", "project", "Jira")?.jiraSite,
    ).toBe("https://org.atlassian.net");
  });

  test("an unrelated provider still resolves from the organization", () => {
    let settings = patchIntegration(
      preferences(),
      "organizations",
      "org",
      "Linear",
      {
        connected: true,
      },
    );
    settings = patchIntegration(settings, "organizations", "org", "Asana", {
      asanaWorkspace: "1234",
      connected: true,
    });
    settings = patchIntegration(settings, "projects", "project", "Linear", {
      connected: false,
    });
    expect(
      resolveIntegration(settings, "org", "project", "Linear")?.connected,
    ).toBe(false);
    expect(
      resolveIntegration(settings, "org", "project", "Asana")?.asanaWorkspace,
    ).toBe("1234");
  });

  test("a patch leaves every other scope and provider alone", () => {
    let settings = patchIntegration(
      preferences(),
      "organizations",
      "org",
      "Jira",
      {
        jiraSite: "https://org.atlassian.net",
        jiraEmail: "org@example.com",
        connected: true,
      },
    );
    settings = patchIntegration(settings, "organizations", "org", "Jira", {
      connected: false,
    });
    settings = patchIntegration(settings, "organizations", "other", "Jira", {
      connected: true,
    });
    const jira = resolveIntegration(settings, "org", "", "Jira");
    expect(jira?.jiraEmail).toBe("org@example.com");
    expect(jira?.connected).toBe(false);
    expect(resolveIntegration(settings, "other", "", "Jira")?.connected).toBe(
      true,
    );
  });

  test("no token is ever kept in the preferences", () => {
    const settings = patchIntegration(
      preferences(),
      "organizations",
      "org",
      "Jira",
      { jiraSite: "https://org.atlassian.net", connected: true },
    );
    expect(JSON.stringify(settings)).not.toContain("token");
  });
});
