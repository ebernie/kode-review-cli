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
bun test src/indexer/__tests__/client.test.ts  # Run a single test file
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
| `src/review/` | OpenCode SDK integration, prompt construction, git diff extraction, project structure analysis |
| `src/vcs/` | GitHub/GitLab CLI wrappers (`gh`/`glab`), platform detection from git remote |
| `src/watch/` | Polling-based PR/MR monitoring with persistent state tracking |
| `src/indexer/` | Semantic code indexer with multi-stage retrieval pipeline |
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

The indexer (`src/indexer/`) provides semantic code search:

**Core Components:**
- `client.ts` - HTTP client for indexer API (search, keyword, hybrid, definitions, usages, call graph)
- `docker.ts` - Docker Compose management for PostgreSQL + pgvector + FastAPI containers
- `context.ts` - Extracts semantic context from diffs for review prompts

**Multi-Stage Retrieval Pipeline** (`pipeline.ts`):
1. **Stage 1**: Keyword search for exact identifier matches (100ms budget)
2. **Stage 2**: Vector similarity search on diff content (500ms budget)
3. **Stage 3**: Structural lookup - definitions, usages, call graph (500ms budget)
4. **Stage 4**: Re-ranking and deduplication (100ms budget)

Early termination occurs when high-confidence matches (score > 0.9) are found.

**Supporting Modules:**
- `diversification.ts` - Prevents redundant results (max chunks per file, category distribution)
- `file-type-strategies.ts` - Language-specific query extraction (TypeScript, Python, Go, etc.)
- `xml-context.ts` - Formats context chunks as structured XML for prompts
- `background-indexer.ts` - Async job queue for large repository re-indexing
- `background-queue.ts` - Priority-based job queue with persistence

**Indexer Types** (`types.ts`):
- `CodeChunk`, `WeightedCodeChunk` - Base units of indexed code
- `HybridSearchResult` - Combined vector + BM25 keyword search
- `CallGraphResult` - Function call relationships
- `ImportTree`, `CircularDependency` - Dependency analysis

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
