# Plan: Hive as the Berdloop engine

Written 2026-09-17. Steps 2 to 5 are built and tested.
Revised 2026-09-17: two-way resume dropped; see section 6.
Steps 0, 1 and 6 onward wait on the section 10 decision.

## 1. The short answer

Yes, it is possible. But not the way it first looks.

Hive can be the **controller**. It cannot be the **agent**.

Use Hive for the plan, the ledger, and the restart logic. Use the real
`claude` and `codex` programs for the work. This split is what lets a person
use the subscription they already pay for.

## 2. What Hive is

Hive is a Python program. It is Apache 2.0. It is active.

| Part | Fact | Where |
| --- | --- | --- |
| Server | aiohttp, REST + SSE, port 8787, no websocket | `core/framework/server/app.py:894` |
| Headless | Works with no frontend built | `core/framework/server/app.py:1147` |
| Agent loop | One class, `AgentLoop` | `core/framework/agent_loop/agent_loop.py:709` |
| Workers | `asyncio.Task` in the same process, cap 4 | `core/framework/host/worker.py:770` |
| Ledger | SQLite per colony, WAL mode | `~/.hive/colonies/<name>/data/tracker.db` |
| Plan | JSON file per session | `{session_dir}/tasks.json` |
| Model layer | Abstract class, 3 methods | `core/framework/llm/provider.py:86` |
| Tools | MCP, stdio / HTTP / socket / SSE | `core/framework/loader/mcp_client.py` |
| Terminals | PTY sessions + job manager, already built | `tools/src/terminal_tools/pty/` |
| Python | 3.11, uv workspace, 141 locked packages | `uv.lock` |

## 3. The problem you must know about

Hive already has a "use your subscription" feature. Do not use it.

It works by **taking the OAuth token out of your Keychain**. It reads the
`Claude Code-credentials` entry, gets an `sk-ant-oat...` token, and calls the
Anthropic API directly with fake Claude Code billing headers.

Evidence: `core/framework/config.py:674`, `core/framework/llm/litellm.py:1540`.
The Codex path does the same with `~/.codex/auth.json`.

Two reasons to refuse it:

1. **Licence.** Anthropic's Agent SDK documentation says: "Unless previously
   approved, Anthropic does not allow third party developers to offer
   claude.ai login or rate limits for their products." Shipping this in
   Berdloop puts the product at risk.
2. **It gives you nothing you want.** A direct API call writes no session
   file. So no conversation would ever appear in Claude Code.

Set `use_claude_code_subscription: false` and `use_codex_subscription: false`.

## 4. How Orca does it

Orca is open source (`stablyai/orca`, MIT). Its own code is the proof.

- It reads `~/.claude/projects` to find sessions.
  File: `src/main/ai-vault/session-scanner-roots.ts`.
- It resumes by building a real command line and running the real program.
  File: `src/shared/agent-resume-launch-command.ts`.
- It never writes a fake session file.

So the rule is: **run the real program. Let the program write its own file.**

## 5. Architecture

```
Tauri window (React)
        |  Tauri IPC only
        v
Tauri backend (Rust)  <-- owns everything
        |
        +-- child process: hive serve  (127.0.0.1, random port)
        |        REST + SSE over localhost
        |
        +-- child process: berdloop-mcp  (stdio, loaded by Hive)
        |
        +-- child PTYs: claude / codex, one per worktree
        |
        +-- git worktrees, one per task
```

Rust is the only part that speaks HTTP. The web view speaks only Tauri IPC.
This keeps your current CSP unchanged. Your CSP already allows `ipc:` alone.

### Who does what

| Layer | Owner |
| --- | --- |
| Plan the work, split it into tasks | Hive Queen |
| Record what is done | Hive tracker (SQLite) |
| Survive a crash | Hive cursor + task plan |
| Ask a human | Hive Sentinel |
| Make a branch | Rust |
| Run an agent | Rust, real CLI in a PTY |
| Show the screen | React |

### The seam

Hive's Queen gets a new tool set through MCP. Berdloop supplies it.
Register it at run time with `POST /api/mcp/servers`.

Tools to write:

- `branch_create(goal)` -> makes a git worktree, returns its path
- `agent_start(worktree, harness, prompt)` -> starts a CLI, returns session id
- `agent_resume(session_id, prompt)` -> continues that CLI
- `agent_status(session_id)` -> running, done, or failed
- `diff_read(worktree)` -> the change so far
- `checks_run(worktree)` -> build and test result

The Queen then plans with these tools. It never writes code itself.

## 6. How agents are run

**Dropped 2026-09-17: two-way resume is no longer a requirement.** Earlier
versions of this plan required that a run started in Berdloop could be picked
up with `claude --resume` or `codex resume` in a plain terminal, and the other
way round. That is no longer wanted, which removes a constraint on isolation.
See section 6b.

Agents are the user's own `claude` and `codex` programs, run as child
processes. That part does not change: it is what lets a person use their own
subscription, and it is why we never touch their credentials.

Claude Code:

```
claude --setting-sources "" --strict-mcp-config --disable-slash-commands \
       --permission-mode bypassPermissions \
       --append-system-prompt <standing orders> \
       --print --verbose --output-format stream-json --input-format stream-json
```

The prompt goes in over standard input, which is also how the agent is steered
later. For Codex:

```
CODEX_HOME=<ours> codex exec --dangerously-bypass-approvals-and-sandbox \
       -c mcp_servers={} -c skills={} --json "<prompt>"
```

## 6b. Isolation

Agents run **dangerously on purpose**. An agent that stops to ask a question
cannot finish a task on its own, so permission prompts are turned off. That
makes isolation the thing keeping the user safe, not the prompt.

Measured on one real machine: an agent started without these flags inherited
**nine MCP servers, including Gmail, Google Drive and Google Calendar, and one
hundred and thirty three skills** — all of it live while permissions were
bypassed. With the flags above: no MCP servers, no skills, twenty five
built-in tools, no user hooks, and the subscription login still working.

| Harness | How | Note |
| --- | --- | --- |
| Claude Code | `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands` | Never `--bare`: it stops keychain reads, which kills subscription login. |
| Codex | `CODEX_HOME` set to a directory of ours, with only `auth.json` copied in | Isolates config, skills, plugins and MCP in one move. |

Now that two-way resume is gone, `CODEX_HOME` is the right answer. It was
avoided before only because it moves the session transcripts as well.

A person can hand individual things back through `Extensions`
(`packages/agent/src/harness.ts`). `extensions_scan` lists what they have, for
the page where they turn them on. Nothing is on by default.

Safety still rests on the worktree, and a worktree is **not** a sandbox. It
separates edits; it does not stop a command. That is a real limit, not an
oversight.

## 7. Linking Hive to Tauri safely

1. **Port.** Bind to `127.0.0.1` on a random free port. Never `0.0.0.0`.
   Rust picks the port, then passes it as `--port`.
2. **Token.** Make a 32-byte random token at launch. Give it to the child
   in an environment variable. Send it as a header on every call. Hive has
   no auth today, so add a small aiohttp middleware. About 20 lines.
3. **Lifetime.** Rust owns the child. Kill it when the window closes.
   Restart it if it dies. Hive resumes from its own cursor file.
4. **Readiness.** Poll one route until it answers, then show the UI.
5. **Isolation.** Set `HIVE_HOME` to a folder inside the Tauri app data
   directory. Do not share `~/.hive` with the user's own Hive install.
6. **Secrets.** The token never reaches the web view. Rust holds it.

## 8. Shipping Python inside a Tauri app

This is the largest cost. Be honest about it.

- Hive needs Python 3.11 and 141 packages.
- Do not try PyInstaller. `litellm` makes that painful.
- Ship the `uv` binary as a Tauri sidecar. On first launch run
  `uv python install 3.11` then `uv sync`. First launch needs the network.
- Expect a few hundred megabytes on disk. Measure it before you commit.

Measure it like this:

```
cd <hive clone> && uv sync && du -sh .venv core/.venv tools/.venv
```

## 9. Build order

| Step | Work | Proves |
| --- | --- | --- |
| 0 | Clone Hive, `./quickstart.sh`, `hive serve`, `curl` a route | Hive runs |
| 1 | Rust spawns `hive serve`, random port, token, health poll | The link works |
| 2 | Rust reads the two session folders, shows a list in React | Read interop — **done** |
| 3 | Rust runs `claude --session-id <uuid> -p` in a worktree, streams it | Write interop — **done** |
| 4 | Run a real agent through one task end to end | Proven — **done** |
| 6 | Write `berdloop-mcp`, register it, give the Queen the tools | Hive drives |
| 7 | Branch, Engineer, Review, Deploy as Queen task templates | The product |

Stop after step 5 and judge. Steps 0 to 5 need no Hive at all.

## 10. The question to answer first

**What model runs the Queen?**

The Queen must think. It needs a model. You cannot use the subscription
token trick (section 3). So there are three choices:

| Choice | Cost | Risk |
| --- | --- | --- |
| A. User supplies one API key, Queen only | Small. The Queen plans, it does not code. | User must hold a key. |
| B. Queen is also a `claude -p` process | None | Hive's loop is then unused. Grey area. |
| C. Drop Hive. Rust holds the plan. Claude Code is the Queen, with the Berdloop MCP tools. | None | You write the ledger and restart logic yourself. |

**Decision 2026-09-17: deferred.** Build steps 0 to 5 first. They need no
Hive and no model choice. Judge after you can see one task run end to end.

## 11. Honest note

Steps 0 to 5 give you the whole "conversations show up both ways" feature.
Hive adds nothing to them.

Hive earns its place only from step 6, and only if you want its plan file,
its SQLite ledger, its park and resume, its reminders, and its human
escalation. If you replace every Hive worker with a CLI process, you have
deleted Hive's one execution primitive. What is left is a plan file, a
database, an event bus, and a web server, carried by 141 Python packages.

That may still be a good trade. Decide it with open eyes.

## 12. Not planned here

Sandboxing. Windows and Linux paths. Merge and deploy rules. Cost limits.
Multiple accounts. Cloud execution.
