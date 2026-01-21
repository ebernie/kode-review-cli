# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

> **Note**: This project uses **Bun** as the package manager. Always use `bun` instead of `npm`.

```bash
bun run build          # Build with tsup (output to dist/)
bun run dev            # Watch mode for development
bun run typecheck      # TypeScript type checking (tsc --noEmit)
bun run lint           # ESLint
bun test               # Run tests once (vitest run)
bun run test:watch     # Watch mode for tests (vitest)
bun test src/indexer   # Run tests for a specific module
```

**Run the CLI locally:**
```bash
bun run build && node dist/index.js   # Build and run
./bin/kode-review.js                  # Direct execution (dev)
```

## Architecture

### Entry Flow
`bin/kode-review.js` → `src/index.ts` → CLI parsing → onboarding check → platform detection → review execution

The main entry point (`src/index.ts`) orchestrates three main flows:
1. **Setup commands** (`--setup`, `--reset`, `--setup-provider`, `--setup-vcs`)
2. **Indexer commands** (`--index`, `--setup-indexer`, `--index-status`, `--index-reset`)
3. **Review execution** (local changes, PR/MR, or watch mode)

### Module Structure

| Module | Purpose |
|--------|---------|
| `src/cli/` | CLI argument parsing (Commander), colors (Chalk), interactive context |
| `src/config/` | Zod schemas, Conf-based persistent config store (~/.config/kode-review/) |
| `src/onboarding/` | Setup wizard, Antigravity OAuth, VCS CLI detection |
| `src/review/` | OpenCode SDK integration, prompt construction, git diff extraction |
| `src/vcs/` | GitHub/GitLab CLI wrappers (`gh`/`glab`), platform detection from git remote |
| `src/watch/` | Polling-based PR/MR monitoring with persistent state tracking |
| `src/indexer/` | Docker-based semantic code indexer (PostgreSQL + pgvector + FastAPI) |
| `src/utils/` | Logger with quiet mode, command execution wrapper (`execa`) |

### Key Patterns

- **Barrel exports**: Each module has an `index.ts` that re-exports public APIs
- **Context-based modes**: `createContext()` determines interactive vs CI/quiet mode
- **Platform detection**: Auto-detects GitHub/GitLab from git remote URL
- **Config persistence**: Uses `conf` library with Zod validation
- **Tests location**: Tests live in `__tests__/` subdirectories within each module (e.g., `src/indexer/__tests__/`)

### Review Engine Flow

`src/review/engine.ts` creates an OpenCode server instance per review:
1. Creates session via `createOpencode()` (ephemeral server on random port)
2. Builds prompt with diff, context, PR info, and optional semantic context
3. Sends prompt via `client.session.prompt()` with model specification
4. Extracts text parts from response and returns review content

### Watch Mode

`src/watch/` implements continuous PR/MR monitoring:
- `detector.ts` - Queries GitHub/GitLab for PRs where user is a reviewer
- `state.ts` - Persists reviewed PR/MR state to `~/.config/kode-review-watch/`
- `watcher.ts` - Main polling loop with graceful shutdown handling

### Indexer Architecture

The indexer (`src/indexer/`) provides semantic code search via Docker containers:
- **PostgreSQL + pgvector** for vector storage
- **FastAPI server** for indexing and search endpoints
- Uses `sentence-transformers/all-MiniLM-L6-v2` for embeddings by default
- Configuration in `IndexerConfigSchema` (ports, chunk sizes, file patterns)

## Technical Stack

- **Runtime**: Node.js 18+ with ESM (type: module)
- **Build**: tsup with tree-shaking, source maps
- **TypeScript**: Strict mode, no unused locals/parameters, no implicit returns
- **AI Integration**: OpenCode SDK (`@opencode-ai/sdk`) with Antigravity models support
- **CLI**: Commander for args, Inquirer for prompts, Ora for spinners
- **Process execution**: execa for running git, gh, glab commands

## Configuration

Config stored at `~/.config/kode-review/config.json` with:
- Provider/model selection (Anthropic, Google/Antigravity)
- VCS authentication status (GitHub CLI `gh`, GitLab CLI `glab`)
- Indexer settings (ports, embedding model, chunk sizes)
- Onboarding completion state

Watch mode state stored separately at `~/.config/kode-review-watch/config.json`.

## Review Output Format

Reviews produce structured output with:
- Summary of changes
- Issues by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Positive observations
- Final verdict (APPROVE, REQUEST_CHANGES, NEEDS_DISCUSSION)
- Merge decision (SAFE_TO_MERGE, DO_NOT_MERGE, CONDITIONAL_MERGE)
