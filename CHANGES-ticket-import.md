# Searchable ticket import that hands off to the ticket agent

Ticket import used to be a one-shot dialog: type an issue ID, paste an access
token, get a ticket. The token was never saved, so it was retyped every time,
and the ticket was created straight from the dialog with only whatever the
provider's summary endpoint returned.

It is now a searchable picker backed by connection settings, and picking a
ticket does not import anything. It writes the opening message of a
conversation into the ticket agent's chat box, and the agent fetches the real
body and creates the Berdloop ticket. The planner therefore starts from the
ticket's actual text rather than from a title.

All three providers in `TicketProvider` are covered: Linear, Jira and Asana.

## What changed, by area

### Integration credentials live at org or project scope

`AgentPreferences` gained an `integrations: { organizations, projects }` map,
mirrored in the Rust struct, holding one `Integration` per provider per scope.
It resolves project-if-set-else-org, the same rule `resolveRolePreference` and
`enabledTicketSources` already use, through `resolveIntegration` in TypeScript
and `AgentPreferences::resolve_integration` in Rust.

The per-provider fields are the non-secret ones only: `jiraSite`, `jiraEmail`,
`asanaWorkspace`, and a `connected` flag the host writes back after a token is
saved. Preferences written before integrations existed still load, because
every new field is `#[serde(default)]`.

**Resolution is field by field, not entry by entry.** A project entry does not
replace the organization's; each field the project leaves blank falls back on
its own, so a project that only saves its own token — which the settings UI
writes as an otherwise-empty entry — keeps the organization's Jira site and
email rather than losing them. A field the project fills in wins, and a field
it leaves as whitespace counts as blank. `connected` is the one exception, and
deliberately: whether a token was saved is not a field a person leaves blank,
so the scope that owns the token owns the answer, and a project entry's flag
stands even when it is `false`. Both languages carry this rule and the same
comment: `resolve_integration` in Rust and `resolveIntegration` in TypeScript.

- `apps/desktop/src/agent-preferences.ts`
- `apps/desktop/src-tauri/src/agent_preferences.rs`

### The access token, in its own owner-only file

`integration_secrets.rs` is a new module holding nothing but tokens, keyed
`{scope}/{scopeId}/{provider}` and resolved project-first like everything else.
It exposes `save_integration_secret` and `clear_integration_secret` to the
window; both return `Result<(), String>`. There is deliberately no command that
reads a token back.

### Settings UI: connections in the Ticket sources section

Each provider in the Ticket sources section can now be connected at the
organization or the project, with the fields that provider needs and a
Save/Replace/Clear token control. A project with no connection of its own says
which scope it is inheriting from. Removing a connection clears the stored
token with it, so no secret is left behind with nothing pointing at it.

- `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`

### Rust: a `tickets` module, with search for all three providers

The external-issue code moved out of `lib.rs` into `tickets.rs` and no longer
takes a token across the Tauri boundary — it resolves its own credentials from
the saved connection. `search_external_issues` is the picker's query:

- **Linear** — `searchIssues` for a term, `issues(orderBy: createdAt)` for an
  empty one, so the picker opens with a list rather than a blank panel.
- **Jira** — `/rest/api/3/search/jql`. The older `/rest/api/3/search` is gone
  from Jira Cloud, and its replacement refuses an unbounded query, so the
  recent list is not an empty JQL but `project is not EMPTY order by created
  DESC` — every issue a person can see, newest first. The typed term goes
  inside a JQL string, so quotes and backslashes are escaped before they get
  there and the query cannot be written from outside. An exact key match is
  only requested when the term could be a key, because JQL refuses one that
  could not.
- **Asana** — lists a workspace's tasks for the recent view and uses the search
  endpoint when a person types. Asana's task list takes no ordering parameter:
  it answers in an order of its own and truncates to whatever limit it was
  given, so asking it for twenty would hand back an arbitrary twenty of a
  person's assigned tasks. A whole page of `ASANA_PAGE` (100, Asana's maximum
  and above `MAX_LIMIT`) is read instead, ordered newest-first here, and only
  then truncated. The search endpoint needs a paid plan, so a refusal from it
  falls back to filtering that whole page on name and GID rather than showing a
  failure nobody can act on — the whole page and not the newest few, so the
  fallback can still find an older task by name.

An empty query returns at least `RECENT_LIMIT` (10) issues, so the picker opens
populated. Parsing is a pure function over `serde_json` values in every case,
which is what makes the fixture tests below possible without a network.

**Every refusal a person fixes in settings carries the `Settings: ` mark.**
`settings_fix` puts the `SETTINGS_PREFIX` on it, and the three that qualify all
go through it: "Connect <provider> in settings first.", the unusable Jira site
or missing account email, and the missing Asana workspace GID. None is worth
retrying and each is one visit to settings away from fixed. The contract is the
mark, not any one sentence, so a refusal of this kind added later is offered
the same way out without the window having to learn its wording. The sentence
is still readable on its own after the mark, so anywhere that does not strip it
loses nothing.

### The import modal became a searchable picker

Typing rests 250ms before the provider is asked again, so a typed word is one
search rather than one per keystroke. Every request takes a number on the way
out and only an answer newer than the last one shown is accepted, because a
search sent later can come back sooner. Rows are sorted newest-first, and an
issue whose provider did not say when it changed sorts last rather than first.
A refusal the picker answers with a way out instead of an error is one the host
marked: `settingsFix` reads the `Settings: ` prefix, strips it, and returns the
sentence to show beside the settings link — or an empty string when the failure
is not one settings can fix. It matches the mark and never the wording, so
`"Connect Linear in settings first."` without the mark is left as a plain
failure; only the host may say a refusal is settings-fixable.

- `apps/desktop/src/ticket-picker.ts`, `apps/desktop/src/App.tsx`

### Picking prefills the composer instead of importing

`ticketAgentPrompt` builds the message: provider, key, URL, title, status, the
description as the picker has it, and a closing instruction to call
`ticket_import`. It lands in the ticket agent's chat box unsent, so a person can
add to it before sending.

### `ticket-import` control command and tool

`control.rs` gained a `ticket-import` command, authorized for `ticket-agent`
only. It takes a provider and a reference, resolves the connection from the
scope the agent was started with, fetches the issue and imports it with its
provider linkage: `source`, `sourceId`, `sourceUrl`, `sourceStatus` and
`ticket` (the provider key), with the real body as `criteria`. Re-importing the
same issue updates the ticket it already made rather than adding a second one;
two Jira sites can hand out the same issue ID, so a Jira match also requires the
same site origin.

- `apps/desktop/src-tauri/src/control.rs`, `packages/agent/src/tools.ts`,
  `apps/desktop/src-tauri/src/bin/worker_cli.rs`

## The secrets-handling decision

**Access tokens are kept in a separate `0600` file, not in the OS keychain, and
are never returned to the UI, never put in an error, and never logged.**

Concretely:

- Tokens live in `<app data dir>/integration-secrets.v1.json`, written `0600`,
  owner-only. They never enter `agent-preferences.v1.json`, which is plain
  readable settings a person may copy between machines. Only the `connected`
  flag goes there.
- The file is written the same atomic way preferences are — write a temporary
  file, then rename — and the owner-only mode is set on that temporary file
  *before* any bytes are written to it, so the token is never briefly on disk at
  a mode another account could read.
- No command returns a token. The window can save one, clear one, and see
  whether one exists; it cannot read one back. `Connection`, the struct that
  actually holds a token in `tickets.rs`, is private to that module and does not
  derive `Serialize`.
- No error message carries a token. Every refusal in `integration_secrets.rs` is
  a fixed string, and an HTTP failure reports `Provider returned HTTP {status}.`
  — the status code alone, never the response body.
- The agent never sees a token either. `ticket_import` takes a provider and a
  reference; the host resolves the credential from the agent's own scope, so no
  token is in a command or in a reply.
- There are no `println!`, `eprintln!`, `dbg!`, `log::` or `tracing::` calls
  anywhere in the modules that touch a token.

### Why a file rather than the keychain

A keychain entry is the stronger store in isolation, and it is the right thing
to move to later. It was not the right thing for this change:

- **It would not have been the weakest link.** Berdloop already keeps a person's
  repositories, their agent preferences and their harness credentials as files
  under the app data directory. An account that can read `0600` files owned by
  this user can already read all of that. A keychain token would raise the bar
  on one secret while everything around it stayed where it was.
- **The keychain prompts, and this path is used by agents.** `ticket_import`
  runs inside an agent turn, unattended. A keychain read that can raise a system
  prompt — which it can, after the signing identity changes or the item's ACL is
  touched — turns an unattended import into something that silently blocks.
- **It is per-machine and per-signing-identity.** Berdloop is a Tauri app under
  active development; the signing identity is not yet stable. Tokens that
  vanished on every re-sign would have been worse than tokens in a file.
- **The property that actually matters here is "not in the preferences file",**
  which is what the bug was: a token either retyped every time or, had it been
  saved naively, sitting in the settings JSON people copy between machines. A
  separate `0600` file gets that property, and the `resolve`/`save`/`clear`
  boundary in `integration_secrets.rs` is narrow enough that swapping the
  storage behind it later is a contained change.

## Tests

- **Credential resolution** — project-over-org, fallback-to-org and the
  field-by-field rule, in both languages: `agent-preferences.test.ts` ("the
  project's fields win one by one, and blank ones fall back", "a project entry
  holding only a token keeps the organization's fields", "a project without its
  own connection falls back to the organization") and `agent_preferences.rs`
  (`a_project_integration_overrides_the_organization_one`,
  `a_project_entry_holding_only_a_token_keeps_the_organizations_fields`,
  `a_blank_project_field_falls_back_and_a_filled_one_does_not`). Token
  resolution itself is covered by
  `integration_secrets.rs::a_project_token_wins_and_the_organization_is_the_fallback`.
- **Fixture-JSON parse tests, no live network** — all three providers:
  `a_linear_search_response_becomes_issues`, `a_jira_search_response_becomes_issues`,
  `an_asana_response_becomes_issues_newest_first`, plus the recent-list,
  incomplete-issue, JQL-escaping and Asana-fallback cases.
  `a_search_term_cannot_break_out_of_the_jql_string` also pins the recent-list
  JQL the new endpoint needs, and
  `a_page_longer_than_the_limit_answers_with_the_newest_tasks` pins that
  Asana's page is ordered before it is truncated and that the fallback filters
  all of it. Neither covers the live endpoints themselves — that is what the
  manual check is for.
- **The settings mark** — `every_refusal_settings_can_fix_carries_the_same_mark`
  and `a_jira_site_a_person_typed_is_sent_back_to_settings` assert the host
  marks all three, and the "settings fix" block in `ticket-picker.test.ts`
  asserts the window strips the mark and leaves an unmarked failure alone.
- **Tool authorization** — `control.rs` asserts `ticket-import` is allowed for
  `ticket-agent` and refused for `task-agent`, `worker` and `pr-code-review`.
- **No token leaks** — `no token is ever kept in the preferences`
  (TypeScript), `an_integration_round_trips_without_carrying_a_token`,
  `nothing_that_can_be_refused_says_what_the_token_was`, and
  `the_secret_file_is_readable_only_by_its_owner`, which asserts mode `0600`.

`make test` passes: 172 TypeScript tests across 17 files, 156 Rust tests,
plus typecheck, build, `prettier --check`, `cargo fmt --check` and
`cargo check --locked`.

## Manual check

These need a person with a real provider account and a real access token. An
agent cannot run them: the tests above deliberately never touch the network, so
nothing automated proves the picker works against a live provider.

Do this for at least one configured provider, and **walk Jira through
specifically** if you have an account for it. Jira's recent list is the one
step of this no test can stand in for: it asks `/rest/api/3/search/jql`, whose
predecessor was removed and which rejects an unbounded query, so the empty-box
list had to become the JQL `project is not EMPTY order by created DESC`. Only a
live site says whether that query is one Jira still answers. A walkthrough that
exercises only Linear leaves Jira's opening list unverified.

Repeat for the others if you have accounts for them — Asana on a free plan is
worth doing specifically, because it exercises the search-endpoint fallback.

1. **Connect the provider.** Open Settings → Ticket sources. Pick a provider and
   choose the organization scope. Fill in what it asks for (Jira: site URL and
   account email; Asana: workspace GID) and paste an access token. Save. The
   row should now read as connected, and the token field should be empty again.
2. **Confirm the token did not come back.** Quit and reopen the app, return to
   the same settings row. It should still say connected, and there should be no
   way to see the token you pasted. Then check the file on disk:
   `ls -l "<app data dir>/integration-secrets.v1.json"` should show `-rw-------`,
   and `agent-preferences.v1.json` should contain `"connected": true` and no
   token string.
3. **Open the picker and see recent tickets with no typing.** Start a ticket
   import for that provider. Before typing anything, the list should already
   show **at least 5 recent tickets** (the host asks for 10), newest first, each
   with its key, title and status.
   - On **Jira**, this is the step that proves the new endpoint and its JQL:
     the list must be populated, not empty and not "Jira could not run this
     search." — which is what a query the enhanced-search endpoint rejects
     looks like from here.
   - On **Asana**, the list is your own assigned tasks in that workspace, and
     the newest ones: a page of 100 is read and ordered before any of it is
     dropped, so a person with more assigned tasks than the picker shows
     should still open on their most recent, never on an arbitrary handful.
4. **Type to search.** Type a word you know appears in one ticket's title. The
   list should narrow to matching tickets within about a second. Type quickly
   and then stop — the results that settle must correspond to what is in the box,
   not to a half-typed earlier query.
5. **Select one.** Click a ticket. The picker should close and **nothing should
   be imported yet** — no new ticket in the queue.
6. **See the prompt land in the ticket agent chat box.** The ticket agent's
   composer should now hold a message naming the provider, key, URL, title and
   status, ending with an instruction to call `ticket_import`. It should be
   unsent and editable.
7. **Add a sentence and send.** Type an extra line of your own — something like
   "Focus on the API side first" — then send.
8. **Confirm the created ticket carries the provider key and body.** When the
   agent finishes, open the new ticket. Check that:
   - the ticket's reference is the **provider key** (e.g. `BRD-128`, or the GID
     for Asana), not a Berdloop-generated ID;
   - its criteria hold the **real ticket body from the provider**, not just the
     title, and not merely the short description the picker row showed;
   - it links back to the provider, and the source URL opens the right issue;
   - the sentence you added is reflected in how the agent planned it.
9. **Import the same ticket again.** Repeat steps 3–7 for the *same* issue. It
   should **update the existing ticket rather than create a second one**.
10. **Check a disconnected provider fails gracefully.** Open the picker for a
    provider you have not connected. It should say "Connect <provider> in
    settings first." and offer settings, rather than showing a raw error. The
    `Settings: ` mark the host puts on that sentence must not be visible: the
    picker strips it before showing it.
11. **Check the other settings-fixable refusals offer settings too.** Connect
    Asana with the workspace GID left blank (or Jira with a site URL that is
    not an HTTPS Jira Cloud URL) and open the picker. It should name what to
    fill in — "Add your Asana workspace GID in settings." — and offer the same
    settings link, not a raw error. It is the mark and not the "not connected"
    wording that earns the link.
