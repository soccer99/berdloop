export type AgentRoleSetting = "ticket-agent" | "task-agent" | "worker";

export interface RolePreference {
  model: string;
  systemPrompt: string;
}

// What a person tells Berdloop about one ticket provider. The access token is
// deliberately absent: it lives in a file only its owner can read, and the
// host writes `connected` back here once a token has been saved.
export interface IntegrationSettings {
  jiraSite?: string;
  jiraEmail?: string;
  asanaWorkspace?: string;
  connected: boolean;
}

export type ProviderConnections = Partial<
  Record<ExternalProvider, IntegrationSettings>
>;

export type IntegrationScope = "organizations" | "projects";

export interface AgentPreferences {
  organizations: Record<
    string,
    Partial<Record<AgentRoleSetting, RolePreference>>
  >;
  projects: Record<string, Partial<Record<AgentRoleSetting, RolePreference>>>;
  ticketSources: {
    organizations: Record<string, ExternalProvider[]>;
    projects: Record<string, ExternalProvider[]>;
  };
  integrations: {
    organizations: Record<string, ProviderConnections>;
    projects: Record<string, ProviderConnections>;
  };
}

export const emptyAgentPreferences: AgentPreferences = {
  organizations: {},
  projects: {},
  ticketSources: { organizations: {}, projects: {} },
  integrations: { organizations: {}, projects: {} },
};

export const agentRoles: { id: AgentRoleSetting; label: string }[] = [
  { id: "ticket-agent", label: "Ticket planner" },
  { id: "task-agent", label: "Task planner" },
  { id: "worker", label: "Worker" },
];

// The project's connection when the project has one for this provider, and
// the organization's otherwise. The same rule the ticket sources follow.
export function resolveIntegration(
  preferences: AgentPreferences,
  organizationId: string,
  projectId: string,
  provider: ExternalProvider,
): IntegrationSettings | undefined {
  const integrations =
    preferences.integrations ?? emptyAgentPreferences.integrations;
  return (
    integrations.projects[projectId]?.[provider] ??
    integrations.organizations[organizationId]?.[provider]
  );
}

// Change one provider's connection at one scope, leaving every other scope,
// provider and preference as it was.
export function patchIntegration(
  preferences: AgentPreferences,
  scope: IntegrationScope,
  scopeId: string,
  provider: ExternalProvider,
  patch: Partial<IntegrationSettings>,
): AgentPreferences {
  const integrations =
    preferences.integrations ?? emptyAgentPreferences.integrations;
  const scoped = integrations[scope];
  const existing = scoped[scopeId]?.[provider] ?? { connected: false };
  return {
    ...preferences,
    integrations: {
      ...integrations,
      [scope]: {
        ...scoped,
        [scopeId]: {
          ...scoped[scopeId],
          [provider]: { ...existing, ...patch },
        },
      },
    },
  };
}
import type { ExternalProvider } from "@berdloop/core";
