import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Modal,
  MultiSelect,
  Select,
  Tabs,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import {
  IconArrowLeft,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconFileDiff,
  IconGitBranch,
  IconGripVertical,
  IconMessage,
  IconPencil,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import {
  addAgentTask,
  type AgentTask,
  type ExternalProvider,
  type Project,
  type Task,
  type TaskWorkspace,
} from "@berdloop/core";
import {
  activityLabels,
  taskActivity,
  ticketState,
  threadMessages,
  type AgentActivity,
  type MergeEntry,
  mergeIsLive,
  mergeActivity,
  type ThreadMessage,
  type WorkflowAction,
  type WorkflowRuntime,
} from "./workflow-ui";
import "./workflow.css";
import type { Runtime } from "./workflow-runtime";
import type { ConversationSnapshot } from "./conversation-routing";
import { HumanRequestCard } from "./agent-chat";
import { orderAgentTasks, orderTickets, routeSteering } from "./jev";
import { ChangesPanel } from "./changes-panel";
import { useTaskChanges } from "./use-task-changes";
import { diffFiles, stripDiffBodies } from "./diff";
import { ThreadFiles } from "./thread-files";
import type { Changes } from "./changes-panel";
import { openExternally } from "./external-link";

interface QueueProps {
  workspace: TaskWorkspace;
  projects: Project[];
  projectId: string;
  organizationId: string;
  onLinkProject: (id: string) => void;
  selectedTicketId: string;
  onSelectTicket: (id: string) => void;
  /** The ticket the loop is working on. */
  loopTicketId: string;
  onLoopTicket: (id: string) => void;
  update: (change: (current: TaskWorkspace) => TaskWorkspace) => void;
  onNewTicket: () => void;
  onImportTicket: (provider?: ExternalProvider) => void;
  onNewProject: () => void;
  canImport: boolean;
  ticketSources: ExternalProvider[];
  onConfigureSources: () => void;
  ready: boolean;
  /**
   * An opening message for the ticket agent's chat box, from picking a
   * source ticket. A new `id` writes it again, so the same ticket picked
   * twice is not silently ignored.
   */
  ticketAgentPrefill?: { id: number; text: string };
  runtime?: Runtime;
  onPrepareAgent?: () => Promise<void>;
  /** Beta: a decision model orders the queues and checks where a message goes. */
  beta?: boolean;
}

function Status({
  activity,
  label,
}: {
  activity?: AgentActivity;
  label?: string;
}) {
  return (
    <span className={`wf-status wf-status-${activity ?? "queued"}`}>
      <i />
      {label ?? (activity ? activityLabels[activity] : "Queued")}
    </span>
  );
}
/** How long a run has been going, in the shortest form that stays honest. */
function elapsed(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/**
 * When a merge attempt joined the line.
 *
 * A merge queue is read back long after the ticket closed, so anything that
 * did not happen today carries its date. A bare time would be unreadable.
 */
function mergeWhen(at: number): string {
  const when = new Date(at);
  const now = new Date();
  if (when.toDateString() === now.toDateString())
    return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toLocaleString([], {
    year: when.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
/**
 * What a worker has done so far: edits, messages, and how long it has run.
 *
 * The clock only shows while the process is alive, because a finished run has
 * no end stamp and a number that keeps climbing would be a lie.
 */
function RowStats({
  thread,
  now,
}: {
  thread?: ConversationSnapshot;
  now: number;
}) {
  const edits = thread?.edits ?? 0;
  const messages = thread?.messages.length ?? 0;
  const running = thread?.streaming ? thread.startedAt : undefined;
  if (!edits && !messages && !running) return null;
  return (
    <span className="wf-row-stats">
      {edits > 0 && (
        <span title={`${edits} file ${edits === 1 ? "edit" : "edits"}`}>
          <IconPencil size={12} />
          {edits}
        </span>
      )}
      {messages > 0 && (
        <span title={`${messages} ${messages === 1 ? "message" : "messages"}`}>
          <IconMessage size={12} />
          {messages}
        </span>
      )}
      {running && (
        <span className="wf-row-clock" title="Time running">
          <IconClock size={12} />
          {elapsed(running, now)}
        </span>
      )}
    </span>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="wf-empty">
      <IconGitBranch size={24} stroke={1.3} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
function Log({
  messages,
  streaming,
  changes,
  onOpenChanges,
}: {
  messages: ThreadMessage[];
  streaming?: boolean;
  /** The task's changes, for the line counts on the file rows. */
  changes?: Changes;
  onOpenChanges?: (path: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, streaming]);
  // A diff is read in the Changes tab, never here, so whatever an agent pasted
  // into its own text is taken out before the thread draws it and the files it
  // named become one row each. A message that was nothing but a diff keeps its
  // rows; one with neither words nor files left is not drawn at all.
  const shown = messages
    .map((message) => ({
      ...message,
      text: stripDiffBodies(message.text),
      files: diffFiles(message.text),
    }))
    .filter((message) => message.text || message.files.length);
  return (
    <div
      className="wf-log"
      ref={scroll}
      role="log"
      aria-label="Agent conversation"
      aria-live="polite"
      aria-relevant="additions text"
      onScroll={() => {
        const el = scroll.current;
        if (el)
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {shown.length === 0 && (
        <p className="wf-log-empty">
          No messages yet. Instructions and agent updates appear here.
        </p>
      )}
      {shown.map((message) => (
        <article
          className={`wf-message wf-message-${message.role}`}
          key={message.id}
        >
          <div>
            <strong>
              {message.role === "user"
                ? "You"
                : message.role === "agent"
                  ? "Agent"
                  : "Activity"}
            </strong>
            {message.at && (
              <time dateTime={new Date(message.at).toISOString()}>
                {new Date(message.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            )}
            {message.target === "all-workers" && (
              <span>To all ticket workers</span>
            )}
            {message.delivery && (
              <span>
                {message.delivery === "saved"
                  ? "Saved · not sent"
                  : message.delivery}
              </span>
            )}
          </div>
          {message.text && <p>{message.text}</p>}
          <ThreadFiles
            files={message.files}
            changes={changes}
            onOpen={onOpenChanges}
          />
        </article>
      ))}
      {streaming && (
        <div className="wf-streaming">
          <span className="connection-dot" />
          Receiving agent updates…
        </div>
      )}
    </div>
  );
}

function Composer({
  label,
  placeholder,
  connected,
  onSend,
  targets,
  inlineSend = false,
  quote,
}: {
  label: string;
  placeholder: string;
  connected: boolean;
  onSend: (text: string, target: WorkflowAction["target"]) => Promise<void>;
  targets?: { value: string; label: string }[];
  inlineSend?: boolean;
  /** Text to start a message with. A new `id` adds it to the draft. */
  quote?: { id: number; text: string };
}) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState(targets?.[0]?.value ?? "worker");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const applied = useRef(0);
  const quoted = useRef("");
  useEffect(() => {
    if (!quote || applied.current === quote.id) return;
    applied.current = quote.id;
    // Replace the quote still at the top of the draft, else add to it.
    setText((current) =>
      quoted.current && current.startsWith(quoted.current)
        ? quote.text + current.slice(quoted.current.length)
        : quote.text + current,
    );
    quoted.current = quote.text;
    input.current?.focus();
  }, [quote]);
  const sendButton = (
    <Button
      size="xs"
      type="submit"
      disabled={!text.trim()}
      loading={busy}
      rightSection={<IconArrowUp size={14} />}
    >
      {connected ? "Send" : "Save instruction"}
    </Button>
  );
  return (
    <form
      className={`wf-composer${inlineSend ? " wf-composer-inline-send" : ""}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        setError("");
        try {
          await onSend(text.trim(), target as WorkflowAction["target"]);
          setText("");
        } catch (cause) {
          setError(String(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="wf-composer-input">
        <Textarea
          ref={input}
          aria-label={label}
          placeholder={placeholder}
          autosize
          minRows={2}
          maxRows={7}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        {inlineSend && (
          <ActionIcon
            aria-label={connected ? "Send instruction" : "Save instruction"}
            title={connected ? "Send instruction" : "Save instruction"}
            size="sm"
            type="submit"
            disabled={!text.trim()}
            loading={busy}
          >
            <IconArrowUp size={16} />
          </ActionIcon>
        )}
      </div>
      {(!inlineSend || (targets?.length ?? 0) > 1) && (
        <div className="wf-composer-footer">
          {targets && targets.length > 1 ? (
            <Select
              aria-label="Send instruction to"
              data={targets}
              value={target}
              onChange={(value) => value && setTarget(value)}
              allowDeselect={false}
              size="xs"
            />
          ) : (
            <small>
              {connected
                ? "Instructions stay with this thread."
                : "Saved locally until agents are connected."}
            </small>
          )}
          {!inlineSend && sendButton}
        </div>
      )}
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function AgentConversation({
  messages,
  streaming,
  label,
  placeholder,
  connected,
  onSend,
  targets,
  inlineSend,
  quote,
  changes,
  onOpenChanges,
}: {
  messages: ThreadMessage[];
  streaming?: boolean;
  label: string;
  placeholder: string;
  connected: boolean;
  onSend: (text: string, target: WorkflowAction["target"]) => Promise<void>;
  targets?: { value: string; label: string }[];
  inlineSend?: boolean;
  /** Text to put at the top of the draft. A new id applies it again. */
  quote?: { id: number; text: string };
  /** The task's changes, for the line counts on the file rows. */
  changes?: Changes;
  onOpenChanges?: (path: string) => void;
}) {
  return (
    <>
      <Log
        messages={messages}
        streaming={streaming}
        changes={changes}
        onOpenChanges={onOpenChanges}
      />
      <Composer
        label={label}
        placeholder={placeholder}
        connected={connected}
        onSend={onSend}
        targets={targets}
        inlineSend={inlineSend}
        quote={quote}
      />
    </>
  );
}

function Coordinator({
  kind,
  scope,
  messages,
  runtime,
  threadKey,
  onSend,
  quote,
}: {
  kind: "ticket" | "planner";
  scope: string;
  messages: ThreadMessage[];
  runtime?: WorkflowRuntime;
  threadKey: string;
  onSend: (text: string, target: WorkflowAction["target"]) => Promise<void>;
  quote?: { id: number; text: string };
}) {
  const [expanded, setExpanded] = useLocalStorage({
    key: `berdloop.ui.chat-open.${threadKey}`,
    defaultValue: true,
  });
  const [height, setHeight] = useLocalStorage({
    key: `berdloop.ui.chat-height.${threadKey}`,
    defaultValue: 300,
  });
  const body = useRef<HTMLDivElement>(null);
  /** Drag the bottom edge. The 80% cap is `max-height: 80vh` in the CSS. */
  const resize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = body.current?.offsetHeight ?? height;
    const move = (e: PointerEvent) =>
      setHeight(
        Math.min(
          window.innerHeight * 0.8,
          Math.max(150, startHeight + e.clientY - startY),
        ),
      );
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  // A chat somebody folded away still has to show what was just written
  // into it, so a new quote opens it.
  useEffect(() => {
    if (quote) setExpanded(true);
  }, [quote?.id]);
  const thread = runtime?.threads[threadKey];
  const title =
    kind === "ticket" ? "Ticket agent" : "Planning & steering agent";
  return (
    <section
      className={`wf-coordinator${kind === "planner" ? " wf-coordinator-planner" : ""}`}
      aria-label={title}
    >
      <button
        className="wf-coordinator-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`chat-${threadKey}`}
      >
        <span className="wf-agent-icon">
          <IconMessage size={19} />
        </span>
        <span>
          <strong>{title}</strong>
          <small>
            {scope} ·{" "}
            {kind === "ticket"
              ? "Manage tickets and their requirements"
              : "Plan tasks and steer the workers"}
          </small>
        </span>
        <Badge
          color={thread?.streaming ? "lime" : "gray"}
          variant="light"
          size="xs"
        >
          {thread?.streaming
            ? "Working"
            : runtime?.connected
              ? "Ready"
              : "Not connected"}
        </Badge>
        {expanded ? (
          <IconChevronDown size={17} />
        ) : (
          <IconChevronRight size={17} />
        )}
      </button>
      {expanded && (
        <div
          id={`chat-${threadKey}`}
          className="wf-coordinator-body"
          ref={body}
          style={{ height }}
        >
          <AgentConversation
            messages={threadMessages(thread?.messages, messages)}
            streaming={thread?.streaming}
            quote={quote}
            label={`Message ${title}`}
            placeholder={
              kind === "ticket"
                ? "Add a ticket, change requirements, or direct a ticket’s planner…"
                : "Break down the work, reorder tasks, or give the workers new context…"
            }
            connected={!!runtime?.connected}
            inlineSend={kind === "ticket"}
            onSend={onSend}
            targets={
              kind === "planner"
                ? [
                    { value: "planner", label: "Planning agent" },
                    { value: "all-workers", label: "All ticket workers" },
                  ]
                : [{ value: "ticket-agent", label: "Ticket agent" }]
            }
          />
        </div>
      )}
      {expanded && (
        <div
          className="wf-coordinator-resize"
          onPointerDown={resize}
          role="separator"
          aria-label={`Resize ${title} panel`}
          aria-orientation="horizontal"
        />
      )}
    </section>
  );
}

export function QueueView({
  workspace,
  projects,
  projectId,
  organizationId,
  onLinkProject,
  selectedTicketId,
  onSelectTicket,
  loopTicketId,
  onLoopTicket,
  update,
  onNewTicket,
  onImportTicket,
  onNewProject,
  canImport,
  ticketSources,
  onConfigureSources,
  ready,
  ticketAgentPrefill,
  runtime,
  onPrepareAgent,
  beta = false,
}: QueueProps) {
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const dragging = useRef<{ kind: "ticket" | "task"; id: string } | null>(null);
  const threadPanel = useRef<HTMLElement>(null);
  const [step, setStep] = useState("work");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [quote, setQuote] = useState<{ id: number; text: string }>();
  // Keyed by task id, so a tab choice never leaks from the task it was made
  // on to the next one opened.
  const [taskTabs, setTaskTabs] = useState<Record<string, string>>({});
  const [editTicket, setEditTicket] = useState(false);
  const [taskEditor, setTaskEditor] = useState<AgentTask | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "ticket" | "task";
    id: string;
    title: string;
  } | null>(null);
  const [savedMessages, setSavedMessages] = useLocalStorage<
    Record<string, ThreadMessage[]>
  >({ key: "berdloop.ui.instructions.v1", defaultValue: {} });
  const [legacyNotes] = useLocalStorage<
    Record<string, { id: string; text: string; at: string }[]>
  >({ key: "berdloop.preview.notes.v1", defaultValue: {} });
  const tickets = workspace.tasks.filter(
    (ticket) =>
      projects.some((project) => project.id === ticket.projectId) &&
      (!projectId || ticket.projectId === projectId),
  );
  const ticket = tickets.find((item) => item.id === selectedTicketId);
  const project = projects.find(
    (item) => item.id === (ticket?.projectId ?? projectId),
  );
  const tasks = workspace.agentTasks.filter(
    (item) => item.parentTaskId === ticket?.id,
  );
  const selected = tasks.find((item) => item.id === selectedTaskId);
  const thread = selected ? runtime?.threads[selected.id] : undefined;
  const taskTab = selected ? (taskTabs[selected.id] ?? "thread") : "thread";
  // The detail page owns the changes, so the tab label's count, the thread and
  // the Changes tab read one value, and a shut tab does not follow the agent.
  const changes = useTaskChanges({
    projectId: ticket?.projectId ?? "",
    ticket: ticket?.ticket ?? "",
    taskId: selected?.id ?? "",
    enabled: !!thread?.worktree,
    streaming: thread?.streaming,
    messageCount: thread?.messages.length ?? 0,
    visible: taskTab === "changes",
  });
  const mergeQueue: MergeEntry[] = ticket
    ? (runtime?.mergeQueues?.[ticket.id] ??
      tasks
        .filter((item) => activityOf(item) === "waiting-to-merge")
        .map((item) => ({
          taskId: item.id,
          status: "waiting" as const,
          at: 0,
        })))
    : [];
  // Only attempts still in the line hold a queue position. The rest are the
  // ticket's merge history, which is kept and never trimmed.
  const stillWaiting = mergeQueue.filter(mergeIsLive);
  const landed = new Set(
    mergeQueue.filter((item) => item.status === "merged").map((i) => i.taskId),
  );
  const mergeHistory = mergeQueue.filter((item) => !mergeIsLive(item));
  const activityOf = (item: AgentTask) =>
    taskActivity(item, runtime?.threads[item.id], landed.has(item.id));
  const mergePosition = (taskId: string) =>
    stillWaiting.findIndex((item) => item.taskId === taskId);
  const connected = !!runtime?.connected;
  const ticketAgentKey = `ticket-agent:${projectId || `organization:${organizationId}`}`;
  const plannerKey = `planner:${ticket?.id ?? ""}`;
  const visibleTickets = tickets.filter((item) =>
    `${item.title} ${item.ticket}`.toLowerCase().includes(search.toLowerCase()),
  );
  // Only work nobody has started can be reordered.
  const queuedTickets = visibleTickets.filter(
    (item) => item.status === "queued",
  );
  const activeTasks = tasks.filter(
    (item) => !["queued", "done", "merged"].includes(activityOf(item)),
  );
  const queuedTasks = tasks.filter((item) => activityOf(item) === "queued");
  // Finished work that never landed stays visible beside what did, so a task
  // that stopped short of the merge queue cannot be mistaken for shipped.
  const doneTasks = tasks.filter((item) =>
    ["done", "merged"].includes(activityOf(item)),
  );

  useEffect(() => {
    setSelectedTaskId("");
    setStep("work");
    setNotice("");
  }, [selectedTicketId]);
  useEffect(() => {
    setSearch("");
  }, [projectId]);
  useEffect(() => {
    if (selectedTaskId && window.matchMedia("(max-width: 800px)").matches) {
      threadPanel.current?.scrollIntoView({ block: "start" });
    }
  }, [selectedTaskId, step]);

  /** What a person calls each chat, for the routing hint. */
  const chatNames: Record<string, string> = {
    "ticket-agent": "ticket agent",
    planner: "planning agent",
    "all-workers": "workers",
  };

  /**
   * Beta: check where an instruction was really aimed.
   *
   * A hint, never a redirect. The message goes where the person sent it and
   * the notice says another chat may have been meant, because sending a
   * correction to the wrong agent is a mistake nobody sees until the wrong
   * code arrives. Nothing waits on the answer, so the send is never slowed.
   */
  function checkRoute(text: string, target: WorkflowAction["target"]) {
    if (!beta || !target || !chatNames[target]) return;
    void routeSteering(text, {
      ticket: ticket?.title,
      tasks: activeTasks.map((task) => task.title),
    })
      .then((route) => {
        if (!route || route === target) return;
        setNotice(
          `Sent to the ${chatNames[target]}. That instruction reads as one for the ${chatNames[route]}.`,
        );
      })
      .catch(() => {});
  }

  async function send(
    threadKey: string,
    text: string,
    target: WorkflowAction["target"],
    taskId?: string,
  ) {
    checkRoute(text, target);
    const clientMessageId = crypto.randomUUID();
    const starting =
      connected &&
      !!project?.path &&
      !!runtime?.start &&
      !runtime.threads[threadKey]?.streaming &&
      (target === "ticket-agent" || target === "planner");
    if (starting) {
      await onPrepareAgent?.();
      await runtime!.start(
        threadKey,
        project!.path!,
        text,
        {
          organizationId,
          projectId: project!.id,
          role: target === "ticket-agent" ? "ticket-agent" : "task-agent",
          ticketId: target === "planner" ? ticket?.id : undefined,
        },
        clientMessageId,
      );
    } else if (connected)
      await runtime!.dispatch({
        kind: "message",
        organizationId,
        projectId: project?.id ?? projectId,
        ticketId: ticket?.id,
        taskId,
        target,
        text,
        clientMessageId,
      });
    // Connected histories, including user messages, come only from Rust.
    if (connected) return;
    setSavedMessages((current) => ({
      ...current,
      [threadKey]: [
        ...(current[threadKey] ?? []),
        {
          id: clientMessageId,
          role: "user",
          target,
          text,
          at: new Date().toISOString(),
          delivery: starting ? "delivered" : connected ? "pending" : "saved",
        },
      ],
    }));
  }
  async function control(kind: WorkflowAction["kind"], taskId?: string) {
    if (!connected || !ticket) return;
    try {
      await runtime!.dispatch({
        kind,
        organizationId,
        projectId: ticket.projectId,
        ticketId: ticket.id,
        taskId,
      });
      setNotice("Request sent. Waiting for the agent system to confirm.");
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  const [ordering, setOrdering] = useState(false);
  // A slow clock, only so the running times keep counting while a worker is
  // quiet. Streamed output already redraws the rows when there is any.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Beta: let a decision model put a queue in build order.
   *
   * It moves records, it never changes them. Anything the model did not rank
   * keeps the place it had, so a queue the person arranged by hand is only
   * disturbed where there was an answer to disturb it with.
   */
  async function orderQueue(kind: "ticket" | "task") {
    const list = kind === "ticket" ? queuedTickets : queuedTasks;
    if (list.length < 2 || ordering) return;
    setOrdering(true);
    setNotice("");
    try {
      const order =
        kind === "ticket"
          ? await orderTickets(list as Task[])
          : await orderAgentTasks(list as AgentTask[]);
      if (!order) {
        setNotice("The decision model had no answer. The queue is unchanged.");
        return;
      }
      const key = kind === "ticket" ? "tasks" : "agentTasks";
      const rank = new Map(order.map((id, at) => [id, at]));
      update((current) => {
        // Only the queued ones move. Their slots in the full list stay put, so
        // running and finished work is never reordered around them.
        const list = [...current[key]];
        const slots = list
          .map((item, at) => (rank.has(item.id) ? at : -1))
          .filter((at) => at >= 0);
        const moved = slots
          .map((at) => list[at]!)
          .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        slots.forEach((at, i) => {
          list[at] = moved[i]!;
        });
        return { ...current, [key]: list } as TaskWorkspace;
      });
      setNotice(
        kind === "ticket"
          ? "Tickets reordered by what each one builds on."
          : "Agent tasks reordered by urgency and what each one needs first.",
      );
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      setOrdering(false);
    }
  }

  function move(kind: "ticket" | "task", id: string, direction: number) {
    const group = kind === "ticket" ? queuedTickets : queuedTasks;
    const at = group.findIndex((item) => item.id === id);
    const other = group[at + direction];
    if (!other) return;
    update((current) => {
      if (kind === "ticket") {
        const list = [...current.tasks];
        const a = list.findIndex((item) => item.id === id),
          b = list.findIndex((item) => item.id === other.id);
        if (a < 0 || b < 0) return current;
        [list[a], list[b]] = [list[b]!, list[a]!];
        return { ...current, tasks: list };
      }
      const list = [...current.agentTasks];
      const a = list.findIndex((item) => item.id === id),
        b = list.findIndex((item) => item.id === other.id);
      if (a < 0 || b < 0) return current;
      [list[a], list[b]] = [list[b]!, list[a]!];
      return { ...current, agentTasks: list };
    });
  }
  function dropOn(kind: "ticket" | "task", targetId: string) {
    const source = dragging.current;
    dragging.current = null;
    if (!source || source.kind !== kind || source.id === targetId) return;
    update((current) => {
      const key = kind === "ticket" ? "tasks" : "agentTasks";
      const list = [...current[key]];
      const from = list.findIndex((item) => item.id === source.id);
      const to = list.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return { ...current, [key]: list } as TaskWorkspace;
    });
  }
  function remove() {
    if (!deleteTarget) return;
    if (
      deleteTarget.kind === "task" &&
      workspace.agentTasks.some((item) =>
        item.dependencyIds.includes(deleteTarget.id),
      )
    ) {
      setNotice("Remove this task from dependent tasks before deleting it.");
      setDeleteTarget(null);
      return;
    }
    update((current) =>
      deleteTarget.kind === "ticket"
        ? {
            ...current,
            tasks: current.tasks.filter((item) => item.id !== deleteTarget.id),
            agentTasks: current.agentTasks.filter(
              (item) => item.parentTaskId !== deleteTarget.id,
            ),
          }
        : {
            ...current,
            agentTasks: current.agentTasks.filter(
              (item) => item.id !== deleteTarget.id,
            ),
          },
    );
    if (deleteTarget.kind === "ticket") onSelectTicket("");
    else setSelectedTaskId("");
    setDeleteTarget(null);
  }
  function orderButtons(
    kind: "ticket" | "task",
    id: string,
    index: number,
    length: number,
  ) {
    // One control: drag the grip in the middle, or tap the arrow above or
    // below it to bump the row one place.
    return (
      <div className="wf-move">
        <button
          className="wf-move-step"
          aria-label="Move up in queue"
          title="Move up in queue"
          disabled={index === 0 || !ready}
          onClick={() => move(kind, id, -1)}
        >
          <IconChevronUp size={13} />
        </button>
        <span
          className="wf-move-grip"
          draggable={ready}
          aria-label="Drag to reorder"
          title="Drag to reorder"
          onDragStart={(event) => {
            dragging.current = { kind, id };
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);
          }}
          onDragEnd={() => {
            dragging.current = null;
          }}
        >
          <IconGripVertical size={14} />
        </span>
        <button
          className="wf-move-step"
          aria-label="Move down in queue"
          title="Move down in queue"
          disabled={index === length - 1 || !ready}
          onClick={() => move(kind, id, 1)}
        >
          <IconChevronDown size={13} />
        </button>
      </div>
    );
  }
  function taskRows(items: AgentTask[], queued = false) {
    return items.map((item, index) => {
      const currentThread = runtime?.threads[item.id];
      const activity = taskActivity(item, currentThread, landed.has(item.id));
      return (
        <div
          key={item.id}
          className={`wf-task-row ${selected?.id === item.id ? "selected" : ""}`}
          onDragOver={queued ? (event) => event.preventDefault() : undefined}
          onDrop={
            queued
              ? (event) => {
                  event.preventDefault();
                  dropOn("task", item.id);
                }
              : undefined
          }
        >
          <button
            className="wf-task-open"
            onClick={() => setSelectedTaskId(item.id)}
          >
            <div className="wf-row-top">
              <span className="wf-row-mark">
                {queued ? (
                  String(index + 1).padStart(2, "0")
                ) : (
                  <IconTerminal2 size={14} />
                )}
              </span>
              <strong>{item.title}</strong>
              <Status activity={activity} />
              {runtime?.stalled?.[item.id] && (
                <Badge size="xs" color="yellow" variant="light">
                  Going in circles
                </Badge>
              )}
            </div>
            <small>
              {currentThread?.agentId ?? item.assigneeId ?? "Unassigned"}
              {mergePosition(item.id) >= 0
                ? ` · Merge queue #${mergePosition(item.id) + 1}`
                : ""}
              <RowStats thread={currentThread} now={now} />
            </small>
            <p>
              {/* The same text as the thread, so no diff leaks through here either. */}
              {stripDiffBodies(currentThread?.messages.at(-1)?.text ?? "") ||
                (item.status === "queued" && item.dependencyIds.length
                  ? "Waiting for dependencies"
                  : queued
                    ? "Prompt ready to edit"
                    : "Open agent thread")}
            </p>
          </button>
          {queued && orderButtons("task", item.id, index, items.length)}
        </div>
      );
    });
  }

  return (
    <main className={`workflow-view ${selected ? "wf-task-page" : ""}`}>
      <div className="wf-page-heading">
        <div>
          {ticket ? (
            <button className="wf-back" onClick={() => onSelectTicket("")}>
              <IconArrowLeft size={14} />
              {project?.name ?? "All"} tickets
            </button>
          ) : null}
          <h1>{ticket ? ticket.title : "Tickets"}</h1>
          <p>
            {ticket ? (
              <>
                {ticket.source} · {ticket.ticket}{" "}
                <span className="wf-heading-status">
                  <Status
                    label={ticketState(ticket)}
                    activity={
                      ticket.status === "running"
                        ? "coding"
                        : ticket.status === "complete"
                          ? "done"
                          : ticket.status === "paused"
                            ? "paused"
                            : "queued"
                    }
                  />
                </span>
              </>
            ) : (
              "Pull in tickets, set their order, and hand them to agents."
            )}
          </p>
        </div>
        <div className="heading-actions">
          {!ticket && project && !project.path && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => onLinkProject(project.id)}
            >
              Link folder
            </Button>
          )}
          {!ticket && ticketSources.length === 0 && (
            <Button variant="subtle" size="xs" onClick={onConfigureSources}>
              Add ticket source
            </Button>
          )}
          {!ticket &&
            ticketSources.map((provider) => (
              <Button
                key={provider}
                variant="default"
                size="xs"
                disabled={!project || !canImport || !ready}
                title={
                  !canImport
                    ? "Ticket import requires the desktop app"
                    : `Pull from ${provider}`
                }
                onClick={() => onImportTicket(provider)}
              >
                {provider}
              </Button>
            ))}
          {!ticket && (
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              disabled={!ready || !projects.length}
              onClick={onNewTicket}
            >
              New ticket
            </Button>
          )}
        </div>
      </div>
      {notice && (
        <div className="wf-notice" role="status">
          {notice}
          <button aria-label="Dismiss message" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      {!ticket ? (
        <>
          <Coordinator
            key={ticketAgentKey}
            kind="ticket"
            scope={project?.name ?? "All projects"}
            threadKey={ticketAgentKey}
            quote={ticketAgentPrefill}
            runtime={runtime}
            messages={savedMessages[ticketAgentKey] ?? []}
            onSend={(text, target) => send(ticketAgentKey, text, target)}
          />
          <div className="wf-list-toolbar">
            <h2>
              Ticket queue <span>{tickets.length}</span>
            </h2>
            {beta && queuedTickets.length > 1 && (
              <Button
                size="xs"
                variant="default"
                loading={ordering}
                leftSection={<IconSparkles size={14} />}
                title="Put the queued tickets in the order their features build on each other"
                onClick={() => void orderQueue("ticket")}
              >
                Order by dependency
              </Button>
            )}
            <TextInput
              aria-label="Search tickets"
              placeholder="Find a ticket…"
              leftSection={<IconSearch size={15} />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </div>
          {!projects.length ? (
            <Empty title="Add a project to start">
              <Button variant="light" onClick={onNewProject}>
                New project
              </Button>
            </Empty>
          ) : !tickets.length ? (
            <Empty title="Your next ticket starts here">
              Create a ticket or import one from Linear. Then open it to plan
              agent tasks.
            </Empty>
          ) : !visibleTickets.length ? (
            <Empty title="No matching tickets">
              Try another title or ticket ID.
            </Empty>
          ) : (
            [
              {
                label: "Working & paused",
                items: visibleTickets.filter((item) =>
                  ["running", "paused"].includes(item.status),
                ),
              },
              {
                label: "Code review",
                items: visibleTickets.filter(
                  (item) => item.status === "review",
                ),
              },
              {
                label: "Queued tickets",
                items: visibleTickets.filter(
                  (item) => item.status === "queued",
                ),
              },
              {
                label: "Done",
                items: visibleTickets.filter(
                  (item) => item.status === "complete",
                ),
              },
            ]
              .filter((group) => group.items.length)
              .map((group) => (
                <section className="wf-ticket-group" key={group.label}>
                  <h3>
                    {group.label}
                    <span>{group.items.length}</span>
                  </h3>
                  {group.items.map((item, index) => {
                    const children = workspace.agentTasks.filter(
                      (child) => child.parentTaskId === item.id,
                    );
                    return (
                      <div
                        className={`wf-ticket-row${
                          item.id === loopTicketId ? " wf-ticket-loop" : ""
                        }`}
                        key={item.id}
                        onDragOver={
                          item.status === "queued"
                            ? (event) => event.preventDefault()
                            : undefined
                        }
                        onDrop={
                          item.status === "queued"
                            ? (event) => {
                                event.preventDefault();
                                dropOn("ticket", item.id);
                              }
                            : undefined
                        }
                      >
                        <button
                          onClick={() => onSelectTicket(item.id)}
                          className="wf-ticket-open"
                        >
                          <span className="wf-ticket-ref">{item.ticket}</span>
                          <div>
                            <strong>{item.title}</strong>
                            <small>
                              {
                                projects.find(
                                  (project) => project.id === item.projectId,
                                )?.name
                              }{" "}
                              ·{" "}
                              {
                                children.filter(
                                  (child) => child.status === "complete",
                                ).length
                              }
                              /{children.length} agent tasks done
                            </small>
                          </div>
                          <Status
                            label={ticketState(item)}
                            activity={
                              item.status === "review"
                                ? "reviewing"
                                : item.status === "running"
                                  ? "coding"
                                  : item.status === "complete"
                                    ? "done"
                                    : item.status === "paused"
                                      ? "paused"
                                      : "queued"
                            }
                          />
                          <IconChevronRight size={16} />
                        </button>
                        {item.status !== "complete" &&
                          (item.id === loopTicketId ? (
                            <span className="wf-loop-flag">
                              <IconPlayerPlay size={12} /> Loop
                            </span>
                          ) : (
                            <button
                              className="wf-loop-switch"
                              title="Point the loop at this ticket"
                              onClick={() => onLoopTicket(item.id)}
                            >
                              Work on this
                            </button>
                          ))}
                        {item.status === "queued" &&
                          orderButtons(
                            "ticket",
                            item.id,
                            index,
                            group.items.length,
                          )}
                      </div>
                    );
                  })}
                </section>
              ))
          )}
        </>
      ) : (
        <>
          <Coordinator
            key={plannerKey}
            kind="planner"
            scope={ticket.ticket}
            threadKey={plannerKey}
            runtime={runtime}
            messages={[
              ...(legacyNotes[ticket.id] ?? []).map((note) => ({
                ...note,
                role: "user" as const,
                delivery: "saved" as const,
              })),
              ...(savedMessages[plannerKey] ?? []),
            ]}
            onSend={(text, target) => send(plannerKey, text, target)}
          />
          <nav className="wf-steps" aria-label="Ticket workflow">
            {[
              ["requirements", "01", "Requirements"],
              ["work", "02", "Agent tasks"],
              ["merge", "03", "Merge queue"],
              ["review", "04", "PR & review"],
            ].map(([id, number, title]) => (
              <button
                key={id}
                onClick={() => setStep(id!)}
                aria-current={step === id ? "step" : undefined}
              >
                <span>{number}</span>
                {title}
                {id === "work" && <small>{tasks.length}</small>}
                {id === "merge" && <small>{stillWaiting.length}</small>}
              </button>
            ))}
          </nav>
          {step === "requirements" && (
            <section className="wf-panel wf-requirements">
              <div className="wf-section-heading">
                <h2>Ticket requirements</h2>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => setEditTicket(true)}
                  disabled={!ready}
                >
                  Edit requirements
                </Button>
              </div>
              <p className="wf-prewrap">
                {ticket.criteria || "No requirements yet."}
              </p>
              <div className="wf-context-note">
                Requirement changes are saved with this ticket. The ticket agent
                can pass them to its planner, active workers, and queued tasks.
              </div>
              <div className="wf-section-heading">
                <div>
                  {ticket.sourceUrl && (
                    <a
                      href={ticket.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={openExternally}
                    >
                      Open source ticket ↗
                    </a>
                  )}
                  <p className="muted">
                    {runtime?.ticketBranches?.[ticket.id]
                      ? `Ticket branch: ${runtime.ticketBranches[ticket.id]}`
                      : "Ticket branch has not been reported."}
                  </p>
                </div>
                <Button
                  color="red"
                  variant="subtle"
                  size="xs"
                  disabled={!ready || ticket.status === "running"}
                  title={
                    ticket.status === "running"
                      ? "Pause the ticket before removing it"
                      : undefined
                  }
                  leftSection={<IconTrash size={13} />}
                  onClick={() =>
                    setDeleteTarget({
                      kind: "ticket",
                      id: ticket.id,
                      title: ticket.title,
                    })
                  }
                >
                  Delete ticket
                </Button>
              </div>
            </section>
          )}
          {step === "work" && (
            <>
              <div className="wf-list-toolbar">
                <h2>
                  Agent tasks{" "}
                  <span>
                    {doneTasks.length}/{tasks.length} done
                  </span>
                </h2>
                {beta && queuedTasks.length > 1 && (
                  <Button
                    size="xs"
                    variant="default"
                    loading={ordering}
                    leftSection={<IconSparkles size={14} />}
                    title="Put the queued tasks in order of urgency and what each one needs first"
                    onClick={() => void orderQueue("task")}
                  >
                    Order by priority
                  </Button>
                )}
                <Button
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  disabled={!ready}
                  onClick={() => setTaskEditor("new")}
                >
                  Add agent task
                </Button>
              </div>
              <div className="wf-workspace">
                <div className="wf-task-list">
                  <section>
                    <h3>
                      Agent threads <span>{activeTasks.length}</span>
                    </h3>
                    {activeTasks.length ? (
                      taskRows(activeTasks)
                    ) : (
                      <p className="wf-list-empty">
                        No agents working on this ticket.
                      </p>
                    )}
                  </section>
                  <section>
                    <h3>
                      Queued agent tasks <span>{queuedTasks.length}</span>
                    </h3>
                    {queuedTasks.length ? (
                      taskRows(queuedTasks, true)
                    ) : (
                      <p className="wf-list-empty">
                        Add a task or ask the planning agent.
                      </p>
                    )}
                  </section>
                  {doneTasks.length > 0 && (
                    <details className="wf-done">
                      <summary>
                        Done <span>{doneTasks.length}</span>
                      </summary>
                      {taskRows(doneTasks)}
                    </details>
                  )}
                </div>
                <section
                  className="wf-thread-panel"
                  aria-label="Selected agent task"
                  ref={threadPanel}
                >
                  {selected ? (
                    <div key={selected.id}>
                      <button
                        className="wf-back wf-task-back"
                        onClick={() => setSelectedTaskId("")}
                      >
                        <IconArrowLeft size={14} /> {ticket.ticket} · Agent
                        tasks
                      </button>
                      <div className="wf-thread-heading">
                        <div>
                          <Status
                            activity={taskActivity(
                              selected,
                              thread,
                              landed.has(selected.id),
                            )}
                          />
                          <h2>{selected.title}</h2>
                          <small>
                            {thread?.agentId ??
                              selected.assigneeId ??
                              "No agent assigned"}
                            {thread?.branch ? ` · ${thread.branch}` : ""}
                          </small>
                        </div>
                        <Button
                          variant="subtle"
                          color="red"
                          size="xs"
                          disabled={
                            !connected ||
                            !thread ||
                            ["queued", "done", "paused"].includes(
                              thread.activity,
                            )
                          }
                          leftSection={<IconPlayerStop size={13} />}
                          onClick={() =>
                            void control("stop-agent", selected.id)
                          }
                        >
                          Stop agent
                        </Button>
                      </div>
                      <div className="wf-prompt">
                        <div className="wf-section-heading">
                          <h3>
                            {taskActivity(
                              selected,
                              thread,
                              landed.has(selected.id),
                            ) === "queued"
                              ? "Queued prompt"
                              : "Task prompt"}
                          </h3>
                          <Button
                            variant="subtle"
                            size="xs"
                            disabled={
                              !ready ||
                              !["queued", "paused", "blocked"].includes(
                                taskActivity(
                                  selected,
                                  thread,
                                  landed.has(selected.id),
                                ),
                              )
                            }
                            onClick={() => setTaskEditor(selected)}
                          >
                            Edit task & prompt
                          </Button>
                        </div>
                        <p>
                          {selected.prompt ??
                            `${selected.title}\n\n${selected.criteria}`}
                        </p>
                        {selected.dependencyIds.length > 0 && (
                          <small>
                            Depends on:{" "}
                            {selected.dependencyIds
                              .map(
                                (id) =>
                                  tasks.find((item) => item.id === id)?.title ??
                                  id,
                              )
                              .join(", ")}
                          </small>
                        )}
                      </div>
                      <Tabs
                        // Keeping the hidden panel in the tree holds its scroll
                        // and its seen marks; the fetching is the page's, not
                        // the panel's, so nothing depends on this.
                        keepMountedMode="display-none"
                        value={taskTab}
                        onChange={(value) =>
                          setTaskTabs((current) => ({
                            ...current,
                            [selected.id]: value ?? "thread",
                          }))
                        }
                      >
                        <Tabs.List>
                          <Tabs.Tab
                            value="thread"
                            leftSection={<IconMessage size={14} />}
                            rightSection={
                              thread?.streaming ? (
                                <Badge size="xs" color="lime" variant="light">
                                  Live
                                </Badge>
                              ) : undefined
                            }
                          >
                            Agent thread
                          </Tabs.Tab>
                          <Tabs.Tab
                            value="changes"
                            leftSection={<IconFileDiff size={14} />}
                            rightSection={
                              changes.data === undefined ? undefined : (
                                <Badge size="xs" color="gray" variant="light">
                                  {changes.data.files.length}
                                </Badge>
                              )
                            }
                          >
                            Changes
                          </Tabs.Tab>
                        </Tabs.List>
                        <Tabs.Panel value="thread" pt="sm">
                          {(runtime?.requests[selected.id] ?? []).map(
                            (request) => (
                              <HumanRequestCard
                                key={request.id}
                                request={request}
                                onAnswer={(id, approved, text) =>
                                  runtime!.answer(
                                    ticket.projectId,
                                    id,
                                    approved,
                                    text,
                                  )
                                }
                              />
                            ),
                          )}
                          <AgentConversation
                            messages={threadMessages(
                              thread?.messages,
                              savedMessages[selected.id],
                            )}
                            streaming={thread?.streaming}
                            label="Message task agent"
                            placeholder={
                              taskActivity(
                                selected,
                                thread,
                                landed.has(selected.id),
                              ) === "queued"
                                ? "Add context for the agent that picks up this task…"
                                : "Give this agent new context or direction…"
                            }
                            connected={connected}
                            quote={quote}
                            changes={changes.data}
                            onOpenChanges={() =>
                              setTaskTabs((current) => ({
                                ...current,
                                [selected.id]: "changes",
                              }))
                            }
                            onSend={(text, target) =>
                              send(selected.id, text, target, selected.id)
                            }
                          />
                        </Tabs.Panel>
                        <Tabs.Panel value="changes" pt="sm">
                          {thread?.worktree ? (
                            <ChangesPanel
                              taskId={selected.id}
                              changes={changes}
                              onQuote={(text) =>
                                setQuote((current) => ({
                                  id: (current?.id ?? 0) + 1,
                                  text,
                                }))
                              }
                            />
                          ) : (
                            <small>
                              No worktree yet, so there is nothing to diff.
                            </small>
                          )}
                        </Tabs.Panel>
                      </Tabs>
                      <div className="wf-thread-footer">
                        <small>
                          {thread?.worktree ??
                            (taskActivity(
                              selected,
                              thread,
                              landed.has(selected.id),
                            ) === "queued"
                              ? "Worktree assigned when work begins."
                              : "No worktree reported.")}
                        </small>
                        <Button
                          size="xs"
                          color="red"
                          variant="subtle"
                          disabled={
                            !ready ||
                            !["queued", "paused", "blocked", "done"].includes(
                              taskActivity(
                                selected,
                                thread,
                                landed.has(selected.id),
                              ),
                            )
                          }
                          onClick={() =>
                            setDeleteTarget({
                              kind: "task",
                              id: selected.id,
                              title: selected.title,
                            })
                          }
                        >
                          Remove task
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Empty title="Open an agent thread or queued task">
                      Read live updates, inspect its prompt, or add direction
                      without leaving this ticket.
                    </Empty>
                  )}
                </section>
              </div>
            </>
          )}
          {step === "merge" && (
            <section className="wf-panel">
              <div className="wf-section-heading">
                <h2>Merge queue</h2>
                <Badge variant="light" color="gray">
                  {stillWaiting.length} waiting · {mergeHistory.length} finished
                </Badge>
              </div>
              <p className="muted">
                Workers merge into the ticket branch one at a time. Every
                attempt stays on this list, in the order it ran, whether it
                landed, gave up or died. Conflict fixes and checks appear in
                each agent thread.
              </p>
              {mergeQueue.length ? (
                mergeQueue.map(({ taskId, status, at }, index) => {
                  const item = tasks.find((item) => item.id === taskId);
                  const place = mergePosition(taskId);
                  return (
                    <button
                      className="wf-merge-row"
                      // One task can merge more than once, so the task id alone
                      // is not unique on this list.
                      key={`${taskId}-${at}-${index}`}
                      onClick={() => {
                        setSelectedTaskId(taskId);
                        setStep("work");
                      }}
                    >
                      <span>
                        {place >= 0 ? String(place + 1).padStart(2, "0") : "—"}
                      </span>
                      <strong>{item?.title ?? taskId}</strong>
                      {at > 0 && (
                        <time
                          className="wf-merge-when"
                          dateTime={new Date(at).toISOString()}
                        >
                          {mergeWhen(at)}
                        </time>
                      )}
                      <Status
                        activity={
                          status === "merging" || status === "conflict"
                            ? (runtime?.threads[taskId]?.activity ??
                              mergeActivity[status])
                            : mergeActivity[status]
                        }
                      />
                      <IconChevronRight size={15} />
                    </button>
                  );
                })
              ) : (
                <Empty title="Nothing has merged on this ticket yet">
                  A worker joins after implementing, testing, and confirming its
                  task. Once it does, it stays on this list for good.
                </Empty>
              )}
            </section>
          )}
          {step === "review" && (
            <section className="wf-panel">
              <div className="wf-section-heading">
                <h2>Ticket pull request</h2>
                <Badge variant="light" color="gray">
                  {doneTasks.length}/{tasks.length} tasks done
                </Badge>
              </div>
              <p className="muted">
                Once all agent tasks merge, the ticket branch gets one PR and an
                independent agent review.
              </p>
              {runtime?.pullRequests?.[ticket.id] ? (
                <a
                  href={runtime.pullRequests[ticket.id]!.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={openExternally}
                >
                  Open pull request · {runtime.pullRequests[ticket.id]!.status}{" "}
                  ↗
                </a>
              ) : (
                <Empty title="No pull request yet">
                  {tasks.length && doneTasks.length === tasks.length
                    ? "All agent tasks are done. Waiting for the agent system to create the PR."
                    : "Finish the agent tasks and their merges first."}
                </Empty>
              )}
              {ticket.pullRequest?.summary && (
                <p className="wf-prewrap muted">
                  Review: {ticket.pullRequest.summary}
                </p>
              )}
              <Select
                label="Final merge policy"
                description="Saved with the ticket. Automatic merges only the reviewed commit, and only when the forge reports every check green."
                data={[
                  { value: "manual", label: "Manual — a human merges" },
                  {
                    value: "automatic",
                    label: "Automatic — after required checks and review",
                  },
                ]}
                value={ticket.mergePolicy ?? "manual"}
                allowDeselect={false}
                disabled={!ready}
                onChange={(value) =>
                  (value === "manual" || value === "automatic") &&
                  update((current) => ({
                    ...current,
                    tasks: current.tasks.map((item) =>
                      item.id === ticket.id
                        ? {
                            ...item,
                            mergePolicy: value,
                            updatedAt: new Date().toISOString(),
                          }
                        : item,
                    ),
                  }))
                }
              />
            </section>
          )}
        </>
      )}
      {ticket && (
        <TaskEditor
          key={
            taskEditor === "new"
              ? `new-${ticket.id}`
              : (taskEditor?.id ?? "closed")
          }
          opened={!!taskEditor}
          task={taskEditor === "new" ? undefined : (taskEditor ?? undefined)}
          ticket={ticket}
          siblings={tasks}
          prompt={
            taskEditor && taskEditor !== "new" ? taskEditor.prompt : undefined
          }
          onClose={() => setTaskEditor(null)}
          onSave={(input, prompt) => {
            let savedId = "";
            update((current) => {
              if (taskEditor && taskEditor !== "new") {
                savedId = taskEditor.id;
                return {
                  ...current,
                  agentTasks: current.agentTasks.map((item) =>
                    item.id === savedId
                      ? {
                          ...item,
                          ...input,
                          prompt,
                          status: ["queued", "ready", "blocked"].includes(
                            item.status,
                          )
                            ? input.dependencyIds.some(
                                (id) =>
                                  current.agentTasks.find(
                                    (dep) => dep.id === id,
                                  )?.status !== "complete",
                              )
                              ? "queued"
                              : "ready"
                            : item.status,
                          updatedAt: new Date().toISOString(),
                        }
                      : item,
                  ),
                };
              }
              const next = addAgentTask(current, {
                ...input,
                prompt,
                parentTaskId: ticket.id,
              });
              savedId = next.agentTasks.at(-1)!.id;
              return next;
            });
            if (savedId) {
              setSelectedTaskId(savedId);
            }
            setTaskEditor(null);
          }}
        />
      )}
      {ticket && (
        <TicketEditor
          key={`${ticket.id}-${editTicket}`}
          ticket={ticket}
          opened={editTicket}
          onClose={() => setEditTicket(false)}
          onSave={(title, criteria) => {
            update((current) => ({
              ...current,
              tasks: current.tasks.map((item) =>
                item.id === ticket.id
                  ? {
                      ...item,
                      title,
                      criteria,
                      updatedAt: new Date().toISOString(),
                    }
                  : item,
              ),
            }));
            setEditTicket(false);
            setNotice(
              "Requirements saved. Use the planning chat to request updates to the tasks and agents.",
            );
          }}
        />
      )}
      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.kind === "ticket" ? "ticket" : "agent task"}?`}
        centered
      >
        <p>
          Remove “{deleteTarget?.title}”
          {deleteTarget?.kind === "ticket" ? " and its agent tasks" : ""} from
          this workspace?
        </p>
        <p className="muted">
          This does not delete the source ticket or Git branches.
        </p>
        <div className="heading-actions">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Keep it
          </Button>
          <Button color="red" onClick={remove}>
            Remove
          </Button>
        </div>
      </Modal>
    </main>
  );
}

function TicketEditor({
  ticket,
  opened,
  onClose,
  onSave,
}: {
  ticket: Task;
  opened: boolean;
  onClose: () => void;
  onSave: (title: string, criteria: string) => void;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [criteria, setCriteria] = useState(ticket.criteria);
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Edit ticket requirements"
      size="lg"
      centered
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(title.trim(), criteria.trim());
        }}
      >
        <TextInput
          label="Ticket title"
          value={title}
          required
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Textarea
          mt="md"
          label="Requirements"
          value={criteria}
          minRows={7}
          autosize
          required
          onChange={(event) => setCriteria(event.currentTarget.value)}
        />
        <Button
          type="submit"
          mt="lg"
          disabled={!title.trim() || !criteria.trim()}
        >
          Save requirements
        </Button>
      </form>
    </Modal>
  );
}
function TaskEditor({
  opened,
  task,
  ticket,
  siblings,
  prompt,
  onClose,
  onSave,
}: {
  opened: boolean;
  task?: AgentTask;
  ticket: Task;
  siblings: AgentTask[];
  prompt?: string;
  onClose: () => void;
  onSave: (
    input: {
      title: string;
      criteria: string;
      dependencyIds: string[];
      assigneeId?: string;
    },
    prompt: string,
  ) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [criteria, setCriteria] = useState(task?.criteria ?? "");
  const [instruction, setInstruction] = useState(
    prompt ?? (task ? `${task.title}\n\n${task.criteria}` : ""),
  );
  const [dependencies, setDependencies] = useState(task?.dependencyIds ?? []);
  const [assignee, setAssignee] = useState(task?.assigneeId ?? "");
  const [error, setError] = useState("");
  // Exclude descendants as dependencies so editing cannot introduce a cycle.
  const excluded = new Set(task ? [task.id] : []);
  for (let i = 0; i < siblings.length; i++)
    for (const item of siblings)
      if (item.dependencyIds.some((id) => excluded.has(id)))
        excluded.add(item.id);
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={task ? "Edit agent task" : `Add agent task · ${ticket.ticket}`}
      size="lg"
      centered
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onSave(
              {
                title: title.trim(),
                criteria: criteria.trim(),
                dependencyIds: dependencies,
                assigneeId: assignee.trim() || undefined,
              },
              instruction.trim() || `${title.trim()}\n\n${criteria.trim()}`,
            );
          } catch (cause) {
            setError(String(cause));
          }
        }}
      >
        <TextInput
          label="Task title"
          required
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Textarea
          mt="md"
          label="Queued prompt"
          description="The instructions the worker will receive. Ticket requirements are part of its context."
          placeholder="Describe what the agent should build and how it should check the result…"
          minRows={5}
          autosize
          value={instruction}
          onChange={(event) => setInstruction(event.currentTarget.value)}
        />
        <Textarea
          mt="md"
          label="Acceptance criteria"
          required
          minRows={3}
          value={criteria}
          onChange={(event) => setCriteria(event.currentTarget.value)}
        />
        <MultiSelect
          mt="md"
          label="Depends on"
          data={siblings
            .filter((item) => !excluded.has(item.id))
            .map((item) => ({ value: item.id, label: item.title }))}
          value={dependencies}
          onChange={setDependencies}
        />
        <TextInput
          mt="md"
          label="Assigned agent"
          description="Optional. Leave empty for the next available worker."
          value={assignee}
          onChange={(event) => setAssignee(event.currentTarget.value)}
        />
        {error && (
          <p role="alert" className="task-error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          mt="lg"
          disabled={!title.trim() || !criteria.trim()}
        >
          {task ? "Save changes" : "Add to queue"}
        </Button>
      </form>
    </Modal>
  );
}
