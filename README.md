# Berdloop

**Set the course. The flock takes it from there.**

Berdloop means **Branch, Engineer, Review, Deploy**. It is a desktop app for agent tasks. Plan the work, give new instructions, and check each step from branch to deploy.

This repository contains a working application foundation. Local parent tasks and agent tasks are available in the desktop interface, including its browser preview. The native app can import a single Jira Cloud, Linear, or Asana ticket by ID. Agent execution and pull request automation are available in the native app; planner and provider synchronization flows are still in development.

## Stack

- Bun **1.4.0** workspaces and package manager.
- React **19.3.0**, TypeScript **7.0.2**, and Vite **8.3.0**.
- Tauri **2.11.5** Rust core, **2.11.4** CLI, and **2.11.1** JavaScript API. These packages have separate release versions.
- Mantine **9.6.1** for shared components and styling. Forms, dates, notifications, spotlight, dropzone, and charts are installed in the UI workspace.

Use [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) to prepare your operating system. The macOS build requires Xcode command line tools and Rust. Windows requires the Microsoft C++ build tools and WebView2. Linux requires the packages listed in the Tauri guide.

## Run locally

Install Bun 1.4, Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/). The Make commands require Make and Python 3 on macOS or Linux.

Run these commands from the repository root:

```sh
make install                  # Install dependencies for all app and shared-package workspaces
make up                       # Start the website and native desktop app
make desktop                  # Start only the native desktop app (foreground)
make logs                     # Follow startup and application logs
make test                     # Run all project checks
make down                     # Stop the managed development processes
```

`make up` runs in the background. It starts the website at <http://127.0.0.1:5173> and the desktop frontend at <http://127.0.0.1:1420>. The native desktop window opens when Rust compilation finishes. The first build can take longer. Use `make logs` to check its progress.

Run `make up` again to check whether the development processes are already running. `make down` stops only the process group started by `make up`, including the native app and its frontend server. If either main process exits, the supervisor stops the other process too.

Logs are appended to `.berdloop/dev.log`. Press **Ctrl+C** to stop `make logs`; the apps continue to run. The `.berdloop/` directory is excluded from Git. Start `make up` again after `make down` to restart the apps.

`make desktop` runs the native app and its frontend server in the foreground. Stop it with **Ctrl+C**. Do not run it alongside `make up`, since both use the desktop port; `make down` does not stop `make desktop`.

For a single app, or on Windows, use the Bun commands directly:

```sh
bun run dev:web          # Website only
bun run dev:desktop      # Native desktop app and its frontend server
bun run dev:desktop:web  # Desktop frontend only, in a browser
```

These commands run in the foreground. Stop them with **Ctrl+C**. Do not run them alongside `make up`: the ports are the same. `make down` does not stop servers started separately.

The packaged app includes the `berdloop-worker` helper as a Tauri sidecar. `bun run build:desktop` first runs `bun run sidecar`, which builds the helper and copies it to `apps/desktop/src-tauri/binaries/`. That directory is not in Git. A plain `cargo` build writes a placeholder script there so the crate can compile. The placeholder only prints an error. The app refuses to start agents with a placeholder, so run `bun run build:desktop` to make a real bundle.

## Repository

```text
apps/
  desktop/            React desktop interface and Tauri host
    src-tauri/        Rust commands, capabilities, icons, and configuration
  web/                Public React website
packages/
  core/               Task graph, persistence contracts, stage assignments, merge evidence rule
  ui/                 Shared Mantine theme, provider, logo, and loop rail
context/              Local product notes and research (ignored by Git)
```

The website and desktop app have separate entry points. Both use the shared theme. Task creation is in the desktop interface, which also runs at `bun run dev:desktop:web` for browser testing. The public website does not host the task workspace. Native APIs stay in the desktop app.

## Task workspace

### Ticket workflow

The workflow starts with a ticket. The loop pins the project you start it from. It picks the top ticket of that project, or the ticket you point it at with **Work on this**. Moving to another project in the window does not move the work. Pause the loop and start it again to change the project.

A ticket with no tasks gets its planning agent started once. The planning agent adds tasks with `task-add`. The loop gives each ready task to a fresh worker in its own worktree, in the order the queue shows. A dependency or a full worker slot always wins over the order. Each worker builds, tests, commits, and asks for a place in the merge queue. At its turn it merges the ticket branch into its worktree, fixes conflicts there, and moves the ticket branch onto its work. Completed worktrees are removed. Blocked worktrees are kept.

When all tasks are complete, the loop pushes the ticket branch to the project's `origin` remote and creates one pull request with `gh`. An existing PR is reused. The ticket goes to **review**. An independent review agent reads the published commit in a detached worktree and submits its result with `pr-review-submit`. Findings become priority tasks on the same ticket. When they are complete, the loop pushes again, and the new commit is reviewed again. An earlier approval never applies to a newer commit.

The final merge follows the ticket's **merge policy**, saved with the ticket:

- **Manual**: the PR waits for a person. The loop notices when it is merged and completes the ticket.
- **Automatic**: the loop merges the PR only when the reviewed commit is still the PR head, the review is approved, every check on the forge passed, and the forge reports the branch as clean. Branch protection on the forge is never bypassed.

A merged PR completes the ticket, and the loop starts the next queued ticket. Publication needs `git` access to the remote and a signed-in GitHub CLI (`gh auth login`). If either is missing, the loop shows the error and retries. No PR is created twice. Other forges are not supported yet. Cloud sync of the workspace is not active; the native workspace is saved locally only.

### Worker worktrees

Each worker gets a new worktree of the private staging repository. Before the agent starts, Berdloop prepares the worktree:

1. It links the paths listed in `.agents/linked` (or `.delta/linked`) from your repository into the worktree. One repository-relative path per line. Only ignored paths are linked. Use this for `.env` and other local files.
2. It runs `.agents/prepare` (or `.delta/prepare`) in the worktree when the script exists and is executable. When there is no script, it runs the install command for the lockfile it finds: `bun`, `pnpm`, `yarn`, `npm`, `uv`, or `poetry`. This repository uses `.agents/prepare` to run `bun install --frozen-lockfile`.

A failed prepare step does not stop the worker. The error is recorded and the worktree stays usable.

The staging repository has one remote, named `local`. It points at your repository folder on disk. Task branches never leave the staging repository. The finished ticket branch reaches your repository through `local` only. GitHub is used later, from your repository, to open the pull request.

Each worker thread has a **Changes** panel. Select the base: **Ticket branch** shows only what this worker changed, **Last commit** shows uncommitted edits, and **Last turn** shows edits since the agent's last turn started. Mark a file **Seen** to fold it. A new edit to that file clears the mark. Click a line to quote it in the composer. The file path and line number go to the worker with your message.

- Create or import a ticket, then open it to see its agent tasks.
- Use direct navigation for requirements, agent tasks, the merge queue, and PR review.
- Expand or collapse the ticket agent above the ticket queue and the planning agent above a ticket's task queue.
- Add, edit, assign, reorder, and remove queued agent tasks, including their prompts, acceptance criteria, and dependencies.
- Open individual agent threads, with active work above queued tasks and completed work below.
- Save instructions for the ticket agent, planner, one worker, or all ticket workers. Disconnected instructions are clearly marked as not sent.
- Choose a harness and enter a model identifier for each stage.

The workflow UI accepts live activity and text snapshots through the native runtime adapter. Ticket start/pause/resume use the same command a ticket agent uses, so the two cannot disagree. Agent stop controls also require that connection. The agent system is a separate implementation; see [the UI handoff](apps/desktop/WORKFLOW-UI.md) for its props, events, and local draft storage.

Parent and agent tasks use a versioned workspace store. Tauri saves it as `tasks.v1.json` in the operating system's app data directory, using a temporary file and rename. The browser preview saves it in local storage. Older non-sample preview drafts are loaded when no workspace exists. Browser and native stores are separate. Organization, project, note, and setting previews still use local storage.

Native ticket import reads one issue from [Jira Cloud](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Linear](https://linear.app/developers/graphql), or [Asana](https://developers.asana.com/reference/gettask). Enter a provider access token for each import; the token is used for that request and is not saved. Imported issues keep their provider ID and URL, so importing the same issue again updates its provider snapshot without replacing its local agent tasks. The import does not create provider subtasks or change provider status.

The cloud store contract is `GET` and `PUT /v1/task-workspaces/me` with bearer authentication. `TaskRepository` writes locally first and contacts the cloud store only with an account session. Cloud sync is not active until WorkOS sign-in and a task API are connected. Agent task status is a planning record; changing it does not run or stop an agent.

## Beta features

Berdloop can use a decision model for the small judgments that happen too often for a chat model. The model is [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev). It writes no text. It answers typed questions about a block of state and gives a probability with each answer. A call takes about 100 milliseconds and costs a fraction of a cent.

Open **Organization settings** and enter a key for one gateway. [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) and [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev) both serve the model. Either key is enough. With both, OpenRouter is used. Then turn on **Use the beta features**. Keys stay in `harness-settings.v1.json` beside the app and are never sent to the window.

One of these is a tool the agents can call. The rest are things Berdloop does for you.

**The `decide` tool.** A ticket agent, a planning agent, and the PR review agent are each given one extra command when the beta is on:

```sh
berdloop-worker decide --questions '<json>' --state '<text>'
```

They call it inside their normal Claude or Codex conversation, the same way they call `task-add` or `queue-show`, so the call and its answer are part of the transcript you are reading. Each question gets a value and a confidence. The agent decides what to do with the answer; the tool never acts on one.

It is there to make the conversation cheaper and faster, not to change what the agent does. Working out which of six tasks depends on which is a judgment the agent can reason through by itself. Asking this tool takes about a tenth of a second and a fraction of a cent instead. With no key, the tool is not in the agent's instructions at all, and the agent reasons it out as before.

Three more features run on their own:

- **Command approval.** A worker at `workspace` trust asks you before each command it cannot run. The model first reads the command. It clears only plainly read-only commands, and only when it is at least 95% sure. Everything else still comes to you. It can never refuse on its own, and a short list of destructive commands never reaches it.
- **Stall marking.** Each worker's recent output is read every 30 seconds. A worker that repeats itself and makes no progress is marked **Going in circles**. This is a label only. No agent is stopped or restarted.
- **Message routing.** When you send an instruction, the model reads where it was aimed. If another chat fits better, a notice says so. Your message still goes where you sent it.

And two buttons you press yourself. **Order by dependency**, above the ticket queue, puts the queued tickets in the order their features build on each other. **Order by priority**, above the agent tasks, puts the queued tasks in order of urgency and what each one needs first. Merge conflicts are not part of either, because workers resolve those themselves. Only queued work moves, and a queue of more than eight items is ordered down to the first eight.

The model can be wrong. It is calibrated, which means its confidence matches how often it is right, so each feature acts only above a threshold. Without a key, or with the switch off, every one of these paths behaves exactly as it did before.

## Accounts and collaboration

On first launch, choose **Local only** to use organizations, projects, and tasks without an account. The choice is saved on the device. Local-only mode hides member, invitation, and project-sharing controls.

WorkOS is a stub in this version. Sign-up and sign-in are not connected, and the app cannot create shared organizations, invite members, or sync task workspaces yet. The collaboration gate accepts only a WorkOS session; no local preview state grants shared access. Organization and project IDs are carried through the share entry points so they can be connected to the future multi-tenant service.

## Verify and build

```sh
make test                # Type checks, tests, web builds, formatting, Rust checks
bun run build:desktop    # Native release bundle for this operating system
```

Website output is in `apps/web/dist`. Desktop frontend output is in `apps/desktop/dist`. Native output is in `apps/desktop/src-tauri/target/release/bundle`. Release signing and notarization are not configured.

The merge evidence rule requires passing checks and an approved review for the same revision. A new commit invalidates earlier evidence. The native `ticket_pr_sync` command enforces this rule before an automatic merge. Its tests run against temporary repositories and a fake `gh`; set `BERDLOOP_GH` to point the app at a different forge command.

## Next

- **Rewind a thread.** Return a worker conversation and its worktree to an earlier turn together. Berdloop already records a tree snapshot at the start of each turn for the **Last turn** diff. Rewind would keep those snapshots per turn, reset the worktree to the chosen one, and cut the conversation after that turn. Not implemented.

## UI decision

[Mantine](https://mantine.dev/) is the best fit for this foundation: it supplies a broad component set and first-party packages for common application needs. [shadcn/ui](https://ui.shadcn.com/docs) is a strong option when source ownership and bespoke composition are the priority. [Material UI](https://mui.com/material-ui/getting-started/) is a strong option for Material Design applications. The choice here favors ready-made application components and a shared desktop/web theme.

Product copy uses short, active sentences and a controlled technical vocabulary based on ASD-STE100 principles. It has not received a formal STE dictionary audit. Product notes and the terminology guide are in the local `context/` directory.
