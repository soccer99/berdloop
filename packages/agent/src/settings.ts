import type { Extensions, Trust } from "./harness";

/**
 * Agent harness settings: what every agent in this installation is allowed to
 * do, and what it is allowed to load.
 *
 * These sit at the root of the app rather than per project, because they are
 * about trusting the machine, not about one piece of work. A person turns
 * something on once and every agent gets it.
 */
export interface HarnessSettings {
  /**
   * How much an agent may do unattended.
   *
   * `"full"` is the default and what the loop needs: an agent that has to stop
   * and ask cannot finish a task. `"workspace"` asks the harness for the
   * tightest sandbox it has, which means the agent will hit things it cannot
   * do and must ask a person instead.
   */
  trust: Trust;
  /** MCP servers, by name, that agents may load. None by default. */
  mcpServers: string[];
  /**
   * Whether the user's own skills may load.
   *
   * All or nothing on purpose: the harness has one switch for skills, not one
   * per skill, so pretending otherwise in the interface would be a lie.
   */
  userSkills: boolean;
}

export const defaultHarnessSettings = (): HarnessSettings => ({
  trust: "full",
  mcpServers: [],
  userSkills: false,
});

/**
 * Turn the settings into what a launch plan needs.
 *
 * `mcpConfig` is written by the app: a file holding only the servers that were
 * turned on. Without one, `--strict-mcp-config` means none at all.
 */
export function toExtensions(
  settings: HarnessSettings,
  mcpConfigPath?: string,
): Extensions {
  return {
    // A path is only useful when something was actually enabled.
    mcpConfig: settings.mcpServers.length ? mcpConfigPath : undefined,
    userSkills: settings.userSkills,
    settingSources: [],
  };
}

/** True when an agent will have to ask a person to get anything done. */
export function willNeedApproval(settings: HarnessSettings): boolean {
  return settings.trust === "workspace";
}
