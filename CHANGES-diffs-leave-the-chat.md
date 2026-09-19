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

## The row that stands in its place

`diffFiles` in `apps/desktop/src/diff.ts` names the files each removed diff
was about, reading the same regions `stripDiffBodies` takes out, so the rows
name exactly the files whose hunks went. `ThreadFiles` in
`apps/desktop/src/thread-files.tsx` draws one line per file — the verb, the
left-truncated path with the whole path on hover, and the counts — and several
files touched in one message are several rows, in the order the agent wrote
them.

The counts are read from the `Changes` the repository reports, the same value
the Changes tab draws, never from the numbers an agent quoted. A file the
changes command does not report, because it is untracked, ignored or was put
back before the fetch, still gets its row, marked `no diff to show` and left
unclickable rather than opening an empty tab. Every other row opens the
Changes tab.

## Where the row lands

A row is a `button` with an accessible label naming the file (`Show
apps/desktop/src/queue.tsx in Changes`), so it is reached by tab and taken by
Enter. Pressing it turns the detail page to the Changes tab and asks that tab
for the file: `ChangesPanel` opens the file's section whatever its seen mark
says, scrolls it into view and moves the keyboard onto it, so the reader lands
on the file rather than on the top of the tab.

The ask is an event, not a state. `focusFile` in
`apps/desktop/src/changes-focus.ts` stamps every request with a rising id, so
the same file pressed twice is two requests and the second lands as the first
did; the panel answers an id it has not answered yet. A request carries the
task it was made on, so one worker's row never opens a file on the next worker
opened. A row marked `no diff to show` makes no request: `focusFile` returns
the standing request untouched when the changes command does not report the
path, which is the same rule the row draws itself by. `changes-focus.test.ts`
covers the three, with no app rendered.

A request that arrives before its file is drawn — the tab may still be
fetching — is kept rather than dropped, and answered by the first render that
has the file in it.

### For a human to check in the app

- [ ] Tab reaches a summary row in the thread and shows a focus ring on it.
- [ ] Enter on that row switches to the Changes tab, with that file expanded
      and scrolled to, and the keyboard on it.
- [ ] Going back to the thread and pressing the same row again lands on the
      file a second time.
- [ ] A file already ticked as seen still opens when its row is pressed.
- [ ] A row reading `no diff to show` takes neither tab nor Enter.
- [ ] Quote in the opened file still prefills the composer.

## Order

This touches `queue.tsx` alongside LOCAL-9b1540fd and LOCAL-192f8bfc, and
lands after them.
