# Port agent harness from opencode to pi.dev

**Status:** Approved (brainstorm)
**Date:** 2026-04-26
**Target version:** v1.0.0 (clean break)

## Goal

Replace the opencode SDK as the agent harness for kode-review with [pi](https://pi.dev). Pi takes over auth, model registry, session/event streaming, tool execution loop, compaction, and retries. Kode-review continues to own the review-domain logic: prompts, diff extraction, project structure analysis, the indexer, VCS wrappers, watch mode, and CLI ergonomics.

## Non-goals

- Reworking prompts, the indexer pipeline, watch mode, VCS integration, or any review output format.
- Distributing kode-review as a pi extension (`pi install kode-review`). The kode-review CLI remains the user-facing entry point. Pi is the engine, not the surface.
- Continuing to expose the kode-review tools as a standalone MCP server. The MCP layer is internal-only today and is removed entirely.

## Decisions

These were settled during brainstorming and underpin everything below:

1. **Integration mode:** in-process pi SDK (`@mariozechner/pi-coding-agent`). Hard version coupling is acceptable.
2. **Tool wiring:** keep the existing tool handler modules; add a thin pi-registration adapter; delete the MCP server entrypoint and the `@modelcontextprotocol/sdk` dependency.
3. **Auth & onboarding:** maximally minimal. Drop `provider`, `model`, `variant`, and the entire `antigravity` config block. Pi owns auth via `pi /login`. Kode-review accepts an optional `--model <pattern>` passthrough.
4. **Migration:** hard clean break. v1.0 wipes any pre-existing config, watch state, and indexer Docker resources (containers + volumes) after a confirmation prompt. **No backup file.** Users who don't want this are told to stay on the previous version.
5. **Built-in pi tools (read/bash/edit/write):** disabled for review sessions. Reviews never get write access. Only kode-review's own read-only tools are registered (and only in agentic mode).

## Architecture

The review engine becomes a thin orchestrator over a pi `AgentSession`:

```
runReview(options)
  ├─ build prompt (unchanged)
  ├─ resolve model (--model flag or pi default)
  ├─ create AgentSession (in-memory, ephemeral, no built-in tools)
  ├─ if agentic: registerKodeReviewTools(session.agent, ctx)
  ├─ subscribe(eventCollector)
  ├─ Promise.race(session.prompt(userPrompt), timeout)
  ├─ extract result from collector
  └─ session.dispose()
```

The two engines (`engine.ts` for basic, `agentic-engine.ts` for tool-using) collapse into one. The only behavioural difference is whether `registerKodeReviewTools` is called.

## Module-level changes

| Module | Change |
|---|---|
| `src/review/engine.ts` | Rewrite. Use `createAgentSession` from `@mariozechner/pi-coding-agent`. Accepts a `tools: 'none' \| 'agentic'` option; old `agentic-engine.ts` callers route through this same function. |
| `src/review/agentic-engine.ts` | Delete. Its public exports (`runAgenticReview`, etc.) become thin wrappers in `engine.ts` for compatibility, or callers are updated directly — see Build sequence. |
| `src/review/session-events.ts` | Rewrite. Subscribe to pi's `AgentSessionEvent` stream (`tool_execution_end` for counts, `message_end` for the assistant message, `agent_end` for completion). |
| `src/review/response.ts` | Adapt to pi's `AgentMessage` content shape. |
| `src/review/pi-tools.ts` | **New.** Registers each kode-review tool with the pi `Agent`. Indexer tools are conditionally registered when `indexerUrl` is present. |
| `src/review/tools/` | **Moved** from `src/mcp/tools/`. Handler signatures unchanged. |
| `src/mcp/` | **Deleted entirely** (server entrypoint, tool re-exports). |
| `src/onboarding/wizard.ts` | Shrunk to ~3 steps: pi-installed check → pi-has-model check → VCS setup. No more provider/model dialog, no antigravity flow. |
| `src/onboarding/antigravity.ts` | Delete. |
| `src/onboarding/pi.ts` | **New.** `isPiInstalled()`, `piHasUsableModel()`, install/login hint helpers. |
| `src/config/schema.ts` | Drop `provider`, `model`, `variant`, `antigravity`. Keep `github`, `gitlab`, `indexer`, `updater`, `onboardingComplete`. |
| `src/config/store.ts` | On load, expose a `hasOldSchema()` predicate (checks for `provider` key + reads `composeProject` for the migration step). |
| `src/cli/migration.ts` | **New.** Implements the wipe-everything migration flow: confirm prompt, indexer Docker tear-down, config + watch-state deletion. Honours `--migrate-yes` / `KODE_REVIEW_MIGRATE_YES`. |
| `src/cli/doctor.ts` | Check `pi` instead of `opencode`. Exempt from the migration gate. |
| `src/cli/parse.ts` | Add `--model <pattern>` passthrough and `--migrate-yes`. **Delete `--setup-provider`** (no alias — clean break). |
| `src/cli/update.ts` | No functional change; revise messaging strings that mention opencode. |
| `src/utils/errors.ts` | New error codes: `PI_NOT_INSTALLED`, `NO_PI_AUTH`, `PI_SDK_FAILURE`. Drop opencode-specific codes. |
| `package.json` | Remove `@opencode-ai/sdk`, `@modelcontextprotocol/sdk`. Add `@mariozechner/pi-coding-agent`. Bump to `1.0.0`. |
| `README.md` | Lead with "install pi first." Add a prominent **upgrade warning** in a section near the top: v1.0 wipes prior config and indexer data; users who don't want that should pin to the previous version. Update install commands, screenshots, model selection guidance. |

**Untouched:** `src/review/prompt.ts`, `src/review/agentic-prompt.ts`, `src/review/diff.ts`, `src/review/project-structure.ts`, `src/indexer/**`, `src/vcs/**`, `src/watch/**`, `src/utils/{logger,exec}.ts`.

## The pi-tools adapter

`src/review/pi-tools.ts`:

```ts
import { Type } from 'typebox'
import type { Agent } from '@mariozechner/pi-coding-agent'
import {
  readFileHandler,
  searchCodeHandler,
  findDefinitionsHandler,
  findUsagesHandler,
  getCallGraphHandler,
  getImpactHandler,
} from './tools/index.js'

export interface ToolContext {
  repoRoot: string
  repoUrl: string
  indexerUrl?: string
  branch?: string
}

export function registerKodeReviewTools(agent: Agent, ctx: ToolContext): void {
  agent.registerTool({
    name: 'read_file',
    label: 'Read file',
    description: '...',  // copied verbatim from src/mcp/tools/read_file.ts
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      const text = await readFileHandler(params, ctx)
      return { content: [{ type: 'text', text }], details: {} }
    },
  })

  if (!ctx.indexerUrl) return

  agent.registerTool({ name: 'search_code',       /* ... */ })
  agent.registerTool({ name: 'find_definitions',  /* ... */ })
  agent.registerTool({ name: 'find_usages',       /* ... */ })
  agent.registerTool({ name: 'get_call_graph',    /* ... */ })
  agent.registerTool({ name: 'get_impact',        /* ... */ })
}
```

Tool implementations (`src/review/tools/*.ts`) keep their existing `(input, ctx) => Promise<string>` signatures. Only the adapter is new.

### SDK API verification (open uncertainty)

Pi's docs show `pi.registerTool()` from inside *extensions*, where `pi: ExtensionAPI` is the runtime parameter. The equivalent for the SDK is most likely either:

- a method on the `Agent` returned by `createAgentSession()`, or
- a `tools: [...]` array passed to `createAgentSession()` up-front.

The first task in the implementation plan is to read `examples/sdk/` in the pi-coding-agent package and confirm the actual shape. If it's the up-front-array form, `registerKodeReviewTools` becomes `buildKodeReviewTools(ctx): ToolDescriptor[]` and is passed via the session config — same mechanical effort, slightly different signature.

## Per-review event handling

```ts
interface ReviewEventCollector {
  finalMessage: AgentMessage | null
  toolCallCount: number
  truncated: boolean
}

session.subscribe((event) => {
  switch (event.type) {
    case 'tool_execution_start':
      logger.debug(`→ ${event.toolName}(${JSON.stringify(event.args)})`)
      break
    case 'tool_execution_end':
      collector.toolCallCount++
      break
    case 'message_end':
      if (event.message.role === 'assistant') collector.finalMessage = event.message
      break
    case 'agent_end':
      // resolution signal for runReview
      break
  }
})
```

Live tool-call output (`→ search_code(...)`) ships as part of this work in non-quiet mode. Cheap because pi already emits the events.

## Onboarding flow

```
kode-review --setup
  ├─ Step 0: command exists? → if not, print install hint & exit
  │     "Install pi: npm install -g @mariozechner/pi-coding-agent
  │      (or see https://pi.dev)"
  ├─ Step 1: piHasUsableModel() → if no creds:
  │     "No pi provider configured. Run `pi /login` to set one up,
  │      then re-run `kode-review --setup`."
  │     exit 1
  ├─ Step 2: VCS setup (existing flow, unchanged)
  ├─ Step 3: indexer setup prompt (existing optional flow, unchanged)
  └─ setOnboardingComplete(true)
```

`piHasUsableModel()` shells out to `pi --list-models` and checks the output is not the "No models available. Use /login..." sentinel. This is the only place we use the pi CLI rather than the SDK — the check needs to be cheap and side-effect-free, and constructing `AuthStorage` + `ModelRegistry` for a yes/no check is overkill.

## Per-review auth gate

Before `createAgentSession`, the engine constructs `AuthStorage` and `ModelRegistry` and verifies at least one usable model exists. If not, it throws `KodeReviewError('NO_PI_AUTH')` with the `pi /login` hint. This catches the case where a user logs out of pi between onboarding and a review run, and avoids surfacing cryptic SDK errors.

## Migration (clean break — wipe everything)

v1.0 is a hard cut. If we detect any previous install, we wipe the whole local state and force the user to re-onboard from scratch. **No backup file.** Users who don't want this are told (in the README and in the on-first-run warning) to stay on the previous version.

What "wipe everything" covers:

1. `~/.config/kode-review/config.json` — replaced with fresh defaults.
2. `~/.config/kode-review-watch/config.json` — deleted.
3. Indexer Docker containers + volumes for the previously-configured compose project (e.g., `kode-review-indexer`). We read `composeProject` from the old config *before* deleting it, then run `docker compose -p <project> down -v` to remove containers and named volumes.

### Detection

In `src/config/store.ts` on first load (or in a dedicated `src/cli/migration.ts` step run before any other CLI work):

1. Read raw config JSON.
2. If the `provider` key is present (old-schema marker) → enter migration flow.

### Migration flow

Performed before any other command runs (including `--help`-adjacent paths is fine, but doctor/version should still work — see below):

```
kode-review (any command on a system with old config)
  ├─ Detect old schema
  ├─ Print warning:
  │     "kode-review v1.0 is a clean break. Continuing will:
  │        - wipe ~/.config/kode-review/
  │        - wipe ~/.config/kode-review-watch/
  │        - tear down the indexer Docker project (containers AND volumes)
  │      This is irreversible. To keep the old setup, install
  │      `kode-review@<previous-version>` instead.
  │
  │      Continue? Type 'wipe' to confirm."
  ├─ Read user input
  │     ├─ "wipe" → proceed
  │     └─ anything else → exit 0 with "Aborted. No changes made."
  ├─ Read composeProject name from the old config (before wiping)
  ├─ docker compose -p <composeProject> down -v   (best-effort, log failures)
  ├─ rm -rf ~/.config/kode-review-watch/
  ├─ Replace ~/.config/kode-review/config.json with fresh defaults
  └─ Print: "Done. Run `kode-review --setup` to set up v1.0."
       exit 0
```

Notes:

- **Non-interactive bypass.** Accept `--migrate-yes` (or `KODE_REVIEW_MIGRATE_YES=1`) to skip the typed confirmation, for users who want to script the upgrade. CI/Docker installs that don't have a TTY also need this — without it, the prompt fails closed and prints the same "Aborted" message.
- **Doctor/version exempt.** `kode-review --doctor` and `kode-review --version` should run without triggering the migration prompt — they're diagnostic, not operational. The migration check sits inside the command dispatcher, not at process start.
- **Docker tear-down is best-effort.** If `docker` is missing or the compose project doesn't exist, log the failure and continue — config wipe still proceeds. If the indexer was never set up, this is a no-op.
- **Watch-mode state.** The separate `~/.config/kode-review-watch/` directory is wiped wholesale.

## Errors

| Code | When | Hint |
|---|---|---|
| `PI_NOT_INSTALLED` | `pi` not on PATH | install instructions + https://pi.dev |
| `NO_PI_AUTH` | model registry empty at review time | "Run `pi /login`" |
| `PI_SDK_FAILURE` | `createAgentSession` throws | wrap original; suggest `kode-review --doctor` |
| `REVIEW_TIMEOUT` | 180s elapsed without `agent_end` | unchanged from today |
| `INDEXER_DOWN` | agentic mode, indexer unreachable | unchanged — degrade to read_file-only |

Opencode-specific codes (e.g., `OPENCODE_NOT_INSTALLED`) are deleted.

## Testing

Pattern stays the same: `vi.mock()` the agent SDK, stub `createAgentSession` to return a fake session that fires events when `prompt()` is called. Per CLAUDE.md, run with `bun run test` (not `bun test`).

**Rewrites:**

- `src/review/__tests__/engine.test.ts` — rewrite for pi SDK mock.
- `src/review/__tests__/agentic-engine.test.ts` — fold into `engine.test.ts` since the engines unify.
- `src/review/__tests__/session-events.test.ts` — rewrite for pi `AgentSessionEvent`.
- `src/cli/__tests__/doctor.test.ts` — assert `pi` is checked, not `opencode`.

**New tests:**

- `src/review/__tests__/pi-tools.test.ts` — each tool's parameter schema validates expected input; the adapter passes input through to the underlying handler unchanged; indexer tools are skipped when `indexerUrl` is absent.
- `src/onboarding/__tests__/pi.test.ts` — `piHasUsableModel()` recognises both the "no models" sentinel and a populated list.
- `src/cli/__tests__/migration.test.ts` — covers (a) old-schema detection, (b) confirm prompt rejects anything that isn't `wipe`, (c) `--migrate-yes`/env-var bypass, (d) Docker tear-down is invoked with the right `composeProject` name read from the old config, (e) tear-down failure does not block config wipe, (f) post-wipe state matches fresh defaults, (g) `--doctor` and `--version` are exempt from the migration gate.

**Untouched:** all indexer tests, VCS tests, watch-mode tests, prompt-builder tests, diff-extraction tests. `response.ts` tests get a small shape fix for pi's `AgentMessage`.

## Build sequence (suggested order for the implementation plan)

1. **Verify SDK shape.** Read `node_modules/@mariozechner/pi-coding-agent/examples/sdk/`. Confirm whether tools are registered dynamically on `Agent` or up-front via the session config. Lock the `pi-tools.ts` signature accordingly.
2. **Schema + migration.** Update `src/config/schema.ts` and `src/config/store.ts` (add `hasOldSchema()`). Implement `src/cli/migration.ts` with confirm prompt, Docker tear-down, config + watch-state wipe, and `--migrate-yes` bypass. Wire it into the command dispatcher (exempting `--doctor` and `--version`). Tests per the testing section.
3. **Onboarding helpers.** New `src/onboarding/pi.ts`. Test `piHasUsableModel()`.
4. **Wizard rewrite.** `src/onboarding/wizard.ts` slimmed; delete `antigravity.ts`. Manual test: `kode-review --setup` with pi installed/not, with creds/not.
5. **Move tools.** `src/mcp/tools/` → `src/review/tools/`. Update imports. No behavioural change.
6. **Pi-tools adapter.** New `src/review/pi-tools.ts` + tests.
7. **Engine rewrite.** Unified `src/review/engine.ts`. Rewrite `session-events.ts` and `response.ts`. Delete `agentic-engine.ts` (callers updated to pass `tools: 'agentic'`). Rewrite engine tests.
8. **Delete MCP entrypoint.** Remove `src/mcp/kode-review-mcp.ts` and the `@modelcontextprotocol/sdk` dep.
9. **Doctor + errors.** Update `src/cli/doctor.ts`, `src/utils/errors.ts`. Update its tests.
10. **CLI flags.** Add `--model` passthrough; delete `--setup-provider`. Update `src/cli/parse.ts` and any docs.
11. **Package + readme.** `package.json` deps + version bump; rewrite README quickstart.
12. **End-to-end smoke.** `bun run build && node dist/index.js` against a local repo: basic review, agentic review with indexer, agentic review without indexer (should warn and run with read_file only), `--setup` flow, migration flow (with both interactive confirm and `--migrate-yes`).
