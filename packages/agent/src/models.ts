import type { AgentRole } from "./tools";
import type { HarnessId } from "./harness";

/**
 * Which model runs which agent.
 *
 * The choice cascades. An organisation sets a default per role, a project may
 * override it, and a single conversation may be changed by hand without
 * disturbing either. Resolution says where the answer came from, so the
 * interface can show "inherited from the organisation" rather than making a
 * person guess whether they are looking at a default or a decision.
 */

export interface ModelChoice {
  harness: HarnessId;
  /** Left out means whatever that harness is already configured to use. */
  model?: string;
}

export type ModelSource =
  "conversation" | "project" | "organization" | "built-in";

export interface ResolvedModel extends ModelChoice {
  from: ModelSource;
}

export type RoleModels = Partial<Record<AgentRole, ModelChoice>>;

export interface ModelSettings {
  /** The organisation default for each role. */
  organization: RoleModels;
  /** Per project, overriding the organisation for some roles. */
  projects: Record<string, RoleModels>;
  /** One conversation, changed by hand. Beats everything. */
  conversations: Record<string, ModelChoice>;
}

export const emptyModelSettings = (): ModelSettings => ({
  organization: {},
  projects: {},
  conversations: {},
});

/**
 * What runs each role when nobody has chosen.
 *
 * The two steering roles hold a long conversation and are worth a capable
 * model. A worker starts fresh on a small task every time.
 */
export const builtInModels: Record<AgentRole, ModelChoice> = {
  "ticket-agent": { harness: "claude-code" },
  "task-agent": { harness: "claude-code" },
  worker: { harness: "claude-code" },
  "pr-code-review": { harness: "claude-code" },
};

export interface ModelQuery {
  role: AgentRole;
  projectId?: string;
  conversationId?: string;
}

export function resolveModel(
  settings: ModelSettings,
  query: ModelQuery,
): ResolvedModel {
  const { role, projectId, conversationId } = query;

  const chosen = conversationId
    ? settings.conversations[conversationId]
    : undefined;
  if (chosen) return { ...chosen, from: "conversation" };

  const project = projectId ? settings.projects[projectId]?.[role] : undefined;
  if (project) return { ...project, from: "project" };

  const organization = settings.organization[role];
  if (organization) return { ...organization, from: "organization" };

  return { ...builtInModels[role], from: "built-in" };
}

/** Change one conversation without touching any default. */
export function setConversationModel(
  settings: ModelSettings,
  conversationId: string,
  choice: ModelChoice,
): ModelSettings {
  return {
    ...settings,
    conversations: { ...settings.conversations, [conversationId]: choice },
  };
}

/** Put a conversation back on whatever it would otherwise inherit. */
export function clearConversationModel(
  settings: ModelSettings,
  conversationId: string,
): ModelSettings {
  const conversations = { ...settings.conversations };
  delete conversations[conversationId];
  return { ...settings, conversations };
}

export function setProjectModel(
  settings: ModelSettings,
  projectId: string,
  role: AgentRole,
  choice: ModelChoice,
): ModelSettings {
  return {
    ...settings,
    projects: {
      ...settings.projects,
      [projectId]: { ...settings.projects[projectId], [role]: choice },
    },
  };
}

export function setOrganizationModel(
  settings: ModelSettings,
  role: AgentRole,
  choice: ModelChoice,
): ModelSettings {
  return {
    ...settings,
    organization: { ...settings.organization, [role]: choice },
  };
}
