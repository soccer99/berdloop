# Diffs leave the chat

A file diff is read in the Changes tab of the worker detail page, not in the
agent thread. The thread keeps the words.

## Which path actually put hunks on screen

Two candidates were named in the ticket. **Both of them do it**, and the
second only started to after this branch was cut. Every path that renders
agent text was walked against `main` at `1eb01d2`, which this branch now
carries; all five are below.

- **The thread's message text. The first one.** `Log`
  (`apps/desktop/src/queue.tsx:211`) renders `message.text` verbatim at
  `queue.tsx:281`, so whatever an agent wrote arrives on screen as it was
  written, fenced diff and all. One `Log`, through `AgentConversation`, is
  every thread in the app: the worker thread, the ticket agent's chat and the
  planner's. The fix sits on the same path: `queue.tsx:236-246` runs
  `stripDiffBodies` and `diffFiles` over each message before it is drawn.
- **The tool line. The second one, and it is new.** The earlier reading of
  this — *"the tool line does not"* — was taken at `7b4fb46`, where a `"tool"`
  chunk carried the tool's bare name and the stream loop only bumped
  `thread.revision` with it. Commit `1eb01d2` changed both halves of that, so
  the sentence is no longer true and is replaced here:
  - `tool_label` (`apps/desktop/src-tauri/src/agent.rs:235`) now builds
    `"Name · summary"` from `TOOL_SUMMARY_KEYS` (`agent.rs:220`) and appends
    **the whole call input**, pretty-printed and clamped to 4000 characters,
    under it. `parse_claude` pushes that at `agent.rs:306`.
  - The stream loop's `"tool"` arm (`agent.rs:738`) no longer only counts the
    call: at `agent.rs:752` it appends a real thread message with role
    `"tool"`.
  - `Log` (`queue.tsx:271`) and `Bubble` (`agent-chat.tsx:376`) draw that role
    through `ToolLine` (`agent-chat.tsx:414`), whose `<details>` opens the
    full input in a `<pre>`.

  For an `Edit` call that input is `old_string` and `new_string` — the file's
  text before and after, which is a diff under another name — and for a `Bash`
  call it is the command, which can carry a patch body. So a change does reach
  the thread by this door, and `stripDiffBodies` never saw it: the input is
  JSON, so its newlines are `\n` escapes on a single line and no `@@` header
  is ever at the start of one. `stripToolBodies`
  (`apps/desktop/src/diff.ts:321`) is what handles it, below.
- **The task row's one-line preview.** `queue.tsx:1116` shows the thread's
  latest message under each task. Since `1eb01d2` that message is very often a
  tool call, and a `<p>` collapses the newline, so the whole JSON input would
  run along the row. `rowPreview` (`queue.tsx:204`) holds it to the same rule:
  a tool call shows its head line alone, anything else is stripped as the
  thread is.
- **The Changes tab's own renderer is deliberate and stays.** `ChangesPanel`
  (`apps/desktop/src/changes-panel.tsx:53`) calls `parseDiff` at
  `changes-panel.tsx:173` to draw hunks. That is the one place a diff is meant
  to be read, so it is the destination of this ticket, not a path to strip.
- **`Bubble`** (`apps/desktop/src/agent-chat.tsx:366`) would print
  `message.text` verbatim in the same way. `AgentChat` is exported and not yet
  mounted — `queue.tsx:60` imports only `HumanRequestCard` and `ToolLine` from
  that module — but it is stripped alongside the live path so the two
  renderers cannot drift.

So there were two doors, not one: an agent's own prose quoting a diff, and the
tool call input printed under a tool line. Both are taken out.

## The tool line's input

`stripToolBodies` in `apps/desktop/src/diff.ts` takes a tool message and
returns it with the change bodies gone from its input. The head line is left
exactly as it came — it names the tool and the file, which is the one compact
line this ticket asks for. Under it:

- A field whose key is the change itself — `old_string`, `new_string`,
  `old_str`, `new_str`, `content`, `new_content`, `new_source` — keeps its key
  and loses its value, which becomes `… read it in the Changes tab`. A
  `MultiEdit`, whose edits are nested in an array, is covered by the same rule
  because pretty-printing puts each nested key on its own line.
- Every other field is read rather than assumed: its string value is unescaped
  and put through `stripDiffBodies`, so a patch inside a `Bash` command goes
  while the rest of the command stays. A `pattern`, a `path` or a
  `description` comes through untouched.
- An input clamped at 4000 characters can end mid-string, with no closing
  quote. A change key is still redacted in that case; any other field is left
  alone rather than guessed at.
- A harness that sends a raw command instead of JSON — Codex does, at
  `agent.rs:339` — has no fields to read, so the body is swept for a diff
  whole, the same way an agent's prose is.

`diff.test.ts` covers the eight: an `Edit`'s before and after, a `Write`'s
whole file, a `MultiEdit`'s nested edits, a clamped input, a patch inside a
`Bash` command, a raw Codex command, a tool line with no input at all, and the
fields that must not be touched.

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

Re-run after the merge with `main` and the tool-line work:

- `bun run typecheck` — clean across all six workspaces.
- `bun test` — **234 pass, 0 fail**, 591 expect() calls across 21 files. The
  new suites are in it: `diff.test.ts`, `diff-summary.test.ts`,
  `changes-focus.test.ts`, `use-task-changes.test.ts`, and `main`'s
  `send-shortcut.test.ts`.
- `bun run build` — the desktop and web production builds, both clean.
- `bun run format:check` — clean.
- `cargo fmt --check` — clean.
- `cargo check --locked` — clean, no warnings.
- `cargo test --locked` — **not re-run after the merge.** The machine ran out
  of disk part-way through the build; it has 2.6 GiB free against a build that
  needs several. Nothing on this branch touches Rust — `agent.rs` is taken
  from `main` unchanged — and `cargo check --locked` compiled the crate clean
  beforehand, but the Rust suite is owed a run on a machine with room.

## What a reviewer should walk through in the app

No worker can open the desktop app, so the click-through below is left for a
person. The logic under each step is covered by unit tests with no app
rendered — `diff.test.ts` and `diff-summary.test.ts` for what is stripped —
from an agent's prose and from a tool call's input — and what a row says, `changes-focus.test.ts` for where a row lands,
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
- [ ] **A tool line opens without a change in it.** The thread also has a
      line per tool call — `Edit · apps/desktop/src/queue.tsx`. Click one open.
      Its `file_path` is there, but `old_string` and `new_string` read
      `… read it in the Changes tab`, with none of the file's text either
      side. Open a `Bash` line the same way: the command is whole unless it
      carried a patch, and then only the patch is gone.
- [ ] **Quoting a line reaches the composer.** In the opened file in the
      Changes tab, quote a line. The quoted text appears in the composer,
      ready to send.

The finer-grained focus behaviour — tab order, Enter, pressing the same row
twice, an already-seen file, and a row marked `no diff to show` — is listed
under *Where the row lands* above.

## The merge with `main`

This branch was cut at `7b4fb46`, before three tickets landed, and `main` is
now in it. The four files that conflicted, and how each was settled:

- **`queue.tsx`** and **`agent-chat.tsx`**. Both sides kept. `main`
  (LOCAL-192f8bfc, PR #4) added the Cmd+Enter send wiring and, in `1eb01d2`,
  the `"tool"` role and its `ToolLine`; this branch reworked the same message
  list to strip diffs and draw a row per file. A tool call takes the tool
  line, everything else takes the rows, and the send shortcuts are untouched
  by either.
- **`external-link.test.ts`**. Both sides made the same fix to the module
  mock — keep the rest of `@tauri-apps/api/core` when faking `isTauri`.
  `main`'s is the later of the two, and is the one kept.
- **`package.json`**. Both sides added test files to the run. It lists both.

LOCAL-9b1540fd's `quote-prefill.ts` is **not** in `main` at `1eb01d2`, so the
quote-to-composer step still goes through the local `quote` state in
`queue.tsx`. When that ticket lands, the step should move onto
`quote-prefill`, and the walkthrough's last box re-checked once it does.
