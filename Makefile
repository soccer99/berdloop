.DEFAULT_GOAL := help
.PHONY: install up desktop down test logs help

install: ## Install dependencies for all Bun workspaces
	bun install --frozen-lockfile

up: ## Start the website and native desktop app in the background
	@python3 scripts/dev.py up

desktop: ## Start only the native desktop app in the foreground
	bun run dev:desktop

down: ## Stop the processes started by make up
	@python3 scripts/dev.py down

test: ## Run type checks, tests, builds, formatting checks, and Rust checks
	bun run check
	bun run format:check
	cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
	cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
	cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml

logs: ## Follow development logs (Ctrl+C stops following, not the apps)
	@python3 scripts/dev.py logs

help: ## Show the available commands
	@printf 'make install  Install dependencies for all workspaces\nmake up       Start website and native desktop app\nmake desktop  Start native desktop app only (foreground)\nmake down     Stop managed development processes\nmake test     Run project checks\nmake logs     Follow development logs\n'
