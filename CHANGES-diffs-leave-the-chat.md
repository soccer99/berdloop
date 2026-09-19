# Diffs leave the chat

A file diff is read in the Changes tab of the worker detail page, not in the
agent thread. The thread keeps the words.

## Which path actually put hunks on screen

Two candidates were named in the ticket, and only one of them does it.
Every path that renders agent text was walked; all four are below, with
the one to strip first.

- **The thread's message text. This is the one.** `Log`
  (`apps/desktop/src/queue.tsx:194`) renders `message.text` verbatim at
  `queue.tsx:275`, so whatever an agent wrote arrives on screen as it was
  written, fenced diff and all. One `Log`, through `AgentConversation`, is
  every thread in the app: the worker thread, the ticket agent's chat and the
  planner's. The task row's one-line preview of the last message
  (`queue.tsx:1052`) shows the same text, so it is stripped with it. The fix
  sits on the same path: `queue.tsx:219-220` runs `stripDiffBodies` and
  `diffFiles` over each message before it is drawn.
- **The tool line does not.** `ToolLine`
  (`apps/desktop/src/agent-chat.tsx:348`) renders an icon and a tool name and
  nothing else. The native side agrees: `parse_claude`
  (`apps/desktop/src-tauri/src/agent.rs:246`) and `parse_codex`
  (`agent.rs:278`) push a `"tool"` chunk carrying only the tool's name, and the
  stream loop's `"tool"` arm (`agent.rs:668`) turns that chunk into an activity
  label and an edit count without appending any text to the conversation. Only
  `"text"` chunks (`agent.rs:659`), an assistant's own prose, become agent
  messages.
- **The Changes tab's own renderer is deliberate and stays.** `ChangesPanel`
  (`apps/desktop/src/changes-panel.tsx:53`) calls `parseDiff` at
  `changes-panel.tsx:173` to draw hunks. That is the one place a diff is meant
  to be read, so it is the destination of this ticket, not a path to strip.
- `Bubble` in `apps/desktop/src/agent-chat.tsx:312` would print `message.text`
  verbatim in the same way, but `AgentChat` is exported and never mounted:
  `queue.tsx:58` imports only `HumanRequestCard` from that module. It is
  stripped alongside the live path (`agent-chat.tsx:322-323`) so the two
  renderers cannot drift.

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

## Checks

`make test` passes end to end on this branch, with nothing left to fix:

- `bun run check` — typecheck across all six workspaces, then `bun test`
  (**217 pass, 0 fail**, 541 expect() calls across 20 files), then the desktop
  and web production builds. The new suites are in it: `diff.test.ts`,
  `diff-summary.test.ts`, `changes-focus.test.ts`, `use-task-changes.test.ts`.
- `bun run format:check` — clean.
- `cargo fmt --check` — clean.
- `cargo check --locked` — clean, no warnings.
- `cargo test --locked` — **179 passed, 0 failed**, 3 ignored.

## What a reviewer should walk through in the app

No worker can open the desktop app, so the click-through below is left for a
person. The logic under each step is covered by unit tests with no app
rendered — `diff.test.ts` and `diff-summary.test.ts` for what is stripped and
what a row says, `changes-focus.test.ts` for where a row lands,
`use-task-changes.test.ts` for the fetching — but that the wiring is really on
screen is what these steps prove.

Run a worker on a task that edits **two** files, then:

- [ ] **Two rows, no hunks.** The agent thread shows one compact summary row
      per touched file — two rows — each reading verb, path and counts, e.g.
      `edited apps/desktop/src/queue.tsx  +24 -7`. Scroll the whole thread: no
      `@@` hunk header, no `+`/`-` body line, no fenced diff anywhere in it.
      The task row's one-line preview in the list is likewise free of diff
      text.
- [ ] **A row is the verb the repository reports.** The verbs come from the
      same A/M/D/R vocabulary `ChangedFile` carries — added / edited / deleted
      / renamed — and the counts match what the Changes tab shows for that
      file, not any number the agent quoted in its prose.
- [ ] **The prose survives.** Whatever the agent wrote around the diff is
      still there, unaltered. A `- like this` bullet, a `---` rule, a `+1` and
      a `sh` fence are not mistaken for diff and are left alone.
- [ ] **Clicking a row lands on that file.** Press the first row. The detail
      page turns to the **Changes** tab, that file's section is expanded and
      scrolled into view, and the keyboard focus is on it — not on the top of
      the tab. Go back to the **Agent thread** tab, press the *second* row, and
      land on the second file the same way.
- [ ] **Quoting a line reaches the composer.** In the opened file in the
      Changes tab, quote a line. The quoted text appears in the composer,
      ready to send.

The finer-grained focus behaviour — tab order, Enter, pressing the same row
twice, an already-seen file, and a row marked `no diff to show` — is listed
under *Where the row lands* above.

## Order, and the overlap in `queue.tsx`

This ticket rewrites the parts of `queue.tsx` and `agent-chat.tsx` that two
other tickets also touch, and it is branched from before either of them
landed. Whoever merges this to `main` should expect to resolve that by hand;
nothing here is meant to undo either one.

Comparing this branch against `main` from their common base
(`7b4fb46`), the files changed on both sides are:
`apps/desktop/src/queue.tsx`, `apps/desktop/src/agent-chat.tsx`,
`apps/desktop/src/workflow.css` and `package.json`.

- **LOCAL-192f8bfc — Cmd+Enter sends from the agent text inputs** (PR #4,
  merged). On `main` this adds send-shortcut wiring at `queue.tsx:361` and
  `agent-chat.tsx:230` and `:336`, plus `send-shortcut.ts`. None of it is on
  this branch. Its hunks sit in the composer and the message list — the same
  two regions this ticket reworks — so keep both: the shortcut handlers and
  the summary-row rendering are independent and must both survive.
- **LOCAL-9b1540fd — Unsent text in every input survives navigating away and
  back** (PR #3, merged). It adds `drafts.ts`, `use-draft`, `new-ticket-draft`
  and `quote-prefill.ts`, and rewrites the `queue.tsx` composer onto
  `useDraft(draftKey)`. None of it is on this branch either. Note especially
  `quote-prefill.ts`: it owns the quote-to-composer step of the walkthrough
  above, which this branch still does through the local `quote` state at
  `queue.tsx:627` and `:1690`. On merge that step should end up going through
  `quote-prefill`, and the walkthrough's last box re-checked once it does.
