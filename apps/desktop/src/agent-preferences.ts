export type AgentRoleSetting = "ticket-agent" | "task-agent" | "worker";

export interface RolePreference {
  model: string;
  systemPrompt: string;
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
];
import type { ExternalProvider } from "@berdloop/core";
