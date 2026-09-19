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
import { diffFiles, stripDiffBodies } from "./diff";
import { ThreadFiles } from "./thread-files";
import type { Changes } from "./changes-panel";
import { useDraft } from "./drafts";
import { shouldSendOnKey } from "./send-shortcut";

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
  /**
   * The subject this conversation is about: a ticket agent, a task agent or a
   * worker. Unsent text is kept under this key, so leaving the conversation
   * and coming back does not throw it away.
   */
  draftKey: string;
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

/** Said next to every send control, so the keystroke is discoverable. */
const SEND_HINT = "Send · Enter, or Cmd+Enter / Ctrl+Enter";

/** The question variant answers on the modifier alone: Enter is a newline. */
const ANSWER_HINT = "Send · Cmd+Enter / Ctrl+Enter";

const DELIVERY_NOTE: Record<NonNullable<ThreadMessage["delivery"]>, string> = {
  saved: "Saved",
  pending: "Waits until the agent starts",
  delivered: "Sent to the agent",
  applied: "Acted on",
  failed: "Not delivered",
};

export function AgentChat({
  draftKey,
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
  const [draft, setDraft, , clearSentDraft] = useDraft(draftKey);
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
    const sent = draft;
    const text = sent.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSend(text);
      // Cleared here and nowhere else: a send that threw leaves the typed
      // text as the only copy of it. Nothing is disabled while the send is in
      // flight, so anything typed meanwhile was never sent and is kept.
      clearSentDraft(sent);
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
        {messages.map((entry) => (
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
            // A half-typed CJK word is not an instruction: leave the IME alone.
            if (event.nativeEvent.isComposing) return;
            // Cmd+Enter and Ctrl+Enter send, the same keystroke as every other
            // composer here, judged by the one shared predicate.
            if (
              shouldSendOnKey(
                {
                  key: event.key,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                { text: draft, busy },
              )
            ) {
              event.preventDefault();
              void send();
              return;
            }
            // Bare Enter sends too, as it always has here. A newline still
            // needs a modifier, as everywhere else.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Tooltip label={SEND_HINT}>
          <ActionIcon
            size="lg"
            disabled={!draft.trim() || busy}
            onClick={() => void send()}
            aria-label="Send"
          >
            <IconArrowUp size={17} />
          </ActionIcon>
        </Tooltip>
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
  // Keyed by the request, and by the task it belongs to, so a half-typed
  // reason survives the card unmounting and is never shown against another.
  const [note, setNote, clearNote] = useDraft(
    `human-request:${request.taskId}:${request.id}`,
  );
  const approval = request.kind === "approval";

  async function answer(approved: boolean, text: string) {
    await onAnswer?.(request.id, approved, text);
    clearNote();
  }

  /** The question variant's one way to answer, for the button and the key. */
  function submitAnswer() {
    const text = note.trim();
    if (!text) return;
    void answer(true, text);
  }

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
            onClick={() => void answer(true, note || "Allowed.")}
          >
            Allow
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => void answer(false, note || "Refused.")}
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
            onKeyDown={(event) => {
              // Only the question variant takes a keystroke. An approval has
              // Allow and Refuse, and Enter cannot say which one you meant.
              if (
                shouldSendOnKey(
                  {
                    key: event.key,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                  },
                  { text: note },
                )
              ) {
                event.preventDefault();
                submitAnswer();
              }
            }}
          />
          <Tooltip label={ANSWER_HINT}>
            <Button size="xs" disabled={!note.trim()} onClick={submitAnswer}>
              Send
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function Bubble({
  message,
  changes,
}: {
  message: ThreadMessage;
  changes?: Changes;
}) {
  // A tool line is a tool's name and the arguments it was called with, not
  // prose an agent wrote, so it is drawn as it came and never summarised.
  if (message.role === "tool") {
    return <ToolLine name={message.text} />;
  }
  // Diffs are read in the Changes tab. This chat shows what was said about a
  // change, so a hunk pasted into the text goes before the bubble is drawn,
  // and the files it named become one row each in its place.
  const text = stripDiffBodies(message.text);
  const files = diffFiles(message.text);
  if (!text && !files.length) return null;
  if (message.role === "system") {
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

/**
 * A tool line, for a caller that wants to show what an agent reached for.
 *
 * The first line says the tool and what it was called with. Anything after it
 * is the full input, which opens on a click: twenty tool calls stay a list,
 * and any one of them can still be read.
 */
export function ToolLine({ name }: { name: string }) {
  const newline = name.indexOf("\n");
  const head = newline < 0 ? name : name.slice(0, newline);
  const detail = newline < 0 ? "" : name.slice(newline + 1);
  if (!detail) {
    return (
      <span className="agent-chat-tool">
        <IconTool size={12} /> {head}
      </span>
    );
  }
  return (
    <details className="agent-chat-tool">
      <summary>
        <IconTool size={12} /> {head}
      </summary>
      <pre>{detail}</pre>
    </details>
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
