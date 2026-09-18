# Berdloop

**Set the course. The flock takes it from there.**

Berdloop means **Branch, Engineer, Review, Deploy**. It is a desktop app for agent tasks. Plan the work, give new instructions, and check each step from branch to deploy.

This repository contains a working application foundation. Local parent tasks and agent tasks are available in the desktop interface, including its browser preview. The native app can import a single Jira Cloud, Linear, or Asana ticket by ID. Agent execution, planner replies, source ticket updates, and pull request automation are still in development.

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

### Planned ticket workflow

The target workflow starts with a Linear ticket. Agent chat works through its requirements, creates agent tasks, and prepares a ticket branch. Subagent Ralph loop workers take available agent tasks in separate worktrees based on that branch. Each worker builds, tests, confirms its result, and requests a place in a merge queue. At its turn, the worker resolves conflicts if needed and merges into the ticket branch. Its worktree and branch are then removed, and it takes another available agent task.

When all agent tasks are complete, Berdloop creates one pull request for the ticket branch. An independent review agent checks the PR in a CodeRabbit-like role. The final PR is merged by a human when manual merge is configured, or by automatic merge when its required conditions pass. Worker merges into the ticket branch and the final PR merge are separate steps. This workflow is product direction; the current app does not run these agents or merges yet. The local product memory is in [context/07-product-direction.md](context/07-product-direction.md).

- Create or import a ticket, then open it to see its agent tasks.
- Use direct navigation for requirements, agent tasks, the merge queue, and PR review.
- Expand or collapse the ticket agent above the ticket queue and the planning agent above a ticket's task queue.
- Add, edit, assign, reorder, and remove queued agent tasks, including their prompts, acceptance criteria, and dependencies.
- Open individual agent threads, with active work above queued tasks and completed work below.
- Save instructions for the ticket agent, planner, one worker, or all ticket workers. Disconnected instructions are clearly marked as not sent.
- Choose a harness and enter a model identifier for each stage.

The workflow UI accepts live activity and text snapshots through an optional runtime adapter. Ticket start/pause/resume and agent stop controls require that connection. The agent system is a separate implementation; see [the UI handoff](apps/desktop/WORKFLOW-UI.md) for its props, events, and local draft storage.

Parent and agent tasks use a versioned workspace store. Tauri saves it as `tasks.v1.json` in the operating system's app data directory, using a temporary file and rename. The browser preview saves it in local storage. Older non-sample preview drafts are loaded when no workspace exists. Browser and native stores are separate. Organization, project, note, and setting previews still use local storage.

Native ticket import reads one issue from [Jira Cloud](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Linear](https://linear.app/developers/graphql), or [Asana](https://developers.asana.com/reference/gettask). Enter a provider access token for each import; the token is used for that request and is not saved. Imported issues keep their provider ID and URL, so importing the same issue again updates its provider snapshot without replacing its local agent tasks. The import does not create provider subtasks or change provider status.

The cloud store contract is `GET` and `PUT /v1/task-workspaces/me` with bearer authentication. `TaskRepository` writes locally first and contacts the cloud store only with an account session. Cloud sync is not active until WorkOS sign-in and a task API are connected. Agent task status is a planning record; changing it does not run or stop an agent.

## Accounts and collaboration

On first launch, choose **Local only** to use organizations, projects, and tasks without an account. The choice is saved on the device. Local-only mode hides member, invitation, and project-sharing controls.

WorkOS is a stub in this version. Sign-up and sign-in are not connected, and the app cannot create shared organizations, invite members, or sync task workspaces yet. The collaboration gate accepts only a WorkOS session; no local preview state grants shared access. Organization and project IDs are carried through the share entry points so they can be connected to the future multi-tenant service.

## Verify and build

```sh
make test                # Type checks, tests, web builds, formatting, Rust checks
bun run build:desktop    # Native release bundle for this operating system
```

Website output is in `apps/web/dist`. Desktop frontend output is in `apps/desktop/dist`. Native output is in `apps/desktop/src-tauri/target/release/bundle`. Release signing and notarization are not configured.

The merge evidence tests require passing tests and an approved review for the same revision. A conflict fix invalidates earlier evidence. This is a domain rule for the future executor; it does not merge pull requests today.

## UI decision

[Mantine](https://mantine.dev/) is the best fit for this foundation: it supplies a broad component set and first-party packages for common application needs. [shadcn/ui](https://ui.shadcn.com/docs) is a strong option when source ownership and bespoke composition are the priority. [Material UI](https://mui.com/material-ui/getting-started/) is a strong option for Material Design applications. The choice here favors ready-made application components and a shared desktop/web theme.

Product copy uses short, active sentences and a controlled technical vocabulary based on ASD-STE100 principles. It has not received a formal STE dictionary audit. Product notes and the terminology guide are in the local `context/` directory.
