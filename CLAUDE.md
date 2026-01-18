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
```

**Run the CLI locally:**
```bash
node dist/index.js                    # After building
./bin/kode-review.js                  # Direct execution
```

## Architecture

### Entry Flow
`bin/kode-review.js` → `src/index.ts` → CLI parsing → onboarding check → platform detection → review execution

### Module Structure

| Module | Purpose |
|--------|---------|
| `src/cli/` | CLI argument parsing (Commander), colors (Chalk), interactive context |
| `src/config/` | Zod schemas, Conf-based persistent config store (~/.config/kode-review/) |
| `src/onboarding/` | Setup wizard, Antigravity OAuth, VCS CLI detection |
| `src/review/` | OpenCode SDK integration, prompt construction, git diff extraction |
| `src/vcs/` | GitHub/GitLab CLI wrappers, platform detection from git remote |
| `src/utils/` | Logger with quiet mode, command execution wrapper |

### Key Patterns

- **Barrel exports**: Each module has an `index.ts` that re-exports public APIs
- **Context-based modes**: `createContext()` determines interactive vs CI/quiet mode
- **Platform detection**: Auto-detects GitHub/GitLab from git remote URL
- **Config persistence**: Uses `conf` library with Zod validation

## Technical Stack

- **Runtime**: Node.js 18+ with ESM (type: module)
- **Build**: tsup with tree-shaking, source maps
- **TypeScript**: Strict mode, no unused locals/parameters, no implicit returns
- **AI Integration**: OpenCode SDK with Antigravity models support
- **CLI**: Commander for args, Inquirer for prompts, Ora for spinners

## Configuration

Config stored at `~/.config/kode-review/config.json` with:
- Provider/model selection (Anthropic, Google/Antigravity)
- VCS authentication status (GitHub CLI `gh`, GitLab CLI `glab`)
- Onboarding completion state

## Review Output Format

Reviews produce structured output with:
- Summary of changes
- Issues by severity (CRITICAL, HIGH, MEDIUM, LOW)
- Positive observations
- Final verdict (APPROVE, REQUEST_CHANGES, NEEDS_DISCUSSION)
- Merge decision (SAFE_TO_MERGE, DO_NOT_MERGE, CONDITIONAL_MERGE)
