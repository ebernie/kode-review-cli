# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

> **Note**: This project uses **Bun** as the package manager. Always use `bun` instead of `npm`.

```bash
bun run build          # Build with tsup (output to dist/)
bun run dev            # Watch mode for development
bun run typecheck      # TypeScript type checking (tsc --noEmit)
bun run lint           # ESLint
bun run test           # Run tests once (vitest run)
bun run test:watch     # Watch mode for tests (vitest)
npx vitest run src/indexer   # Run tests for a specific module
npx vitest run src/indexer/__tests__/client.test.ts  # Run a single test file
```

> **Important**: Always use `bun run test` (not `bun test`). The bare `bun test` invokes Bun's native test runner, which shares module caches across files and causes `vi.mock()` calls to leak between test files. `bun run test` correctly invokes vitest with proper per-file isolation.

**Run the CLI locally:**
```bash
bun run build && node dist/index.js   # Build and run
./bin/kode-review.js                  # Direct execution (dev)
```

## Architecture

### Entry Flow
`bin/kode-review.js` → `src/index.ts` → CLI parsing → setup/update commands → onboarding check → update notification → platform detection → review execution

The main entry point (`src/index.ts`) orchestrates three main flows:
1. **Setup commands** (`--setup`, `--reset`, `--setup-provider`, `--setup-vcs`)
2. **Indexer commands** (`--index`, `--setup-indexer`, `--index-status`, `--index-reset`)
3. **Review execution** (local changes, PR/MR, or watch mode)

### Module Structure

| Module | Purpose |
|--------|---------|
| `src/cli/` | CLI argument parsing (Commander), colors (Chalk), interactive context, self-update (`update.ts`) |
| `src/config/` | Zod schemas, Conf-based persistent config store (~/.config/kode-review/) |
| `src/onboarding/` | Setup wizard, pi installation check, VCS CLI detection |
| `src/review/` | pi-coding-agent integration, prompt construction, git diff extraction, project structure analysis, agentic tool dispatch (ripgrep/git/indexer) |
| `src/vcs/` | GitHub/GitLab CLI wrappers (`gh`/`glab`), platform detection from git remote |
| `src/watch/` | Polling-based PR/MR monitoring with persistent state tracking |
| `src/indexer/` | Semantic code indexer with multi-stage retrieval pipeline |
| `src/repo-audit/` | `--scope repo` whole-codebase audit: clawpatch-powered mapper + kode-agent reviewer |
| `src/utils/` | Logger with quiet mode, command execution wrapper (`execa`) |

### Key Patterns

- **Barrel exports**: Each module has an `index.ts` that re-exports public APIs
- **Context-based modes**: `createContext()` determines interactive vs CI/quiet mode
- **Platform detection**: Auto-detects GitHub/GitLab from git remote URL
- **Config persistence**: Uses `conf` library with Zod validation
- **Tests location**: Tests live in `__tests__/` subdirectories within each module (e.g., `src/indexer/__tests__/`)

### Review Engine Flow

`src/review/engine.ts` runs each review through a pi-coding-agent session:
1. Resolves model via `ModelRegistry` (first available, or `--model provider/id`)
2. Creates session via `createAgentSession()` (`noTools: 'all'` for basic, `noTools: 'builtin'` for agentic so the pi-tools extension stays enabled)
3. Builds prompt with diff, PR info, and optional semantic context — or uses `options.systemPrompt` / `options.userPromptOverride` for persona dispatch and repo-scope feature review
4. Subscribes to session events; counts tool calls, surfaces truncation when `>= maxIterations`
5. Always disposes the session in `finally`; `extractReviewContent` reads the final assistant message *before* dispose

### Watch Mode

`src/watch/` implements continuous PR/MR monitoring:
- `detector.ts` - Queries GitHub/GitLab for PRs where user is a reviewer
- `state.ts` - Persists reviewed PR/MR state to `~/.config/kode-review-watch/`
- `watcher.ts` - Main polling loop with graceful shutdown handling

### Repo-Scope Audit (`--scope repo`)

`src/repo-audit/` provides whole-codebase review:

**Architecture:** clawpatch-powered mapper, kode-agent–powered reviewer.

- **`install.ts`** — detect `clawpatch` on PATH; package-manager-aware install hints; Node 22 version check
- **`clawpatch-cli.ts`** — execa wrappers for `clawpatch map` / `clawpatch doctor`
- **`features.ts`** — read `.clawpatch/features/*.json` into `FeatureRecord[]` (read-only consumer; never writes into `.clawpatch/`)
- **`persona-dispatch.ts`** — `selectPersonas(feature)`: trust-boundary + kind → built-in reviewer set
- **`prompts.ts`** — `buildFeatureReviewPrompt`: feature metadata + capped owned/context file contents + system-prompt suffix (`FEATURE_REVIEW_MODE_SUFFIX`) appended to the persona's template
- **`engines/kode-agent.ts`** — `reviewFeatureWithAgent`: wraps `runAgenticReview()` with feature-shaped prompts and tools enabled
- **`state.ts`** — `.kode-review/findings/` (atomic temp-write-rename), `.kode-review/locks/` (O_EXCL + rename-over-stale TOCTOU defense), `.kode-review/run-history.jsonl`
- **`suppressions-structured.ts`** — `filterSuppressedStructured(Finding[], repoRoot)`: applies `kode-review: ignore` markers to structured findings (sibling of `src/review/suppressions.ts`)
- **`feature-filter.ts`** — `--since <ref>` filter via `git diff --name-only ref...HEAD`
- **`report.ts`** — text / markdown / json renderer with Feature × Severity matrix
- **`orchestrator.ts`** — `runRepoAudit`: install gate → clawpatch map → readFeatures → since/already-reviewed filter → per-feature review with persona dispatch → write findings → render

**State boundary:**

| Path | Owner |
|------|-------|
| `.clawpatch/` | clawpatch (read-only consumer) |
| `.kode-review/` | kode-review (findings, locks, run history) |

**Engine surface:** `runAgenticReview` (`src/review/engine.ts`) was extended to honor `options.systemPrompt` and `options.userPromptOverride` so the same agent loop powers both diff-scope persona dispatch and repo-scope feature review.

**Caps** (mirror clawpatch): `MAX_OWNED_FILES_IN_PROMPT=12`, `MAX_CONTEXT_FILES_IN_PROMPT=24`, `MAX_FINDINGS_PER_FEATURE=10` (in `types.ts`). Files past the cap are referenced by path with a `read_file`-via-tool hint — never silently truncated.

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
- **AI Integration**: Pi (https://pi.dev) owns provider/model/auth (Anthropic, Google Gemini API key, OpenAI, GitHub Copilot, etc.)
- **CLI**: Commander for args, Inquirer for prompts, Ora for spinners
- **Process execution**: execa for running git, gh, glab commands

## Configuration

Config stored at `~/.config/kode-review/config.json` with:
- VCS authentication status (GitHub CLI `gh`, GitLab CLI `glab`)
- Indexer settings (ports, embedding model, chunk sizes)
- Updater state (last version check)
- Onboarding completion state

Provider/model/auth is owned by pi (https://pi.dev) and is deliberately NOT stored in kode-review config. Use `pi /login` to configure providers.

Watch mode state stored separately at `~/.config/kode-review-watch/config.json`.

## Review Output Format

Reviews produce structured output with:
- Summary of changes
- Issues by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Positive observations
- Final verdict (APPROVE, REQUEST_CHANGES, NEEDS_DISCUSSION)
- Merge decision (SAFE_TO_MERGE, DO_NOT_MERGE, CONDITIONAL_MERGE)
