/** CLI coding agents worth considering for local session integration. */
export const harnessCatalog = [
  {
    id: "claude-code",
    name: "Claude Code",
    status: "sessions",
    url: "https://code.claude.com/docs/en/overview",
  },
  {
    id: "codex",
    name: "Codex",
    status: "sessions",
    url: "https://developers.openai.com/codex/cli",
  },
  { name: "OpenCode", status: "coming-soon", url: "https://opencode.ai/docs" },
  {
    name: "GitHub Copilot CLI",
    status: "coming-soon",
    url: "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli",
  },
  {
    name: "Cursor CLI",
    status: "coming-soon",
    url: "https://docs.cursor.com/en/cli/overview",
  },
  {
    name: "Antigravity CLI",
    status: "coming-soon",
    url: "https://cloud.google.com/blog/topics/developers-practitioners/choosing-your-surface-antigravity-20-antigravity-cli-antigravity-ide-or-antigravity-sdk",
  },
  {
    name: "Kiro CLI",
    status: "coming-soon",
    url: "https://kiro.dev/docs/cli/",
  },
  {
    name: "Junie CLI",
    status: "coming-soon",
    url: "https://junie.jetbrains.com/docs/junie-cli.html",
  },
  {
    name: "Qwen Code",
    status: "coming-soon",
    url: "https://github.com/QwenLM/qwen-code/blob/main/docs/users/overview.md",
  },
  { name: "Amp", status: "coming-soon", url: "https://ampcode.com/docs/cli" },
  {
    name: "Aider",
    status: "coming-soon",
    url: "https://github.com/Aider-AI/aider",
  },
  {
    name: "goose",
    status: "coming-soon",
    url: "https://block.github.io/goose/",
  },
  {
    name: "Kilo Code",
    status: "coming-soon",
    url: "https://kilo.ai/docs/code-with-ai/platforms/cli",
  },
  {
    name: "Factory Droid",
    status: "coming-soon",
    url: "https://docs.factory.ai/droid-cli/overview",
  },
  {
    name: "Pi",
    status: "coming-soon",
    url: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
  },
] as const;

export const sessionHarnesses = harnessCatalog.filter(
  (harness) => harness.status === "sessions",
);
