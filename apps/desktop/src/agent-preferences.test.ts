import { describe, expect, test } from "bun:test";
import {
  emptyAgentPreferences,
  patchIntegration,
  resolveIntegration,
  type AgentPreferences,
} from "./agent-preferences";

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
