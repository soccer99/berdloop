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
}

export const emptyAgentPreferences: AgentPreferences = {
  organizations: {},
  projects: {},
  ticketSources: { organizations: {}, projects: {} },
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
