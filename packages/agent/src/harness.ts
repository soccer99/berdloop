import { buildTaskBrief, type BriefInput } from "./brief";
import { forRole, renderRules, renderSkills, rules, skills } from "./rules";
import {
  berdloopTools,
  renderTools,
  shellCallWith,
  toolsFor,
  WORKER_COMMAND,
  type AgentRole,
  type ToolSpec,
} from "./tools";

/**
 * Starting a worker, without caring which CLI it is.
 *
 * A harness differs from another in three ways only: the program name, the
 * flags that make it run headless, and where stable instructions go. Those
 * three facts live in the adapters below. Everything else, the rules, the
 * skills, the tool list and the task brief, is shared.
 *
 * To support another CLI, add one adapter. Nothing else changes.
 */

export type HarnessId = "claude-code" | "codex";

export interface LaunchInput extends BriefInput {
  harness: HarnessId;
  trust?: Trust;
  binary?: string;
  extensions?: Extensions;
  home?: string;
  /** Which agent this is. Decides the tools it is given. */
  role?: AgentRole;
  /**
   * Fixed session id, where the harness lets us choose one. This is what
   * keeps a run started in Berdloop resumable from the user's own terminal.
   */
  sessionId?: string;
  /** Continue an existing session instead of starting a new one. */
  resume?: string;
  tools?: ToolSpec[];
}

/**
 * How to reach a conversation that is already running.
 *
 * Claude Code reads new messages from its own standard input, so the process
 * handle is the channel. Codex takes them from any process at all. Both are
 * described here rather than branched on later.
 */
export type Steering =
  { via: "stdin" } | { via: "command"; program: string; args: string[] };

/** Placeholders a caller substitutes in a steering command. */
export const SESSION_TOKEN = "{session}";
export const MESSAGE_TOKEN = "{message}";

export interface LaunchPlan {
  program: string;
  args: string[];
  /** Where the first prompt goes. */
  delivery: "argv" | "stdin";
  /** How to interrupt this agent once it is running. */
  steering: Steering;
  /** Environment the agent runs with, on top of the app's own. */
  env: Record<string, string>;
  /** Directory the worker runs in. Its own worktree, always. */
  cwd: string;
  /**
   * Stable instructions: rules, skills and tools. Identical for every task,
   * so a harness that can carry them outside the prompt should.
   */
  system: string;
  /** What this one worker has been asked to do. */
  prompt: string;
}

/** The part of the briefing that never changes between tasks. */
export function standingOrders(
  role: AgentRole = "worker",
  tools: ToolSpec[] = toolsFor(role),
  /** Absolute path to the berdloop-worker command, where it is known. */
  binary: string = WORKER_COMMAND,
): string {
  const title = {
    "ticket-agent": "Berdloop ticket agent",
    "task-agent": "Berdloop task agent",
    worker: "Berdloop worker",
    "pr-code-review": "Berdloop PR code review agent",
  }[role];
  return [
    `# ${title}`,
    "",
    renderRules(forRole(rules, role)),
    "",
    "## Tools",
    "Call these by running the command shown.",
    "",
    renderTools(tools, shellCallWith(binary)),
    "",
    "## What to do when",
    "",
    renderSkills(forRole(skills, role)),
  ].join("\n");
}

/**
 * A harness that has nowhere to put standing orders other than the prompt.
 * Correct everywhere, so it is the fallback.
 */
function inPrompt(plan: LaunchPlan): LaunchPlan {
  return {
    ...plan,
    prompt: `${plan.system}\n\n---\n\n${plan.prompt}`,
    system: "",
  };
}

/**
 * How much an agent is allowed to do without being asked.
 *
 * A worktree separates edits; it does not sandbox commands. `"workspace"` asks
 * the harness for the tightest real sandbox it has. `"full"` turns that off,
 * which a worker generally needs in order to run a build and commit, and which
 * is only reasonable because it is confined to its own worktree.
 */
export type Trust = "workspace" | "full";

/**
 * What an agent is allowed to load besides what Berdloop gives it.
 *
 * Nothing, by default. A worker runs with permissions bypassed, so anything
 * the user happens to have configured globally would run unattended inside
 * their repository: their MCP servers, their skills, their hooks. Measured on
 * one real machine, an un-isolated worker inherited nine MCP servers,
 * including Gmail and Google Drive, and a hundred and thirty three skills.
 *
 * Berdloop will offer these back deliberately, one at a time, once a person
 * has turned them on.
 */
export interface Extensions {
  /** A JSON file of MCP servers Berdloop supplies. */
  mcpConfig?: string;
  /** Plugin directories Berdloop supplies. */
  pluginDirs?: string[];
  /** Which of the user's setting layers to allow. None by default. */
  settingSources?: ("user" | "project" | "local")[];
  /** Let the user's own skills resolve. Off by default. */
  userSkills?: boolean;
}

export interface ConversationInput {
  harness: HarnessId;
  role: AgentRole;
  /** Where the agent runs. A worker's worktree, or the project for the others. */
  cwd: string;
  /** The first thing said to it. */
  prompt: string;
  sessionId?: string;
  resume?: string;
  tools?: ToolSpec[];
  /**
   * The ports and connection strings this worker was given, from
   * `.berd/config.json`. Empty for a project that has no `.berd/`.
   *
   * It goes into the agent's own process, not only into the worktree's env
   * file, so that a command the agent runs by hand still lands on this
   * worker's own ports and its own database.
   */
  runtime?: Record<string, string>;
  /** Defaults to `"full"`: an agent that cannot run a check cannot finish. */
  trust?: Trust;
  /** Absolute path to the berdloop-worker command. */
  binary?: string;
  /** The task being worked on. Needed to route approval prompts to its chat. */
  taskId?: string;
  /** What else the agent may load. Nothing, unless a person said so. */
  extensions?: Extensions;
  /**
   * Whether the beta features are on, which decides whether this agent is
   * given the `decide` tool.
   */
  beta?: boolean;
  /**
   * A private configuration directory for the harness, owned by Berdloop.
   *
   * Codex reads everything from one home, so pointing it at a directory of
   * ours is the cleanest isolation there is: its own config, its own skills,
   * its own plugins, none of them the user's.
   */
  home?: string;
}

/**
 * Start a conversation with any agent.
 *
 * A ticket agent and a task agent are conversations, not task workers: they
 * are told who they are and then talked to. A worker is the same thing with a
 * task brief as its opening message, which is what `planLaunch` builds.
 */
export function planConversation(input: ConversationInput): LaunchPlan {
  const system = standingOrders(
    input.role,
    input.tools ?? toolsFor(input.role, berdloopTools, input.beta),
    input.binary,
  );
  const trust = input.trust ?? "full";
  const extras = input.extensions ?? {};
  const base: LaunchPlan = {
    program: "",
    args: [],
    cwd: input.cwd,
    delivery: "argv",
    steering: { via: "stdin" },
    env: { ...(input.runtime ?? {}) },
    system,
    prompt: input.prompt,
  };

  if (input.harness === "codex") {
    // Codex takes one prompt, so the standing orders ride along with it.
    const merged = inPrompt(base);
    const args = ["exec"];
    if (input.resume) args.push("resume", input.resume);
    args.push(
      // Codex has a real sandbox, so the tighter setting is a genuine one.
      ...(trust === "workspace"
        ? ["--sandbox", "workspace-write"]
        : ["--dangerously-bypass-approvals-and-sandbox"]),
      // Belt and braces alongside the private home below, and the whole of
      // the isolation when no home was supplied.
      ...(extras.mcpConfig ? [] : ["-c", "mcp_servers={}"]),
      ...(extras.userSkills ? [] : ["-c", "skills={}"]),
      "--json",
      merged.prompt,
    );
    return {
      ...merged,
      program: "codex",
      args,
      // Codex takes new messages from any process, addressed by thread id.
      steering: {
        via: "command",
        program: "codex",
        args: ["queue", "--thread", SESSION_TOKEN, "--message", MESSAGE_TOKEN],
      },
      // Codex keeps config, skills, plugins and MCP servers under one home.
      // Giving it ours leaves the user's untouched and unread.
      env: {
        ...(input.runtime ?? {}),
        ...(input.home ? { CODEX_HOME: input.home } : {}),
      },
    };
  }

  // Claude Code keeps standing orders out of the conversation, which leaves
  // more of the context window for the work itself.
  const args: string[] = [];
  if (input.resume) {
    args.push("--resume", input.resume);
  } else if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  // Load nothing of the user's unless they have turned it on.
  args.push("--setting-sources", (extras.settingSources ?? []).join(","));
  if (extras.mcpConfig) {
    args.push("--mcp-config", extras.mcpConfig);
  }
  // Strict either way: with a config it means "only these", without one it
  // means "none at all".
  args.push("--strict-mcp-config");
  if (!extras.userSkills) {
    args.push("--disable-slash-commands");
  }
  for (const dir of extras.pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }
  if (trust === "workspace") {
    const worker = input.binary ?? WORKER_COMMAND;
    // Lowering trust denies every command, which would include the worker's
    // own. Without this it could not reach the merge queue, and could not
    // even ask a person for approval: the escape hatch would be shut too.
    args.push("--allowed-tools", `Bash(${worker}:*)`);
    if (input.taskId) {
      // Hand every other command to a person instead of refusing it outright.
      // This is what makes an approval in the chat window actually run the
      // command, rather than merely telling the agent it may.
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            berdloop: {
              command: worker,
              args: ["mcp", "--task", input.taskId],
            },
          },
        }),
        "--permission-prompt-tool",
        "mcp__berdloop__approve",
      );
    }
  }
  args.push(
    "--permission-mode",
    // acceptEdits lets an agent change files but not run anything, so a worker
    // on that setting can never prove its own work. Verified by running one.
    trust === "workspace" ? "acceptEdits" : "bypassPermissions",
    "--append-system-prompt",
    system,
    "-p",
    // stream-json is refused without --verbose.
    "--verbose",
    "--output-format",
    "stream-json",
    // Reading input as a stream is what makes the conversation steerable: the
    // prompt goes in over standard input, and so does anything sent later.
    "--input-format",
    "stream-json",
  );
  return {
    ...base,
    program: "claude",
    args,
    delivery: "stdin",
    steering: { via: "stdin" },
  };
}

/** Start a worker, whose opening message is its task brief. */
export function planLaunch(input: LaunchInput): LaunchPlan {
  return planConversation({
    trust: input.trust,
    binary: input.binary,
    taskId: input.task.id,
    extensions: input.extensions,
    home: input.home,
    harness: input.harness,
    role: input.role ?? "worker",
    cwd: input.worktree,
    prompt: buildTaskBrief(input),
    sessionId: input.sessionId,
    resume: input.resume,
    tools: input.tools,
  });
}
