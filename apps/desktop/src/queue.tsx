import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Modal,
  MultiSelect,
  Select,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconGripVertical,
  IconMessage,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconSearch,
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
  type ThreadMessage,
  type WorkflowAction,
  type WorkflowRuntime,
} from "./workflow-ui";
import "./workflow.css";
import type { Runtime } from "./workflow-runtime";

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
  runtime?: Runtime;
  onPrepareAgent?: () => Promise<void>;
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
}: {
  messages: ThreadMessage[];
  streaming?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, streaming]);
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
      {messages.length === 0 && (
        <p className="wf-log-empty">
          No messages yet. Instructions and agent updates appear here.
        </p>
      )}
      {messages.map((message) => (
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
              <time dateTime={message.at}>
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
          <p>{message.text}</p>
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
}: {
  label: string;
  placeholder: string;
  connected: boolean;
  onSend: (text: string, target: WorkflowAction["target"]) => Promise<void>;
  targets?: { value: string; label: string }[];
  inlineSend?: boolean;
}) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState(targets?.[0]?.value ?? "worker");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Coordinator({
  kind,
  scope,
  messages,
  runtime,
  threadKey,
  onSend,
}: {
  kind: "ticket" | "planner";
  scope: string;
  messages: ThreadMessage[];
  runtime?: WorkflowRuntime;
  threadKey: string;
  onSend: (text: string, target: WorkflowAction["target"]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useLocalStorage({
    key: `berdloop.ui.chat-open.${threadKey}`,
    defaultValue: true,
  });
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
        <div id={`chat-${threadKey}`} className="wf-coordinator-body">
          <Log
            messages={threadMessages(thread?.messages, messages)}
            streaming={thread?.streaming}
          />
          <Composer
            label={`Message ${title}`}
            placeholder={
              kind === "ticket"
                ? "Add a ticket, change requirements, or direct a ticket’s planner…"
                : "Break down the work, reorder tasks, or give the workers new context…"
            }
            connected={!!runtime?.connected}
            inlineSend={kind === "planner"}
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
    </section>
  );
}

/**
 * The ticket the loop takes when nobody has picked one: the top of the queue
 * as this list shows it, working and paused tickets before queued ones.
 */
export function topTicket(tickets: Task[]): Task | undefined {
  return (
    tickets.find((item) => ["running", "paused"].includes(item.status)) ??
    tickets.find((item) => item.status === "queued")
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
  runtime,
  onPrepareAgent,
}: QueueProps) {
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const dragging = useRef<{ kind: "ticket" | "task"; id: string } | null>(null);
  const threadPanel = useRef<HTMLElement>(null);
  const [step, setStep] = useState("work");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
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
  const [promptOverrides, setPromptOverrides] = useLocalStorage<
    Record<string, string>
  >({ key: "berdloop.ui.task-prompts.v1", defaultValue: {} });
  const [mergePolicies, setMergePolicies] = useLocalStorage<
    Record<string, string>
  >({ key: "berdloop.ui.merge-policies.v1", defaultValue: {} });
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
  const mergeQueue = ticket
    ? (runtime?.mergeQueues?.[ticket.id] ??
      tasks
        .filter(
          (item) =>
            taskActivity(item, runtime?.threads[item.id]) ===
            "waiting-to-merge",
        )
        .map((item) => item.id))
    : [];
  const connected = !!runtime?.connected;
  const ticketAgentKey = `ticket-agent:${projectId || `organization:${organizationId}`}`;
  const plannerKey = `planner:${ticket?.id ?? ""}`;
  const visibleTickets = tickets.filter((item) =>
    `${item.title} ${item.ticket}`.toLowerCase().includes(search.toLowerCase()),
  );
  const activeTasks = tasks.filter(
    (item) =>
      !["queued", "done"].includes(
        taskActivity(item, runtime?.threads[item.id]),
      ),
  );
  const queuedTasks = tasks.filter(
    (item) => taskActivity(item, runtime?.threads[item.id]) === "queued",
  );
  const doneTasks = tasks.filter(
    (item) => taskActivity(item, runtime?.threads[item.id]) === "done",
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

  async function send(
    threadKey: string,
    text: string,
    target: WorkflowAction["target"],
    taskId?: string,
  ) {
    const clientMessageId = crypto.randomUUID();
    const starting =
      connected &&
      !!project?.path &&
      !!runtime?.start &&
      !runtime.threads[threadKey] &&
      (target === "ticket-agent" || target === "planner");
    if (starting) {
      await onPrepareAgent?.();
      await runtime!.start(threadKey, project!.path!, text, {
        organizationId,
        projectId: project!.id,
        role: target === "ticket-agent" ? "ticket-agent" : "task-agent",
      });
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
  function move(kind: "ticket" | "task", id: string, direction: number) {
    const group =
      kind === "ticket"
        ? visibleTickets.filter((item) => item.status === "queued")
        : queuedTasks;
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
    return (
      <div className="wf-order">
        <span
          className="wf-drag-handle"
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
          <IconGripVertical size={15} />
        </span>
        <button
          aria-label="Move up in queue"
          title="Move up in queue"
          disabled={index === 0 || !ready}
          onClick={() => move(kind, id, -1)}
        >
          <IconArrowUp size={14} />
        </button>
        <button
          aria-label="Move down in queue"
          title="Move down in queue"
          disabled={index === length - 1 || !ready}
          onClick={() => move(kind, id, 1)}
        >
          <IconArrowDown size={14} />
        </button>
      </div>
    );
  }
  function taskRows(items: AgentTask[], queued = false) {
    return items.map((item, index) => {
      const currentThread = runtime?.threads[item.id];
      const activity = taskActivity(item, currentThread);
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
              <span>
                {queued ? (
                  String(index + 1).padStart(2, "0")
                ) : (
                  <IconTerminal2 size={15} />
                )}
              </span>
              <Status activity={activity} />
            </div>
            <strong>{item.title}</strong>
            <small>
              {currentThread?.agentId ?? item.assigneeId ?? "Unassigned"}
              {mergeQueue.includes(item.id)
                ? ` · Merge queue #${mergeQueue.indexOf(item.id) + 1}`
                : ""}
            </small>
            <p>
              {currentThread?.messages.at(-1)?.text ??
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
            runtime={runtime}
            messages={savedMessages[ticketAgentKey] ?? []}
            onSend={(text, target) => send(ticketAgentKey, text, target)}
          />
          <div className="wf-list-toolbar">
            <h2>
              Ticket queue <span>{tickets.length}</span>
            </h2>
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
                              item.status === "running"
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
                {id === "merge" && <small>{mergeQueue.length}</small>}
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
                    <a href={ticket.sourceUrl} target="_blank" rel="noreferrer">
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
                          <Status activity={taskActivity(selected, thread)} />
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
                            {taskActivity(selected, thread) === "queued"
                              ? "Queued prompt"
                              : "Task prompt"}
                          </h3>
                          <Button
                            variant="subtle"
                            size="xs"
                            disabled={
                              !ready ||
                              !["queued", "paused", "blocked"].includes(
                                taskActivity(selected, thread),
                              )
                            }
                            onClick={() => setTaskEditor(selected)}
                          >
                            Edit task & prompt
                          </Button>
                        </div>
                        <p>
                          {promptOverrides[selected.id] ??
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
                      <div className="wf-thread-subheading">
                        <IconMessage size={14} />
                        Agent thread
                        {thread?.streaming && (
                          <Badge size="xs" color="lime" variant="light">
                            Live
                          </Badge>
                        )}
                      </div>
                      <Log
                        messages={threadMessages(
                          thread?.messages,
                          savedMessages[selected.id],
                        )}
                        streaming={thread?.streaming}
                      />
                      <Composer
                        label="Message task agent"
                        placeholder={
                          taskActivity(selected, thread) === "queued"
                            ? "Add context for the agent that picks up this task…"
                            : "Give this agent new context or direction…"
                        }
                        connected={connected}
                        onSend={(text, target) =>
                          send(selected.id, text, target, selected.id)
                        }
                      />
                      <div className="wf-thread-footer">
                        <small>
                          {thread?.worktree ??
                            (taskActivity(selected, thread) === "queued"
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
                              taskActivity(selected, thread),
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
                  {mergeQueue.length} waiting
                </Badge>
              </div>
              <p className="muted">
                Workers merge into the ticket branch one at a time. Conflict
                fixes and checks appear in each agent thread.
              </p>
              {mergeQueue.length ? (
                mergeQueue.map((id, index) => {
                  const item = tasks.find((item) => item.id === id);
                  return (
                    <button
                      className="wf-merge-row"
                      key={id}
                      onClick={() => {
                        setSelectedTaskId(id);
                        setStep("work");
                      }}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{item?.title ?? id}</strong>
                      <Status
                        activity={
                          runtime?.threads[id]?.activity ?? "waiting-to-merge"
                        }
                      />
                      <IconChevronRight size={15} />
                    </button>
                  );
                })
              ) : (
                <Empty title="No workers waiting to merge">
                  A worker joins after implementing, testing, and confirming its
                  task.
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
              <Select
                label="Final merge policy"
                description="Saved preference. Applied when the agent system is connected."
                data={[
                  { value: "manual", label: "Manual — a human merges" },
                  {
                    value: "automatic",
                    label: "Automatic — after required checks and review",
                  },
                ]}
                value={mergePolicies[ticket.id] ?? "manual"}
                allowDeselect={false}
                onChange={(value) =>
                  value &&
                  setMergePolicies((current) => ({
                    ...current,
                    [ticket.id]: value,
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
            taskEditor && taskEditor !== "new"
              ? promptOverrides[taskEditor.id]
              : undefined
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
                          status: ["queued", "ready"].includes(item.status)
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
                parentTaskId: ticket.id,
              });
              savedId = next.agentTasks.at(-1)!.id;
              return next;
            });
            if (savedId) {
              setPromptOverrides((current) => ({
                ...current,
                [savedId]: prompt,
              }));
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
