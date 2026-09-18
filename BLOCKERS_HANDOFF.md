# Blocker fixes: status

Snapshot: September 18, 2026. Repository: `/Users/bradyendres/code/berdloop`.

All seven findings in `CODE_REVIEW.md` are fixed in the working tree. That file lists each fix and its evidence. This file keeps only what a person still has to do.

## Checks that passed

```sh
make test                       # 113 JS tests, 85 Rust tests (3 ignored), builds, format, cargo check --locked
bunx tauri build --bundles app  # bundle holds berdloop and berdloop-worker
```

## Before the first real run

1. Link a project whose checkout has an `origin` remote you can push to.
2. Sign in to the GitHub CLI: `gh auth login`. Publication and the final merge use `gh`.
3. Build a real bundle with `bun run build:desktop`, or run `cargo build --bins` for development. The app refuses to start agents if the worker helper is missing or is the build placeholder.
4. Set the ticket's merge policy on its **PR & review** tab. It is saved with the ticket. Manual is the default.

## Known limits

- Only GitHub is supported as a forge. Set `BERDLOOP_GH` to test with another command.
- The loop runs in the window. Closing the app stops new work; running workers finish and report to disk.
- Cloud sync of the workspace stays off until WorkOS sign-in exists.
- The `dmg` bundle target and Windows sidecar naming were not exercised.
- No real paid agent run or real pull request was made while fixing these. Do a supervised run on a scratch repository first.

No commit, push, real PR, or production agent run was performed for this work.
