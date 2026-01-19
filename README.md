# Kode Review CLI

AI-powered code review CLI using OpenCode SDK with Antigravity support.

## Features

- **AI-Powered Reviews**: Uses OpenCode SDK to run comprehensive code reviews
- **Antigravity Integration**: Free access to Claude and Gemini models via Google OAuth
- **Multi-Platform VCS**: Supports GitHub PRs and GitLab MRs
- **Interactive & Agent Modes**: Works interactively or in CI/automation pipelines
- **Onboarding Wizard**: Guided setup for providers and VCS integration

## Requirements

- **Node.js 18+**
- **Bun** (recommended) or npm
- **Git**
- **OpenCode CLI** - Install with:
  ```bash
  curl -fsSL https://opencode.ai/install | bash
  # or
  bun install -g opencode-ai
  ```
- **Optional:** GitHub CLI ([`gh`](https://cli.github.com/)) and/or GitLab CLI ([`glab`](https://gitlab.com/gitlab-org/cli))

## Installation

Install from source (not yet published to npm):

```bash
# Clone the repository
git clone https://github.com/kofikode/kode-review-cli.git
cd kode-review-cli

# Install dependencies and build
bun install
bun run build

# Link globally for CLI access
bun link
```

## Quick Start

```bash
# First run triggers onboarding wizard
kode-review

# Review local changes
kode-review --scope local

# Review a specific PR/MR
kode-review --scope pr --pr 123

# Review both local changes and PR/MR
kode-review --scope both
```

## Usage

### Interactive Mode (Default)

When run in a terminal, `kode-review` provides an interactive experience:

1. First run triggers the onboarding wizard
2. Prompts for scope selection when multiple options are available
3. Shows colored output with progress indicators

### Agent/CI Mode

For automation and coding agents, use non-interactive flags:

```bash
# Quiet mode - minimal output
kode-review --scope local --quiet

# JSON mode - errors as JSON
kode-review --scope pr --pr 123 --json

# Override model for single run
kode-review --provider google --model antigravity-claude-sonnet-4-5-thinking --variant max
```

### CLI Options

| Flag | Description |
|------|-------------|
| `-s, --scope <scope>` | Review scope: `local`, `pr`, `both`, `auto` (default: auto) |
| `-p, --pr <number>` | Specific PR/MR number to review |
| `-q, --quiet` | Minimal output (agent-friendly) |
| `-j, --json` | JSON error output |
| `--provider <id>` | Override provider (e.g., `anthropic`, `google`) |
| `--model <id>` | Override model |
| `--variant <name>` | Override variant (e.g., `max`, `low`) |
| `--attach <url>` | Connect to running OpenCode server |
| `-w, --watch` | Watch mode: monitor for PRs/MRs where you are a reviewer |
| `--watch-interval <sec>` | Polling interval in seconds (default: 300) |
| `--watch-interactive` | Prompt to select PR/MR instead of auto-reviewing |
| `--setup` | Re-run full onboarding wizard |
| `--setup-provider` | Re-configure provider/model only |
| `--setup-vcs` | Re-configure GitHub/GitLab only |
| `--reset` | Reset all configuration |

## Watch Mode

Watch mode monitors for PRs/MRs where you are assigned as a reviewer across all repositories.

```bash
# Start watching with default 5-minute polling interval
kode-review --watch

# Custom polling interval (1 minute)
kode-review --watch --watch-interval 60

# Interactive mode - prompt to select which PR/MR to review
kode-review --watch --watch-interactive

# Quiet mode for background monitoring
kode-review --watch --quiet
```

**Features:**
- Polls both GitHub and GitLab simultaneously (if both CLIs are authenticated)
- Persists reviewed PR/MR state to disk to avoid duplicates across restarts
- Auto-detects VCS CLI authentication on first run
- Graceful shutdown on Ctrl+C (waits for current review to complete)
- Retries transient errors (network, timeout) in the next poll cycle

**State file:** `~/.config/kode-review-watch/config.json`

## Onboarding

The first run of `kode-review` triggers an interactive onboarding wizard. You can also run it manually with `kode-review --setup`.

### Step 1: Provider Selection

Choose your LLM provider:

- **Antigravity (Recommended)** - Free access to premium models via Google OAuth
- **Standard Providers** - Anthropic, Google, OpenAI, or OpenCode Zen (requires direct authentication)

### Step 2: VCS Integration

The wizard detects GitHub CLI (`gh`) and GitLab CLI (`glab`) and checks their authentication status. This enables:

- Reviewing PRs/MRs directly
- Auto-detecting the platform from git remote

## Configuration

Configuration is stored in `~/.config/kode-review/config.json`.

### Antigravity Setup

Antigravity provides free access to premium models via Google OAuth:

**Available Models:**
- Claude Sonnet 4.5 / Opus 4.5 (with thinking variants: `low`, `max`)
- Gemini 3 Pro (with thinking variants: `low`, `high`)
- Gemini 3 Flash (with thinking variants: `minimal`, `low`, `medium`, `high`)

When you select Antigravity during onboarding:

1. Installs the `opencode-antigravity-auth@beta` plugin into OpenCode
2. Opens browser for Google OAuth authentication
3. Prompts for model selection
4. Prompts for thinking variant (budget level) if applicable

### VCS Integration

GitHub and GitLab CLI tools are detected automatically. If authenticated, you can:

- Review PRs/MRs directly
- Auto-detect which platform based on git remote

To set up later: `kode-review --setup-vcs`

## Review Output

Reviews include:

- **Summary**: Overview of changes and quality
- **Issues Found**: Categorized by severity (CRITICAL, HIGH, MEDIUM, LOW)
  - Security issues
  - Bugs & logic errors
  - Code quality problems
  - Convention violations
- **Positive Observations**: Things done well
- **Final Verdict**: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION with merge recommendation

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_SERVER_URL` | Attach to running OpenCode server |
| `OPENCODE_MODEL` | Default model override |

## Examples

### As a Git Hook

```bash
#!/bin/bash
# .git/hooks/pre-push

kode-review --scope local --quiet || {
  echo "Code review found issues. Push anyway? (y/N)"
  read response
  [[ "$response" =~ ^[Yy]$ ]] || exit 1
}
```

### From a Coding Agent

Coding agents can invoke `kode-review` as a skill or tool:

```bash
# Non-interactive, JSON errors
kode-review --scope both --quiet --json
```

## License

MIT
