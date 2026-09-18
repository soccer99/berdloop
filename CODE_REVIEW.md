# Berdloop readiness review — 2026-09-18

**Verdict (updated 2026-09-18): the seven blockers are fixed and tested. The app is ready for supervised coding runs against a repository with a pushable `origin` and a signed-in `gh`. A live end-to-end run on a real forge has not yet been done.** This review covers the local working tree; it is not a release certification or a live provider integration test.

## Changes made following the chat-routing request

- Rust now owns a conversation registry, process association, message histories, session IDs, and delivery states. Every conversation has an explicit project, role, and (where relevant) ticket/task address.
- UI sends address a conversation, rather than selecting a process or CLI session themselves. Scope mismatches and duplicate starts are rejected. Late output from an earlier run cannot append to a replacement conversation.
- Ticket-wide messages target only active/queued work on that ticket, including workers that have not started. A worker on another ticket or project receives none of that broadcast.
- Queued messages are included at launch. Claude messages can use the process input before a session announcement; Codex messages wait for its actual session ID and use the same configuration home as the launched process.
- Histories are fetched after subscribing to backend events, with revision checks to prevent an older fetch overwriting new output. They survive UI reloads while the Rust process remains alive. Full application-restart persistence/reconnection is not implemented.
- Backend histories include the user's opening chat message and delivery failures. Connected chats no longer manufacture a second local copy of sent messages. Stopped coordinators can resume their recorded CLI session.
- Human requests and merge lines use real project directories and ticket keys. Human request controls are now connected to worker chats.
- Rust tests are included in `make test` and CI; previously both only compiled the Rust code.

## Findings and their status (2026-09-18, second pass)

All seven findings below have been addressed in the working tree. Each row names the evidence. `make test` passes: 113 JavaScript tests, 85 Rust tests (3 environment-dependent tests ignored), type checks, both frontend builds, formatting, and a locked Rust check. `bunx tauri build --bundles app` produced a bundle whose `Contents/MacOS` holds both `berdloop` and `berdloop-worker`.

1. **[Fixed] Planning agents are given commands that do not exist.** Every advertised coordinator command (`task-add`, `task-edit`, `task-remove`, `task-reorder`, `task-steer`, `task-stop`, `ticket-*`, `queue-show`, `pr-review-submit`) is handled in `apps/desktop/src-tauri/src/control.rs` over a private request/reply channel that Rust opens for each coordinator launch. The agent's scope is held by Rust, never passed as a flag. `queue-show --kind worker` returns the real merge line. `task-stop` releases the worker's merge place and records the reason in its chat. A queued instruction wakes a stopped coordinator (`workflow-runtime.ts`). An empty ticket gets its planner started once (`loop-engine.ts`). Launch scopes are checked against the records. Tests: transport round trip, role rejection, rollback of refused mutations, planning and reordering through the store.

2. **[Fixed] Loop state is not scoped to the selected project/ticket.** The loop is now `LoopEngine` in `apps/desktop/src/loop-engine.ts`: staging keyed by project, ticket branches keyed by ticket, runs keyed by task with their project and ticket. The project is pinned when the loop starts. Reports are collected for every project with work out. Every step re-checks after each await, so a pause, a removed ticket, or a paused ticket cannot start a stale worker. Run ids are matched exactly; a report from an earlier attempt never closes a retry. Tests cover ticket A→B, project switching with a late report, pause during preparation and during worktree creation, stop/retry, and a worker stopped from outside.

3. **[Fixed] The editable queued prompt never reaches a worker.** `AgentTask.prompt` is part of the record. The editor reads and writes it, the native store validates it, the legacy browser copy is migrated with damaged storage ignored, and `buildTaskBrief` sends it under "Task instructions". Tests in `brief.test.ts` and `task-storage.test.ts`.

4. **[Fixed] The packaged app does not include the worker command.** `berdloop-worker` is a Tauri sidecar (`bundle.externalBin`). `bun run build:desktop` builds and copies it first (`apps/desktop/scripts/sidecar.mjs`). `build.rs` writes a placeholder so a plain `cargo` build does not need the sidecar first. `worker_command` refuses to start agents when the helper is missing or is the placeholder. Verified: bundle contents, helper run by absolute path, and from a path with a space.

5. **[Fixed] Reordering tasks does not change their execution order.** `nextTasks` keeps workspace order; coordinator reorders write the same array; the obsolete queue files (`queues.rs`, `queue-watcher.ts`) are gone. Regression: a newer task moved above an older one starts first, and a dependency or full slot still wins.

6. **[Fixed] Promoting a long-waiting merge slot can delete it immediately.** Ownership time starts on promotion (`holder` record, refreshed slot time), all queue operations hold an OS lock, places are created with `create_new`, and lock failures grant nobody a turn. The worker heartbeats its slot during sync and land and re-checks its turn right before landing. Tests: promotion with every slot old, eight racing workers, an unlockable queue directory.

7. **[Fixed, with external prerequisites] Ticket completion and publication.** `pr_review.rs` publishes the ticket branch to `origin`, creates or reuses one PR through `gh`, starts an independent review agent on the exact commit, turns findings into priority tasks, invalidates approval on a new commit, and merges automatically only when the reviewed head, review, forge checks, and branch state all allow it. Manual policy waits for a person and completes the ticket when the PR is merged. The policy is saved on the ticket record. Errors from a missing remote or `gh` are shown in the loop and retried. Tests use temporary repositories and a fake `gh`. Prerequisites the app cannot supply: an `origin` remote the user can push to, and a signed-in GitHub CLI.

## Validation and limits

- `make test` on the final tree: 113 JavaScript tests, 85 Rust tests (3 ignored), type checks, both frontend builds, formatting, and `cargo check --locked`.
- `bunx tauri build --bundles app` succeeded and was inspected. The `dmg` target and Windows naming were not exercised.
- No real agent subscription, real GitHub repository, or paid agent run was used. A live end-to-end run against a real forge remains to be done by a person.
- Native workspace edits are saved locally; cloud sync stays inactive until WorkOS sign-in exists.
- The loop lives in the window. Closing the app stops handing out new work; running workers finish and report to disk.
