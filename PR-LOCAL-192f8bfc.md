# LOCAL-192f8bfc: Cmd+Enter sends from the agent text inputs

Cmd+Enter (and Ctrl+Enter on Windows and Linux) now sends from every agent text
input. The main gap was the queue composer, which had no keyboard send at all.

## What changed

- **`apps/desktop/src/send-shortcut.ts`** — new `shouldSendOnKey` predicate. Pure,
  no DOM or React imports, so all three call sites get one answer to "is this
  keystroke a send?" instead of each re-deriving the guards.
- **`apps/desktop/src/queue.tsx`** — the `Composer` had no `onKeyDown` at all.
  It has one now.
- **`apps/desktop/src/agent-chat.tsx`** — `AgentChat` accepts Cmd+Enter alongside
  the bare Enter it already had. `HumanRequestCard` accepts Cmd+Enter in the
  question variant only; the approval variant is untouched, because Enter cannot
  say whether you meant Allow or Refuse.

Hints near each send control name the keys: the composer footer reads
"Cmd+Enter (Ctrl+Enter) sends", the chat tooltip "Send · Enter, or Cmd+Enter /
Ctrl+Enter", the answer tooltip "Send · Cmd+Enter / Ctrl+Enter".

## Please decide: AgentChat still sends on bare Enter

This PR deliberately does **not** change it, because the ticket did not ask for
it and it is a behaviour change for anyone already used to the chat.

The result is an inconsistency worth a decision:

- `queue.tsx` `Composer` sends on **Cmd+Enter only**. Enter is a newline.
- `AgentChat` sends on **bare Enter**, Shift+Enter for a newline, and now
  Cmd+Enter as well.

So the same keystroke means different things in two inputs that sit a few
pixels apart and take the same kind of prose. Bare Enter is also actively
hostile to the long multi-line drafts these inputs invite: an instruction to an
agent is often several sentences, and every paragraph break is a chance to send
half a thought to a running worker. The composer's `minRows={2} maxRows={7}` and
the chat's `maxRows={8}` both say we expect multi-line input.

Three ways to settle it, for whoever picks:

1. **Make AgentChat match the composer** — Cmd+Enter sends, Enter is a newline.
   Consistent and safe for long drafts; costs existing users their habit.
2. **Make the composer match AgentChat** — bare Enter sends in both. Consistent
   and fast for one-liners; spreads the multi-line hazard to a second input.
3. **Leave it as it is** — chat is for quick replies, the composer for drafted
   instructions, and the difference is intentional. If this is the answer, the
   hints already state the rule, but it should be a recorded decision rather
   than an accident of history.

## Verification a human should do

The desktop app cannot be launched from the worker environment (devenv only
starts `apps/web`), so the keystrokes below were **not** pressed. They need a
person on a real desktop build:

1. **Ticket agent composer** (`queue.tsx`) — type a multi-line instruction, press
   **Cmd+Enter**. It should send and the box should clear. Press **Enter** on its
   own: it should insert a newline and send nothing.
2. **Worker chat** (`AgentChat`) — type an instruction, press **Cmd+Enter**. It
   should send. Bare **Enter** should still send too, unchanged.
3. **Question card** — when an agent asks a question, type an answer and press
   **Cmd+Enter**. It should submit. On an approval request, Enter should do
   nothing: Allow and Refuse stay mouse-only.
4. **Ctrl+Enter** on Windows or Linux, anywhere above, should behave as Cmd+Enter.
5. **IME check**, if you have a CJK input method: begin a composition, press
   Enter to accept the candidate. It must commit the word, not send the message.

## Code read, in lieu of pressing the keys

Each of the three handlers was read and confirmed to:

- pass **`event.nativeEvent.isComposing`** into the predicate, so a mid-composition
  Enter falls through to the IME. `AgentChat` additionally returns early on
  `isComposing` before any branch, which also protects its bare-Enter path.
- pass both **`metaKey`** and **`ctrlKey`**, so macOS and Windows/Linux share one
  habit.
- go through the **existing send path**, not `onSend` directly:
  - `queue.tsx` calls `event.currentTarget.form?.requestSubmit()`, so the form's
    `onSubmit` runs its `text.trim()` check, `busy` flag, `try/catch` error
    reporting and clear-on-success exactly as the Send button does.
  - `AgentChat` calls its existing `send()`, which re-checks `!text || busy`.
  - `HumanRequestCard` calls its existing `submitAnswer()`.

## Checks

`make test`, exit 0:

```
bun run check
  typecheck: all 6 workspaces exited 0
  bun test: 156 pass, 0 fail, 427 expect() calls across 17 files
  build: @berdloop/web and @berdloop/desktop both exited 0
bun run format:check
  All matched files use Prettier code style!
cargo fmt --check          clean
cargo check --locked       Finished `dev` profile
cargo test --locked        131 passed; 0 failed; 3 ignored
```

`apps/desktop/src/send-shortcut.test.ts` covers the shortcut and every guard:
Cmd+Enter and Ctrl+Enter both send; bare Enter and Shift+Enter do not; another
key with the same modifier does not; empty text, whitespace-only text, a busy
composer and an active IME composition each refuse to send.

## Note on an unrelated red baseline

`make test` was already failing before this ticket began: prettier rejected
`packages/agent/src/{tools.ts,harness.test.ts}` and rustfmt rejected
`apps/desktop/src-tauri/src/control.rs`, all three byte-identical to the
pre-ticket base. Commit `65d5df4` applies the formatters to them. It is pure
line-wrapping, no behaviour change, and touches no file this ticket otherwise
edits — done here only because a red baseline hides whatever the next run
actually breaks.
