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
export type AgentRole =
  "ticket-agent" | "task-agent" | "worker" | "pr-code-review";

export interface ToolSpec {
  /** Called exactly this, in every harness. */
  name: string;
  summary: string;
  args: ToolArg[];
  /** When the agent should reach for it. */
  use: string;
  /** Which roles are given this tool. */
  roles: AgentRole[];
  /**
   * A tool that only exists when the beta features are on.
   *
   * It is left out of the standing orders entirely when they are off, rather
   * than offered and then refused. An agent that is told about a tool will
   * use it, and a tool that answers "not enabled" is a wasted turn.
   */
  beta?: boolean;
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
/**
 * A queue and the words its agent uses for one record in it.
 *
 * The ticket agent and the task agent are the same agent pointed at different
 * queues, so their tools are written once and made twice. Only the vocabulary
 * differs: a ticket has requirements, a task has criteria.
 */
interface QueueWords {
  role: AgentRole;
  /** Prefixes every tool name: `ticket_add`, `task_add`. */
  noun: "ticket" | "task";
  /** What one record is called in prose. */
  one: string;
  /** The flag naming several records at once. */
  plural: string;
  /** What the acceptance text is called on this queue. */
  criteria: string;
  criteriaHint: string;
  /** Why somebody adds one, and what a good one looks like. */
  addUse: string;
  /** Extra arguments only this queue takes. */
  extraAdd?: ToolArg[];
}

const TICKET_QUEUE: QueueWords = {
  role: "ticket-agent",
  noun: "ticket",
  one: "ticket",
  plural: "tickets",
  criteria: "requirements",
  criteriaHint: "What the finished ticket must do.",
  addUse: "For work that did not come from Jira, Linear or Asana.",
};

const TASK_QUEUE: QueueWords = {
  role: "task-agent",
  noun: "task",
  one: "task",
  plural: "tasks",
  criteria: "criteria",
  criteriaHint:
    "What must be true for the task to be done. Name a check that proves it.",
  addUse:
    "Split the ticket into work a single fresh agent can finish. Smaller is better: a worker starts with no memory.",
  extraAdd: [
    {
      name: "after",
      required: false,
      description: "Task ids this one must wait for, separated by commas.",
    },
  ],
};

/** The six things an agent does to its queue, plus reading it. */
function queueTools(q: QueueWords): ToolSpec[] {
  const roles: AgentRole[] = [q.role];
  const id: ToolArg = {
    name: q.noun,
    required: true,
    description:
      q.noun === "ticket"
        ? "The ticket key, for example ENG-42."
        : "The task id.",
  };
  return [
    {
      name: `${q.noun}_add`,
      roles,
      summary: `Put a ${q.one} on the queue.`,
      args: [
        {
          name: "title",
          required: true,
          description: `Short name for the ${q.one}.`,
        },
        { name: q.criteria, required: true, description: q.criteriaHint },
        ...(q.extraAdd ?? []),
      ],
      use: q.addUse,
    },
    {
      name: `${q.noun}_edit`,
      roles,
      summary: `Change a ${q.one} that has not finished.`,
      args: [
        id,
        { name: "title", required: false, description: "New name." },
        {
          name: q.criteria,
          required: false,
          description: `New ${q.criteria}, in full.`,
        },
      ],
      use:
        q.noun === "ticket"
          ? "New requirements reach every task agent and every queued task for the ticket, so work already in flight learns about the change. Follow it with ticket_replan if the task list itself needs rethinking."
          : "Use it when the ticket's requirements change, or when a worker reports the task was wrongly framed.",
    },
    {
      name: `${q.noun}_remove`,
      roles,
      summary: `Drop a ${q.one} from the queue.`,
      args: [id],
      use:
        q.noun === "ticket"
          ? "Stops its workers and drops its tasks. The branch is kept, so nothing committed is lost."
          : "Only for work that is no longer wanted. A task another task waits for cannot be dropped until those are dropped too.",
    },
    {
      name: `${q.noun}_split`,
      roles,
      summary: `Replace one ${q.one} with several smaller ones.`,
      args: [
        id,
        {
          name: "parts",
          required: true,
          description: `A JSON array of at least two, each {"title": "...", "${q.criteria}": "..."}.`,
        },
      ],
      use: `The parts take the original's place in the queue, and anything that was waiting for it waits for all of them. Use it when one ${q.one} turned out to be more than one piece of work.${
        q.noun === "ticket"
          ? " A ticket whose tasks are already planned cannot be split; use ticket_replan instead."
          : ""
      }`,
    },
    {
      name: `${q.noun}_merge`,
      roles,
      summary: `Replace several ${q.plural} with one.`,
      args: [
        {
          name: q.plural,
          required: true,
          description: `Ids in the order you want them combined, separated by commas.`,
        },
        {
          name: "title",
          required: false,
          description:
            "Name for the combined record. Titles are joined if you leave it out.",
        },
        {
          name: q.criteria,
          required: false,
          description: `Combined ${q.criteria}. The originals' are joined if you leave it out.`,
        },
      ],
      use: `The result takes the earliest place of the ${q.plural} it replaces, and inherits everything they were waiting for. Use it when ${q.plural} are too small to be worth separate runs.${
        q.noun === "ticket"
          ? " Tickets whose tasks are already planned cannot be merged."
          : ""
      }`,
    },
    {
      name: `${q.noun}_reorder`,
      roles,
      summary: `Set the order ${q.plural} are picked up in.`,
      args: [
        {
          name: "order",
          required: true,
          description: `Ids in the order you want them, separated by commas. Anything left out keeps its place behind them.`,
        },
      ],
      use:
        q.noun === "ticket"
          ? "Only affects tickets that have not started."
          : "Order decides what a free worker takes next. It never overrides a dependency.",
    },
  ];
}

export const berdloopTools: ToolSpec[] = [
  {
    name: "decide",
    roles: ["ticket-agent", "task-agent", "pr-code-review"],
    beta: true,
    summary:
      "Answer typed questions about some text, fast and cheaply, with a probability on every answer.",
    args: [
      {
        name: "questions",
        required: true,
        description:
          'A JSON object of questions, keyed by an id you choose. Each is {"type": "boolean"|"choice"|"score", "instructions": "...", "criteria": ...}. Criteria for boolean is {"true": "...", "false": "..."}, for choice an object of option name to description, and for score an array of at least two rungs, lowest first. Ask as many as you like in one call; they are answered together and do not influence each other.',
      },
      {
        name: "state",
        required: false,
        description: "The text every question is asked about.",
      },
      {
        name: "state-file",
        required: false,
        description:
          "A file to read the text from instead, for anything long. Give one of state or state-file.",
      },
    ],
    use: [
      "This calls a small model that cannot write, only decide. It answers in about a tenth of a second for a fraction of a cent, so it is worth using for a judgment you would otherwise reason through yourself: which tasks depend on which, how urgent each one is, which of several buckets something falls into, whether a piece of text meets a rubric.",
      "It returns a value and a confidence from 0 to 1 for each question. The confidence is calibrated, so treat anything under 0.8 as undecided and make the call yourself.",
      "It is literal and it cannot explain itself. Keep arithmetic, counting, dates and version comparisons in your own reasoning; it is unreliable at all four. Ask one narrow question at a time rather than one broad one, and give it only text that bears on the question.",
    ].join(" "),
  },
  {
    name: "pr_review_submit",
    roles: ["pr-code-review"],
    summary: "Finish this PR review and queue any required fixes.",
    args: [
      {
        name: "head",
        required: true,
        description: "The exact published commit from your brief.",
      },
      {
        name: "summary",
        required: true,
        description: "Review result and checks performed.",
      },
      {
        name: "findings",
        required: true,
        description:
          "JSON array of actionable fixes, each with title and criteria. Use [] when no changes are needed.",
      },
    ],
    use: "Submit once after reviewing the entire PR. Findings become priority worker tasks after the review finishes. Do not edit the code yourself.",
  },
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
    name: "dev_start",
    roles: ["worker"],
    summary: "Start this project's app in your own worktree and get its URL.",
    args: [TASK_ARG],
    use: "When you need the app running to check your change. Your ports and databases are yours alone, so this never disturbs another worker or the person you are working for. Nothing is running until you call this: start it only when you actually need it, and it stops on its own once you stop using it.",
  },
  {
    name: "dev_stop",
    roles: ["worker"],
    summary: "Stop the app in your worktree.",
    args: [TASK_ARG],
    use: "When you have finished checking your change. Only a few apps may run at once across all workers, so stopping yours lets another worker start theirs.",
  },
  {
    name: "dev_status",
    roles: ["worker"],
    summary: "Show which workers have an app running.",
    args: [TASK_ARG],
    use: "When dev_start is slow, or you want to know whether yours is still up.",
  },
  {
    name: "db_reset",
    roles: ["worker"],
    summary:
      "Empty and rebuild your own databases, then run migrations and seeds.",
    args: [TASK_ARG],
    use: "When you need a clean database to test against, or your migrations have left it in a state you cannot use. It affects only your own databases. Wait for it to finish before you start the app.",
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

  // ---- task agent: steers the workers on its ticket ----
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

  // ---- ticket agent: what only a ticket can do ----
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
  ...queueTools(TICKET_QUEUE),
  ...queueTools(TASK_QUEUE),
];

/**
 * The tools one role is given.
 *
 * Beta tools are left out unless the beta is on, so an agent is never told
 * about a command that would refuse it.
 */
export function toolsFor(
  role: AgentRole,
  tools: ToolSpec[] = berdloopTools,
  beta = false,
): ToolSpec[] {
  return tools.filter(
    (tool) => tool.roles.includes(role) && (beta || !tool.beta),
  );
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
