# Diffs leave the chat

A file diff is read in the Changes tab of the worker detail page, not in the
agent thread. The thread keeps the words.

## Which path actually put hunks on screen

Two candidates were named, and only one of them does it.

- **The thread's message text. This is the one.** `Log` in
  `apps/desktop/src/queue.tsx` renders `message.text` verbatim, so whatever an
  agent wrote arrives on screen as it was written, fenced diff and all. One
  `Log`, through `AgentConversation`, is every thread in the app: the worker
  thread, the ticket agent's chat and the planner's. The task row's one-line
  preview of the last message (`queue.tsx`, the row's `<p>`) shows the same
  text, so it is stripped with it.
- **The tool line does not.** `ToolLine` in `apps/desktop/src/agent-chat.tsx`
  renders an icon and a tool name and nothing else. The native side agrees:
  `parse_claude` and `parse_codex` in `apps/desktop/src-tauri/src/agent.rs`
  push a `"tool"` chunk carrying only the tool's name, and the stream loop in
  the same file turns that chunk into an activity label and an edit count. No
  tool body is ever appended to a conversation. Only `"text"` chunks, an
  assistant's own prose, become agent messages.
- `Bubble` in `apps/desktop/src/agent-chat.tsx` would print `message.text`
  verbatim in the same way, but `AgentChat` is exported and never mounted:
  `queue.tsx` imports only `HumanRequestCard` from that module. It is stripped
  alongside the live path so the two renderers cannot drift.

So the diff bodies in the thread are the agent's own prose quoting a diff, and
that is what is taken out.

## What was done

`stripDiffBodies` in `apps/desktop/src/diff.ts` removes every diff from a
message and leaves the rest of the text exactly as it came. A line counts as
diff only under a `@@` hunk header, a `diff --git` line or a `---`/`+++` pair,
or inside a fence labelled `diff`/`patch` or holding a hunk. That is what
leaves a `- like this` bullet, a `---` rule, a `+1` and a `sh` fence alone. A
message that was nothing but a diff is not drawn at all.

## Order

This touches `queue.tsx` alongside LOCAL-9b1540fd and LOCAL-192f8bfc, and
lands after them. The summary row that replaces a diff with one line
(`edited path +24 -7`) is a later task; nothing here adds it.
