import type { HarnessId } from "@berdloop/agent";
import type { ExternalProvider } from "@berdloop/core";

export type AgentRoleSetting =
  "ticket-agent" | "task-agent" | "worker" | "pr-code-review";

export interface RolePreference {
  /** Older saved preferences use Claude Code. */
  harness?: HarnessId;
  model?: string;
  systemPrompt?: string;
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
  { id: "pr-code-review", label: "PR code review" },
];

export function resolveRolePreference(
  preferences: AgentPreferences,
  organizationId: string,
  projectId: string,
  role: AgentRoleSetting,
): Required<RolePreference> {
  const organization = preferences.organizations[organizationId]?.[role];
  const project = preferences.projects[projectId]?.[role];
  // Harness and model form one choice: an override must not inherit a model
  // belonging to a different harness. Prompt overrides are independent.
  const choice =
    project?.harness != null || project?.model != null ? project : organization;
  return {
    harness: choice?.harness ?? "claude-code",
    model: choice?.model ?? "",
    systemPrompt: project?.systemPrompt ?? organization?.systemPrompt ?? "",
  };
}

export function patchRolePreference(
  preferences: AgentPreferences,
  scope: "projects" | "organizations",
  scopeId: string,
  role: AgentRoleSetting,
  patch: RolePreference,
): AgentPreferences {
  const roles = { ...preferences[scope][scopeId] };
  const next = Object.fromEntries(
    Object.entries({ ...roles[role], ...patch }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  if (Object.keys(next).length) roles[role] = next;
  else delete roles[role];
  return {
    ...preferences,
    [scope]: { ...preferences[scope], [scopeId]: roles },
  };
}

// One field at a time: the project's value where it filled one in, and the
// organization's everywhere else. The same merge resolveRolePreference does
// for a prompt, and the one the settings window promises when it tells a
// person a blank field falls back to the organization. Saving a project token
// writes a project entry holding nothing but `connected`, so taking that entry
// whole would drop a Jira site or an Asana workspace typed once at org scope.
export function resolveIntegration(
  preferences: AgentPreferences,
  organizationId: string,
  projectId: string,
  provider: ExternalProvider,
): IntegrationSettings | undefined {
  const integrations =
    preferences.integrations ?? emptyAgentPreferences.integrations;
  const organization = integrations.organizations[organizationId]?.[provider];
  const project = integrations.projects[projectId]?.[provider];
  if (!organization && !project) return undefined;
  const field = (read: (of?: IntegrationSettings) => string | undefined) => {
    const own = read(project);
    return own?.trim() ? own : read(organization);
  };
  return {
    jiraSite: field((of) => of?.jiraSite),
    jiraEmail: field((of) => of?.jiraEmail),
    asanaWorkspace: field((of) => of?.asanaWorkspace),
    // Whether a token was saved is not a field a person leaves blank: the
    // scope that owns the token owns the answer.
    connected: (project ?? organization)?.connected ?? false,
  };
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
