import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Loader,
  Select,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowUp,
  IconHelpCircle,
  IconPlayerStop,
  IconTool,
} from "@tabler/icons-react";
import {
  activityLabels,
  type AgentThreadView,
  type ThreadMessage,
} from "./workflow-ui";
import { ThreadFiles } from "./thread-files";
import { threadRows, type ThreadRow } from "./thread-rows";
import type { Changes } from "./changes-panel";

/**
 * One agent conversation.
 *
 * The same component shows a ticket agent, a task agent and a worker, because
 * from a person's point of view they differ only in what they are talking
 * about. It is deliberately not a chat box that locks while the agent works:
 * interrupting an agent mid-task is the point of the thing, so the composer
 * stays open and says where the message will land.
 */

/** A worker has stopped and needs a person before it can carry on. */
export interface HumanRequest {
  id: string;
  taskId: string;
  /** "approval" when a command is waiting, "question" otherwise. */
  kind: string;
  question: string;
  command?: string;
}

export interface AgentChatProps {
  thread?: AgentThreadView;
  /** Anything this agent is waiting on a person for. */
  requests?: HumanRequest[];
  /** Answer one. An approval carries the decision; a question carries words. */
  onAnswer?: (
    id: string,
    approved: boolean,
    text: string,
  ) => void | Promise<void>;
  title: string;
  subtitle?: string;
  /** Left out when this conversation has no model of its own to pick. */
  model?: {
    value: string;
    options: string[];
    /** Shown when the value is inherited rather than chosen here. */
    inheritedFrom?: string;
    onChange: (value: string) => void;
  };
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void;
  placeholder?: string;
  /** The task's changes, for the line counts on the file rows. */
  changes?: Changes;
}

const DELIVERY_NOTE: Record<NonNullable<ThreadMessage["delivery"]>, string> = {
  saved: "Saved",
  pending: "Waits until the agent starts",
  delivered: "Sent to the agent",
  applied: "Acted on",
  failed: "Not delivered",
};

export function AgentChat({
  thread,
  requests = [],
  onAnswer,
  title,
  subtitle,
  model,
  onSend,
  onStop,
  placeholder,
  changes,
}: AgentChatProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const tail = useRef<HTMLDivElement>(null);

  const messages = thread?.messages ?? [];
  const streaming = thread?.streaming ?? false;
  // A waiting agent is not idle. It has stopped and is holding its place.
  const waiting = requests.length > 0;
  // A worker that has stopped can still be written to: the message reopens its
  // task rather than being delivered to nobody.
  const finished =
    !streaming &&
    (thread?.activity === "done" || thread?.activity === "blocked");

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, streaming]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    try {
      await onSend(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="agent-chat surface">
      <header className="agent-chat-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        <div className="agent-chat-status">
          {waiting && (
            <Tooltip label={`Waiting for you: ${requests.length}`}>
              <span className="agent-chat-asking">
                <IconHelpCircle size={18} />
              </span>
            </Tooltip>
          )}
          {thread && (
            <Badge
              variant="light"
              color={waiting ? "orange" : colourFor(thread.activity)}
              leftSection={
                streaming ? <Loader size={9} color="gray" /> : undefined
              }
            >
              {waiting
                ? activityLabels["waiting-for-human"]
                : activityLabels[thread.activity]}
            </Badge>
          )}
          {streaming && onStop && (
            <Tooltip label="Stop this agent">
              <ActionIcon variant="subtle" color="red" onClick={onStop}>
                <IconPlayerStop size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </div>
      </header>

      {model && (
        <div className="agent-chat-model">
          <Select
            size="xs"
            label="Model"
            data={model.options}
            value={model.value}
            allowDeselect={false}
            onChange={(value) => value && model.onChange(value)}
          />
          {model.inheritedFrom && (
            <span className="muted">Inherited from {model.inheritedFrom}</span>
          )}
        </div>
      )}

      {thread?.worktree && (
        <p className="agent-chat-where muted">
          {thread.branch ? `${thread.branch} · ` : ""}
          {thread.worktree}
        </p>
      )}

      {requests.map((request) => (
        <HumanRequestCard
          key={request.id}
          request={request}
          onAnswer={onAnswer}
        />
      ))}

      <div className="agent-chat-log">
        {!messages.length && (
          <p className="muted">
            {placeholder ??
              "Nothing said yet. Ask for a change, or steer the work."}
          </p>
        )}
        {threadRows(messages).map((entry) => (
          <Bubble key={entry.id} message={entry} changes={changes} />
        ))}
        {streaming && !messages.length && <Loader size="xs" />}
        <div ref={tail} />
      </div>

      <div className="agent-chat-composer">
        <Textarea
          autosize
          minRows={1}
          maxRows={8}
          value={draft}
          placeholder={
            streaming
              ? "Interrupt the agent with a new instruction…"
              : finished
                ? "Say what to change. The task is queued again and picks up where it left off."
                : "Send an instruction. It waits until the agent starts."
          }
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter sends. A newline still needs a modifier, as everywhere else.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <ActionIcon
          size="lg"
          disabled={!draft.trim() || busy}
          onClick={() => void send()}
          aria-label="Send"
        >
          <IconArrowUp size={17} />
        </ActionIcon>
      </div>
    </section>
  );
}

/**
 * One thing an agent is waiting on.
 *
 * An approval gets Allow and Refuse, because a person should not have to type
 * the word "yes" to unblock a worker. A plain question gets the composer.
 */
export function HumanRequestCard({
  request,
  onAnswer,
}: {
  request: HumanRequest;
  onAnswer?: AgentChatProps["onAnswer"];
}) {
  const [note, setNote] = useState("");
  const approval = request.kind === "approval";

  return (
    <div className="agent-ask">
      <p className="agent-ask-question">
        <IconHelpCircle size={15} /> {request.question}
      </p>
      {request.command && <code>{request.command}</code>}
      {approval ? (
        <div className="agent-ask-actions">
          <Button
            size="xs"
            onClick={() =>
              void onAnswer?.(request.id, true, note || "Allowed.")
            }
          >
            Allow
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() =>
              void onAnswer?.(request.id, false, note || "Refused.")
            }
          >
            Refuse
          </Button>
          <Textarea
            autosize
            minRows={1}
            placeholder="Add a reason (optional)"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </div>
      ) : (
        <div className="agent-ask-actions">
          <Textarea
            autosize
            minRows={1}
            placeholder="Your answer"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Button
            size="xs"
            disabled={!note.trim()}
            onClick={() => void onAnswer?.(request.id, true, note.trim())}
          >
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

function Bubble({
  message,
  changes,
}: {
  message: ThreadRow;
  changes?: Changes;
}) {
  // Diffs are read in the Changes tab. This chat shows what was said about a
  // change, and one row for each file the agent wrote; `threadRows` has
  // already taken the hunks out and worked out which rows belong here.
  const { text, files } = message;
  // A file row is not something anybody said, so it stands on its own rather
  // than inside a speech bubble.
  if (message.role === "system" || message.role === "tool") {
    return (
      <>
        {text && <p className="agent-chat-system">{text}</p>}
        <ThreadFiles files={files} changes={changes} />
      </>
    );
  }
  return (
    <div className={`agent-chat-message ${message.role}`}>
      {text && <p>{text}</p>}
      <ThreadFiles files={files} changes={changes} />
      {message.delivery && message.role === "user" && (
        <small className={message.delivery === "pending" ? "warn" : "muted"}>
          {DELIVERY_NOTE[message.delivery]}
          {message.target ? ` · ${message.target}` : ""}
        </small>
      )}
    </div>
  );
}

/** A tool line, for a caller that wants to show what an agent reached for. */
export function ToolLine({ name }: { name: string }) {
  return (
    <span className="agent-chat-tool">
      <IconTool size={12} /> {name}
    </span>
  );
}

function colourFor(activity: AgentThreadView["activity"]): string {
  return (
    {
      queued: "gray",
      coding: "yellow",
      "waiting-for-human": "orange",
      testing: "cyan",
      reviewing: "grape",
      "waiting-to-merge": "orange",
      merging: "orange",
      "fixing-conflicts": "red",
      paused: "gray",
      blocked: "red",
      done: "yellow",
      merged: "green",
    } as const
  )[activity];
}
