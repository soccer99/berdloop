# Ticket and agent-task UI

The project opens a ticket queue. Opening a ticket shows its agent tasks. Both use the same workspace records throughout their lifecycle; an active task is not copied into another work queue.

## UI structure

- Ticket queue: collapsible ticket-agent chat, working/paused tickets, queued tickets with reorder controls, then done tickets. New ticket and import actions are at the top.
- Ticket: direct navigation to Requirements, Agent tasks, Merge queue, and PR & review. The planning/steering agent stays above this content and its chat can collapse.
- Agent tasks: active threads first, queued tasks below, then completed tasks. Selecting either opens the same detail panel. The prompt is above the conversation. Queued tasks can be edited, assigned, reordered, or removed.
- Thread statuses: coding, testing, reviewing, waiting to merge, merging, fixing conflicts, paused, blocked, and done. Text updates render from new snapshots. The log follows new output unless the reader has scrolled up.

## Agent-system connection point

This change implements UI only. `src/queue.tsx` exports `QueueView`; `src/workflow-ui.ts` defines its optional `WorkflowRuntime` prop. `App.tsx` currently leaves that prop unset. Supply runtime snapshots and `dispatch` from the agent system there.

Thread keys are `ticket-agent:<projectId>`, `ticket-agent:organization:<organizationId>` for the all-project view, `planner:<ticketId>`, and the agent-task ID for a worker. Scope any all-project ticket-agent request to the current organization. Runtime thread activity overrides the stored planning status. Stream new text by replacing the affected thread's messages with an updated snapshot. Use stable message IDs, including during partial text updates.

`dispatch` accepts message, start-ticket, pause-ticket, resume-ticket, and stop-agent requests. A message identifies the planner, ticket agent, one worker, or all workers. Echo `clientMessageId` as the user message ID in runtime snapshots; that lets the UI replace the pending local message with confirmed delivery without duplicating it. Resolving dispatch means the request was accepted, not that the agent applied it. Report delivered/applied separately in snapshots.

Provide merge queue IDs in actual queue order, ticket branch names, and PR URLs/status through the optional runtime fields. The first entry is not automatically labeled merging; the activity comes from the worker snapshot.

The agent system owns tool execution, queue claims, requirements propagation, steering delivery, stopping processes, pause/resume semantics, worktrees, merge operations, and PR review. No backend commands, tools, or workers are implemented by this UI change. Do not infer successful execution from local draft state.

## Local draft storage

Ticket and agent-task edits use the existing `TaskWorkspace` update callback and persistence. Array order is queue order. Dependency editing excludes the task and its descendants. Removing a task with dependents is rejected.

UI-only settings use local storage:

- `berdloop.ui.task-prompts.v1`: agent-task ID to edited prompt. Use the title and criteria when no override exists.
- `berdloop.ui.instructions.v1`: thread key to saved/pending messages, including the message target. Disconnected messages say “Saved · not sent”; they are not automatically sent on connection.
- `berdloop.ui.merge-policies.v1`: ticket ID to manual/automatic preference. This does not configure backend merge policy yet.
- `berdloop.ui.chat-open.<threadKey>`: expanded/collapsed coordinator state.

Previous `berdloop.preview.notes.v1` ticket directions remain visible in the ticket's planning chat. Saved notes, prompt overrides, and merge preferences must be integrated into the durable agent data model by the agent-system implementation before execution uses them. Direct ticket requirement edits save locally; they do not claim to broadcast to agents. The UI directs the user to the planning chat for a propagation request.

## Verification

Desktop type checking and production build pass. Browser checks covered ticket creation, opening agent tasks, planner collapse, adding tasks, prompt edits, instruction persistence after reload, reordering, and removing the temporary test ticket. An isolated UI fixture verified all worker activity labels, live text updates, and merge-queue-to-thread navigation. The fixture was removed after verification.
