# Kode Review CLI

AI-powered code review CLI using OpenCode SDK with Antigravity support.

## Features

- **AI-Powered Reviews**: Uses OpenCode SDK to run comprehensive code reviews
- **Antigravity Integration**: Free access to Claude and Gemini models via Google OAuth
- **Multi-Platform VCS**: Supports GitHub PRs and GitLab MRs
- **Interactive & Agent Modes**: Works interactively or in CI/automation pipelines
- **Onboarding Wizard**: Guided setup for providers and VCS integration

## Requirements

- Node.js 18+
- [OpenCode](https://opencode.ai) installed
- Git
- Optional: GitHub CLI (`gh`) and/or GitLab CLI (`glab`)

## Installation

```bash
bun install -g @kofikode/kode-review-cli
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
| `--setup` | Re-run full onboarding wizard |
| `--setup-provider` | Re-configure provider/model only |
| `--setup-vcs` | Re-configure GitHub/GitLab only |
| `--reset` | Reset all configuration |

## Configuration

Configuration is stored in `~/.config/kode-review/config.json`.

### Antigravity Setup

Antigravity provides free access to premium models via Google OAuth:

- Claude Sonnet 4.5 / Opus 4.5 (with thinking)
- Gemini 3 Pro / Flash

When you select Antigravity during onboarding:

1. The `opencode-antigravity-auth` plugin is configured
2. Browser opens for Google OAuth
3. Model definitions are added to your OpenCode config

### VCS Integration

GitHub and GitLab CLI tools are detected automatically. If authenticated, you can:

- Review PRs/MRs directly
- Auto-detect which platform based on git remote

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

### In CI/CD

```yaml
# GitHub Actions
- name: Code Review
  run: |
    bun install -g @kofikode/kode-review-cli
    kode-review --scope pr --pr ${{ github.event.pull_request.number }} --quiet
```

### From a Coding Agent

Coding agents can invoke `kode-review` as a skill or tool:

```bash
# Non-interactive, JSON errors
kode-review --scope both --quiet --json
```

## License

MIT
