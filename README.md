<p align="center">
  <img src="packages/ui/bird-logo.svg" alt="Berdloop bird" width="76" height="76" />
</p>

<h1 align="center">Berdloop</h1>

<p align="center">
  <strong>Set the course. The flock takes it from there.</strong><br />
  A local-first desktop workspace that takes coding tasks from a ticket to one reviewed pull request.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://github.com/soccer99/berdloop/actions/workflows/ci.yml"><img alt="Verify" src="https://github.com/soccer99/berdloop/actions/workflows/ci.yml/badge.svg" /></a>
</p>

## Why Berdloop?

Agent work gets hard to follow when the plan, conversations, branches, and reviews live in different places. Berdloop gives each ticket a clear path through them. Plan tasks with acceptance criteria and dependencies, watch workers build in separate Git worktrees, steer their conversations, and review the combined result in one pull request.

**Your machine. Your agent tools. Your control.** Berdloop runs locally and works with Claude Code and Codex sessions. It keeps the ticket workspace on your device; you choose when to start, pause, review, and merge work.

> [!NOTE]
> Berdloop is an early project. The native app runs local workers and the GitHub PR flow. The public website is a product preview. Cloud agents, shared organizations, workspace sync, and updates back to source issue trackers are not available yet.

## How it works

```text
Ticket → plan agent tasks → workers in separate worktrees
       → ordered merge queue → one ticket branch → one GitHub PR
       → independent review → manual or guarded automatic merge
```

1. **Bring in a ticket.** Create one locally or import an individual issue from Linear, Jira Cloud, or Asana. Keep its requirements and source reference together.
2. **Plan the work.** Add agent tasks with prompts, acceptance criteria, and dependencies. A planning agent can create tasks for an empty ticket.
3. **Build in parallel.** Ready tasks go to workers in separate worktrees. Follow each conversation and its code changes, and send instructions to a worker, the planner, or all workers on a ticket.
4. **Merge in order.** Workers join a merge queue, resolve conflicts when their turn comes, and bring completed changes onto the ticket branch.
5. **Review one PR.** Berdloop publishes the ticket branch to GitHub and reuses a single PR. An independent review agent checks the published revision; findings return to the task queue. A new revision requires a new review.
6. **Finish under your policy.** Leave the PR for a person to merge, or allow an automatic merge only after the current revision is approved, checks pass, and GitHub reports a clean merge.

### What is available today

| Area           | Current support                                                               |
| -------------- | ----------------------------------------------------------------------------- |
| Coding agents  | Local Claude Code and Codex sessions; harness and model preferences per role  |
| Ticket sources | Local tickets and one-at-a-time imports from Linear, Jira Cloud, and Asana    |
| Git workflow   | Isolated worker worktrees, ticket merge queue, GitHub PR creation and review  |
| Storage        | Local native workspace; browser preview uses separate local storage           |
| Collaboration  | Local-only mode; sign-in, shared workspaces, and cloud sync are not connected |

Other agent harnesses are listed in the app as coming soon. GitLab may be used as a project source, but automated PR publishing and review currently require GitHub.

## Get started

### Prerequisites

- [Bun 1.4](https://bun.sh/) and [Rust](https://rustup.rs/).
- [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system.
- [Git](https://git-scm.com/) and at least one supported agent CLI: [Claude Code](https://code.claude.com/docs/en/overview) or [Codex](https://developers.openai.com/codex/cli). Sign in to the agent CLI you plan to use.
- For PR publishing and merging: a GitHub `origin` remote and the [GitHub CLI](https://cli.github.com/) signed in with `gh auth login`.

Clone and run the native app:

```sh
git clone https://github.com/soccer99/berdloop.git
cd berdloop
bun install --frozen-lockfile
bun run dev:desktop
```

The first native build can take a few minutes. To explore the interface in a browser without native agent execution, run `bun run dev:desktop:web`. The separate public landing page runs with `bun run dev:web`.

### Run your first ticket

1. In Berdloop, choose **Local only** and add a project by opening a local Git repository or cloning one.
2. Create a ticket, or import one issue. Add requirements and agent tasks, or let the planning agent break down an empty ticket.
3. Choose the harness and model for each role in settings. Start the ticket loop from its project and follow the worker threads and Changes panels.
4. Review the ticket PR and choose its merge policy. Publishing needs push access to the project's GitHub remote and an authenticated `gh` CLI.

The project you run agents against is separate from this Berdloop source repository. Workers use that project's Git history and local setup. To prepare each worker, Berdloop runs its executable `.agents/prepare` or `.delta/prepare` script when present; otherwise it installs dependencies based on the project's lockfile. See [this repository's example](.agents/prepare).

## Development

From the repository root:

| Command                   | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `bun run dev:web`         | Run the public landing page                                     |
| `bun run dev:desktop`     | Run the native Tauri app and desktop frontend                   |
| `bun run dev:desktop:web` | Preview the desktop interface in a browser                      |
| `bun run check`           | Typecheck, run JavaScript tests, and build both frontends       |
| `make test`               | Run the full project gate, including formatting and Rust checks |
| `bun run build:desktop`   | Build a native release bundle with the worker sidecar           |

On macOS or Linux, `make install`, `make up`, `make logs`, and `make down` provide a managed background development session. `make up` starts the website at `http://127.0.0.1:5173` and the desktop frontend at `http://127.0.0.1:1420`; the native window opens after Rust compiles. `make desktop` runs only the native app in the foreground. See `make help` for the full list.

```text
apps/web/                 Public landing page
apps/desktop/             React desktop interface and Tauri host
packages/agent/           Agent harnesses, prompts, and tools
packages/core/            Task model and workflow rules
packages/state/           Local state utilities
packages/ui/              Shared theme and components
.berd/                    Example per-worker development configuration
```

The packaged desktop app includes `berdloop-worker` as a sidecar. Use `bun run build:desktop` for a real native bundle; a plain Cargo build creates only a placeholder sidecar. The website and desktop app have separate entry points, and the public website does not host the task workspace.

## Contributing

Issues and pull requests are welcome for bug fixes, documentation, and features. Please open an issue before starting a substantial change so the scope can be discussed. Run `make test` before submitting a PR; CI also checks the frontends and Rust code.

Contributions to this repository are distributed under the same [noncommercial license](LICENSE.md). Review those terms before submitting code.

## License

Berdloop is **source available**, not OSI open source. It is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, modify, and share it for noncommercial purposes, including work on other open source projects. **Commercial use is not permitted.** An open source project's license does not, by itself, make a commercial use of Berdloop permissible.

The full license text governs; this summary is for orientation. Third-party dependencies retain their own licenses.
