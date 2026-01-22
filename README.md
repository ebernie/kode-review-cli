# Kode Review CLI

AI-powered code review CLI using OpenCode SDK with Antigravity support.

## Features

- **AI-Powered Reviews**: Uses OpenCode SDK to run comprehensive code reviews
- **Antigravity Integration**: Free access to Claude and Gemini models via Google OAuth
- **Multi-Platform VCS**: Supports GitHub PRs and GitLab MRs
- **Interactive & Agent Modes**: Works interactively or in CI/automation pipelines
- **Watch Mode**: Continuous monitoring for PRs/MRs where you're a reviewer
- **Semantic Code Indexer**: Optional Docker-based code indexing for contextual reviews

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
- **Optional:** [Docker](https://www.docker.com/products/docker-desktop/) (required for semantic code indexer)

## Installation

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

# Review with semantic context (requires indexer setup)
kode-review --with-context
```

---

## Usage

### Interactive Mode (Default)

When run in a terminal, `kode-review` provides an interactive experience with colored output and progress indicators. First run triggers the onboarding wizard.

### Agent/CI Mode

For automation, use non-interactive flags:

```bash
kode-review --scope local --quiet        # Minimal output
kode-review --scope pr --pr 123 --json   # JSON error output
```

### Review Options

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
| `--agentic` | Enable agent mode with dynamic codebase exploration |
| `--max-iterations <n>` | Max tool call iterations for agent mode (default: 10) |
| `--agentic-timeout <s>` | Timeout in seconds for agent mode (default: 120) |

---

## Watch Mode

Monitor for PRs/MRs where you are assigned as a reviewer.

```bash
kode-review --watch                      # Default 5-minute polling
kode-review --watch --watch-interval 60  # 1-minute polling
kode-review --watch --watch-interactive  # Prompt to select PR/MR
kode-review --watch --quiet              # Background monitoring
```

**Features:**
- Polls both GitHub and GitLab simultaneously (if both CLIs are authenticated)
- Persists reviewed state to avoid duplicates across restarts
- Graceful shutdown on Ctrl+C

| Flag | Description |
|------|-------------|
| `-w, --watch` | Enable watch mode |
| `--watch-interval <sec>` | Polling interval in seconds (default: 300) |
| `--watch-interactive` | Prompt to select PR/MR instead of auto-reviewing |

**State file:** `~/.config/kode-review-watch/config.json`

---

## Agent Mode

Agent mode enables dynamic codebase exploration during reviews. Instead of only seeing the diff, the AI can actively read files, search for patterns, and analyze code relationships.

```bash
# Basic agent mode (read_file tool only)
kode-review --agentic

# Agent mode with full tool suite (requires indexer)
kode-review --agentic --with-context

# With custom limits
kode-review --agentic --max-iterations 15 --agentic-timeout 180
```

### Available Tools in Agent Mode

| Tool | Description | Requires Indexer |
|------|-------------|------------------|
| `read_file` | Read file content from the repository | No |
| `search_code` | Hybrid semantic + keyword search | Yes |
| `find_definitions` | Find where symbols are defined | Yes |
| `find_usages` | Find all usages of a symbol | Yes |
| `get_call_graph` | Get function call relationships | Yes |
| `get_impact` | Analyze file dependencies | Yes |

### Agent Mode Options

| Flag | Description |
|------|-------------|
| `--agentic` | Enable agent mode |
| `--max-iterations <n>` | Max tool call iterations (default: 10) |
| `--agentic-timeout <s>` | Timeout in seconds (default: 120, max: 600) |

---

## Review Mode Comparison

Choose the review mode that fits your needs:

| Mode | Command | Description |
|------|---------|-------------|
| **Diff** | `kode-review` | Reviews the diff only |
| **Diff + Index** | `kode-review --with-context` | Reviews diff with pre-retrieved semantic context |
| **Agent** | `kode-review --agentic` | AI dynamically explores codebase |
| **Agent + Index** | `kode-review --agentic --with-context` | Full agent capabilities with all tools |

### Pros and Cons

<details>
<summary><strong>Diff Review (Default)</strong></summary>

**Pros:**
- Fastest execution time
- No additional setup required
- Predictable behavior and cost
- Lowest token usage

**Cons:**
- Limited context - only sees the diff
- May miss issues requiring broader codebase understanding
- Cannot verify naming conventions or patterns
- No impact analysis

**Best for:** Quick reviews, simple changes, CI pipelines where speed matters.

</details>

<details>
<summary><strong>Diff + Indexed Codebase</strong></summary>

**Pros:**
- Pre-retrieved context reduces AI decision overhead
- Consistent, reproducible context selection
- Better understanding of related code patterns
- Moderate execution time

**Cons:**
- Requires Docker and indexer setup
- Context is statically selected before review
- May include irrelevant context or miss important context
- Initial indexing takes time for large repos

**Best for:** Standard reviews where you want better context without longer review times.

</details>

<details>
<summary><strong>Agent Mode</strong></summary>

**Pros:**
- AI decides what to explore based on the changes
- Can read specific files for full context
- More thorough analysis for complex changes
- Provides evidence from exploration in findings

**Cons:**
- Only `read_file` tool without indexer
- Slower than diff-only mode
- Less predictable execution time and cost
- May not explore optimally without search tools

**Best for:** Complex changes where file reading is sufficient, no indexer setup desired.

</details>

<details>
<summary><strong>Agent Mode + Index</strong></summary>

**Pros:**
- Full tool suite: read, search, definitions, usages, call graph
- Deepest understanding of code impact
- Can verify patterns, find all callers, assess blast radius
- Most thorough reviews possible

**Cons:**
- Requires Docker and indexer setup
- Slowest execution time
- Highest cost (more tokens used)
- May over-explore for simple changes

**Best for:** Critical code reviews, security-sensitive changes, unfamiliar codebases, architectural changes.

</details>

### Quick Reference

| Aspect | Diff | Diff + Index | Agent | Agent + Index |
|--------|------|--------------|-------|---------------|
| Setup Required | None | Docker + Index | None | Docker + Index |
| Speed | Fast | Medium | Medium | Slow |
| Context Depth | Shallow | Medium | Medium | Deep |
| Cost (Tokens) | Low | Medium | Medium | High |
| Impact Analysis | No | Limited | No | Yes |
| Pattern Verification | No | Yes | No | Yes |
| File Reading | No | No | Yes | Yes |
| Search Capability | No | Pre-selected | No | Yes |

---

## Configuration

Configuration is stored in `~/.config/kode-review/config.json`.

### First-Time Setup

The first run triggers an interactive onboarding wizard, or run manually:

```bash
kode-review --setup           # Full wizard
kode-review --setup-provider  # Provider/model only
kode-review --setup-vcs       # GitHub/GitLab only
kode-review --reset           # Reset all configuration
```

### Provider Configuration

**Antigravity (Recommended)** - Free access to premium models via Google OAuth:
- Claude Sonnet 4.5 / Opus 4.5 (thinking variants: `low`, `max`)
- Gemini 3 Pro (thinking variants: `low`, `high`)
- Gemini 3 Flash (thinking variants: `minimal`, `low`, `medium`, `high`)

**Standard Providers** - Anthropic, Google, OpenAI, or OpenCode Zen (requires direct authentication)

### VCS Integration

GitHub CLI (`gh`) and GitLab CLI (`glab`) are detected automatically. This enables reviewing PRs/MRs directly and auto-detecting the platform from git remote.

---

## Semantic Code Indexer

The semantic code indexer is **optional**. It provides contextual information during reviews by finding related code from your codebase.

**Requirements:** Docker Desktop (macOS/Windows) or Docker Engine (Linux)

### Quick Start

```bash
# 1. Set up the indexer (one-time)
kode-review --setup-indexer

# 2. Index your repository
cd /path/to/your/repo
kode-review --index

# 3. Review with context
kode-review --with-context
kode-review --scope pr --pr 123 --with-context
```

### Indexer Options

| Flag | Description |
|------|-------------|
| `--setup-indexer` | Interactive setup wizard |
| `--index` | Index/update current repository |
| `--index-status` | Show indexer status |
| `--index-reset` | Drop and rebuild index for current repo |
| `--index-list-repos` | List all indexed repositories |
| `--indexer-cleanup` | Remove containers, volumes, and all data |
| `--with-context` | Include semantic context in review |
| `--context-top-k <n>` | Number of code chunks to include (default: 5) |
| `--index-branch <branch>` | Branch to index (default: current) |
| `--index-watch` | Continuous indexing (watch mode) |
| `--background-indexer` | Background daemon for large repos |
| `--index-queue` | Show pending background jobs |
| `--index-queue-clear` | Clear pending background jobs |

<details>
<summary><strong>How It Works</strong></summary>

The indexer runs as two Docker containers:
- **PostgreSQL with pgvector** - Stores code embeddings for semantic search
- **FastAPI server** - Handles indexing and search requests

When `--with-context` is enabled:
1. Extracts function names, class names, and imports from the diff
2. Searches the index for semantically similar code
3. Includes the most relevant chunks in the review prompt

The indexer scans: TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#

Excludes: `node_modules`, `dist`, `build`, `.git`, `vendor`, `target`

</details>

<details>
<summary><strong>Configuration Reference</strong></summary>

Settings in `~/.config/kode-review/config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `indexer.enabled` | `false` | Whether indexer is enabled |
| `indexer.apiPort` | `8321` | API server port |
| `indexer.dbPort` | `5436` | PostgreSQL port |
| `indexer.embeddingModel` | `sentence-transformers/all-MiniLM-L6-v2` | Embedding model |
| `indexer.chunkSize` | `1000` | Characters per chunk |
| `indexer.topK` | `5` | Default search results |
| `indexer.maxContextTokens` | `4000` | Max tokens for context |

</details>

<details>
<summary><strong>Upgrading the Indexer</strong></summary>

After pulling new versions of `kode-review`:

**Quick Upgrade (preserves data):**
```bash
kode-review --setup-indexer
```

**Full Reset (when you see schema errors or 500s):**
```bash
kode-review --indexer-cleanup
kode-review --setup-indexer
kode-review --index
```

**Force fresh Docker build:**
```bash
docker compose -p kode-review-indexer down
docker compose -p kode-review-indexer build --no-cache
docker compose -p kode-review-indexer up -d
```

**Verify upgrade:**
```bash
kode-review --index-status
kode-review --index-list-repos
```

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

**Indexer won't start:**
- Ensure Docker is running: `docker info`
- Check ports 8321/5436 are available
- View logs: `docker compose -p kode-review-indexer logs`

**Context not appearing in reviews:**
- Verify indexer is running: `kode-review --index-status`
- Ensure repository is indexed: `kode-review --index`

**API shows "Unhealthy" or 500 errors:**
1. Check logs: `docker compose -p kode-review-indexer logs kode-review-api`
2. If schema errors, perform full reset (see Upgrading above)
3. Check memory: `docker stats`

**Schema errors ("column does not exist"):**
```bash
kode-review --indexer-cleanup
kode-review --setup-indexer
kode-review --index
```

**Port conflicts:**
1. Find process: `fuser 8321/tcp` (Linux) or `lsof -i :8321` (macOS)
2. Change ports in config:
   ```json
   { "indexer": { "apiPort": 8322, "dbPort": 5437 } }
   ```
3. Re-run: `kode-review --setup-indexer`

**Stop indexer containers:**
```bash
docker compose -p kode-review-indexer down
```

</details>

---

## Review Output

Reviews include:

- **Summary**: Overview of changes and quality
- **Issues Found**: Categorized by severity (CRITICAL, HIGH, MEDIUM, LOW)
  - Security issues, bugs, code quality problems, convention violations
- **Positive Observations**: Things done well
- **Final Verdict**: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION with merge recommendation

---

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

```bash
kode-review --scope both --quiet --json
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_SERVER_URL` | Attach to running OpenCode server |
| `OPENCODE_MODEL` | Default model override |

---

## License

MIT
