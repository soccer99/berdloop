/**
 * The tools a Berdloop worker may call, declared once.
 *
 * The declaration is deliberately separate from the way a harness is given
 * it. Claude Code, Codex and anything else each learn about these tools
 * through their own adapter in `harness.ts`, but the list itself never
 * changes between them. Add a tool here and every harness gains it.
 */

export interface ToolArg {
  name: string;
  required: boolean;
  description: string;
}

/**
 * Berdloop runs three kinds of agent, each steering the one below it.
 *
 * - `ticket-agent` sits above the ticket queue. One per project.
 * - `task-agent` sits above one ticket's task queue. One per ticket.
 * - `worker` does one task in its own worktree. Many at a time.
 *
 * An agent is given the tools for its own role and no others, so a worker
 * cannot reorder the ticket queue and a ticket agent cannot merge code.
 */
export type AgentRole = "ticket-agent" | "task-agent" | "worker";

export interface ToolSpec {
  /** Called exactly this, in every harness. */
  name: string;
  summary: string;
  args: ToolArg[];
  /** When the agent should reach for it. */
  use: string;
  /** Which roles are given this tool. */
  roles: AgentRole[];
}

/**
 * Every call carries the task id, because a worker is one of several and the
 * app has no other way to tell them apart.
 */
const TASK_ARG: ToolArg = {
  name: "task",
  required: true,
  description: "The id of the task you were given in your brief.",
};

const TICKET_ARG: ToolArg = {
  name: "ticket",
  required: true,
  description: "The ticket key, for example ENG-42.",
};

/**
 * Steering is one idea applied twice: a ticket agent steers task agents, and
 * a task agent steers workers.
 *
 * The target may be running or still queued. A running agent is interrupted
 * with the message; a queued one has the message folded into the prompt it
 * has not been given yet. The caller does not have to know which, because a
 * queue position is not a stable thing to reason about.
 */
export const berdloopTools: ToolSpec[] = [
  {
    name: "merge_request",
    roles: ["worker"],
    summary: "Ask for a place in the merge queue.",
    args: [TASK_ARG],
    use: "Call this when your work is committed and you are ready to merge. It answers with your position. Position 0 means it is your turn now.",
  },
  {
    name: "merge_wait",
    roles: ["worker"],
    summary: "Wait until it is your turn to merge.",
    args: [TASK_ARG],
    use: "Call this after merge_request when your position was not 0. It returns once the queue reaches you. Do not merge before it returns.",
  },
  {
    name: "merge_sync",
    roles: ["worker"],
    summary: "Bring the ticket branch into your worktree.",
    args: [TASK_ARG],
    use: "The first thing you do on your turn. It answers with the list of conflicted files, which will be empty when the merge was clean.",
  },
  {
    name: "merge_land",
    roles: ["worker"],
    summary: "Move the ticket branch onto your finished work.",
    args: [TASK_ARG],
    use: "Call this once merge_sync is clean and everything is committed. It refuses if the ticket moved, in which case run merge_sync again.",
  },
  {
    name: "merge_release",
    roles: ["worker"],
    summary: "Give up your place in the merge queue.",
    args: [TASK_ARG],
    use: "Always call this when you are finished merging, and also if you give up. The workers behind you cannot move until you do.",
  },
  {
    name: "ask_human",
    roles: ["worker"],
    summary: "Ask a person a question and wait for the answer.",
    args: [
      TASK_ARG,
      {
        name: "question",
        required: true,
        description:
          "What you need to know. Say what you will do with each answer.",
      },
      {
        name: "command",
        required: false,
        description:
          "The exact command you want to run. Including it turns the question into an approval, so the person can simply allow or refuse it.",
      },
    ],
    use: "Use it when a command is refused, when you would have to undo somebody else's work, or when the task could reasonably be finished two different ways. It waits, so only ask when you cannot decide alone.",
  },
  {
    name: "task_report",
    roles: ["worker"],
    summary: "Record the outcome of your task.",
    args: [
      TASK_ARG,
      {
        name: "status",
        required: true,
        description: "One of: complete, blocked.",
      },
      {
        name: "detail",
        required: true,
        description:
          "What you did, and the check you ran that proves the criteria are met. If blocked, what stopped you.",
      },
    ],
    use: "The last thing you do, whatever the outcome.",
  },

  // ---- task agent: owns one ticket's task queue and its workers ----
  {
    name: "task_add",
    roles: ["task-agent"],
    summary: "Add a task to this ticket's queue.",
    args: [
      {
        name: "title",
        required: true,
        description: "Short name for the task.",
      },
      {
        name: "criteria",
        required: true,
        description:
          "What must be true for the task to be done. Name a check that proves it.",
      },
      {
        name: "after",
        required: false,
        description: "Task ids this one must wait for, separated by commas.",
      },
    ],
    use: "Split the ticket into work a single fresh agent can finish. Smaller is better: a worker starts with no memory.",
  },
  {
    name: "task_edit",
    roles: ["task-agent"],
    summary: "Change a task that has not finished.",
    args: [
      { name: "task", required: true, description: "The task id." },
      { name: "title", required: false, description: "New name." },
      {
        name: "criteria",
        required: false,
        description: "New acceptance criteria.",
      },
    ],
    use: "Use it when the ticket's requirements change, or when a worker reports the task was wrongly framed.",
  },
  {
    name: "task_remove",
    roles: ["task-agent"],
    summary: "Drop a task from the queue.",
    args: [{ name: "task", required: true, description: "The task id." }],
    use: "Only for work that is no longer wanted. A task another task waits for cannot be dropped until those are dropped too.",
  },
  {
    name: "task_reorder",
    roles: ["task-agent"],
    summary: "Set the order queued tasks are picked up in.",
    args: [
      TICKET_ARG,
      {
        name: "order",
        required: true,
        description:
          "Task ids in the order you want them, separated by commas.",
      },
    ],
    use: "Order decides what a free worker takes next. It never overrides a dependency.",
  },
  {
    name: "task_steer",
    roles: ["task-agent"],
    summary: "Send an instruction to workers on this ticket.",
    args: [
      {
        name: "task",
        required: false,
        description:
          "A single task id. Leave it out to reach every worker on this ticket.",
      },
      {
        name: "message",
        required: true,
        description: "What the worker should know or do.",
      },
    ],
    use: "A working agent receives it mid-task. A queued task has it folded into the prompt it has not been given yet, so nothing is lost either way.",
  },
  {
    name: "task_stop",
    roles: ["task-agent"],
    summary: "Stop a worker.",
    args: [
      { name: "task", required: true, description: "The task id." },
      {
        name: "reason",
        required: true,
        description: "Why it is being stopped.",
      },
    ],
    use: "The task returns to the queue. Anything the worker committed is kept; its merge queue place is given up.",
  },

  {
    name: "queue_show",
    roles: ["ticket-agent", "task-agent"],
    summary: "Read a waiting line as it stands on disk.",
    args: [
      {
        name: "kind",
        required: true,
        description: "One of: ticket, agent-task, worker.",
      },
      {
        name: "ticket",
        required: false,
        description:
          "Which ticket's line, for agent-task and worker. Leave it out for the ticket queue.",
      },
    ],
    use: "Read the line before you reorder it. Other agents change it while you work, so what you were told at the start may be out of date.",
  },

  // ---- ticket agent: owns the ticket queue ----
  {
    name: "ticket_add",
    roles: ["ticket-agent"],
    summary: "Put a ticket on the queue.",
    args: [
      {
        name: "title",
        required: true,
        description: "Short name for the ticket.",
      },
      {
        name: "requirements",
        required: true,
        description: "What the finished ticket must do.",
      },
    ],
    use: "For work that did not come from Jira, Linear or Asana.",
  },
  {
    name: "ticket_remove",
    roles: ["ticket-agent"],
    summary: "Take a ticket off the queue.",
    args: [TICKET_ARG],
    use: "Stops its workers and drops its tasks. The branch is kept, so nothing committed is lost.",
  },
  {
    name: "ticket_reorder",
    roles: ["ticket-agent"],
    summary: "Set the order tickets are started in.",
    args: [
      {
        name: "order",
        required: true,
        description:
          "Ticket keys in the order you want them, separated by commas.",
      },
    ],
    use: "Only affects tickets that have not started.",
  },
  {
    name: "ticket_requirements",
    roles: ["ticket-agent"],
    summary: "Change what a ticket must achieve.",
    args: [
      TICKET_ARG,
      {
        name: "requirements",
        required: true,
        description: "The new requirements, in full.",
      },
    ],
    use: "This reaches every task agent and every queued task for the ticket, so work already in flight learns about the change. Follow it with ticket_replan if the task list itself needs rethinking.",
  },
  {
    name: "ticket_pause",
    roles: ["ticket-agent"],
    summary: "Stop giving out new work for a ticket.",
    args: [TICKET_ARG],
    use: "Workers already running are left to finish. Use it when a ticket needs a decision before more work starts.",
  },
  {
    name: "ticket_resume",
    roles: ["ticket-agent"],
    summary: "Start giving out work for a ticket again.",
    args: [TICKET_ARG],
    use: "The queue picks up where it stopped.",
  },
  {
    name: "ticket_replan",
    roles: ["ticket-agent"],
    summary: "Ask a ticket's task agent to rework its task list.",
    args: [
      TICKET_ARG,
      {
        name: "message",
        required: true,
        description: "What changed, and what you want done about it.",
      },
    ],
    use: "The task agent wakes with the ticket in front of it and changes its own queue. Use this rather than editing tasks yourself; the task agent knows what is already running.",
  },
];

/** The tools one role is given. */
export function toolsFor(
  role: AgentRole,
  tools: ToolSpec[] = berdloopTools,
): ToolSpec[] {
  return tools.filter((tool) => tool.roles.includes(role));
}

/** Write the tool list as instructions an agent can follow. */
export function renderTools(
  tools: ToolSpec[] = berdloopTools,
  call: (tool: ToolSpec) => string = shellCall,
): string {
  return tools
    .map((tool) => {
      const args = tool.args
        .map(
          (arg) =>
            `  - ${arg.name}${arg.required ? "" : " (optional)"}: ${arg.description}`,
        )
        .join("\n");
      return `### ${tool.name}\n${tool.summary}\n${tool.use}\n\nArguments:\n${args}\n\nCall it with:\n\`${call(tool)}\``;
    })
    .join("\n\n");
}

/**
 * The default way to call a tool: a command line.
 *
 * Every coding harness can run a shell command, so this needs no per-harness
 * setup at all. A harness with a richer tool channel can swap this out
 * without the tool list changing.
 *
 * `binary` should be an absolute path. Harnesses run their shell from a saved
 * snapshot that rebuilds PATH from the user's own startup files, so a bare
 * name is not reliably found. A worker that cannot find this command commits
 * its work and then silently never merges it.
 */
export function shellCallWith(binary: string) {
  return (tool: ToolSpec): string => {
    const args = tool.args
      .map((arg) =>
        arg.required
          ? `--${arg.name} <${arg.name}>`
          : `[--${arg.name} <${arg.name}>]`,
      )
      .join(" ");
    return `${binary} ${tool.name.replace(/_/g, "-")} ${args}`.trim();
  };
}

export const WORKER_COMMAND = "berdloop-worker";

export function shellCall(tool: ToolSpec): string {
  const args = tool.args
    .map((arg) =>
      arg.required
        ? `--${arg.name} <${arg.name}>`
        : `[--${arg.name} <${arg.name}>]`,
    )
    .join(" ");
  return `berdloop-worker ${tool.name.replace(/_/g, "-")} ${args}`.trim();
}
