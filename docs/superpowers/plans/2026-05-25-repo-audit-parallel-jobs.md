# Repo-Audit In-Process Parallelism (`--jobs`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single `kode-review --scope repo` invocation (both `--revalidate` and the audit path) process multiple feature-groups concurrently via a bounded in-process worker pool, controlled by the existing `--jobs` flag, defaulting to 2.

**Architecture:** A new pure `runPool` utility runs up to N async workers over a list of items with cooperative early-stop. The two repo-audit orchestrators (`orchestrator-revalidate.ts`, `orchestrator.ts`) are refactored so their per-feature loop body becomes a worker function fed to `runPool`. The pi review engine (`runWithPi`) is already per-call isolated — fresh `AuthStorage`/`ModelRegistry`/session per call, explicit `cwd` threading, no `process.chdir` — so concurrent sessions need no engine change. The `--jobs` flag, its validation, its `CliOptions`/`RepoAuditOptions` fields, and its plumbing into `runRepoAudit` **already exist** but are dead config; this plan wires them in and changes the default from 4 to 2.

**Tech Stack:** TypeScript (strict, ESM), Bun + vitest, Commander, pi-coding-agent SDK (`@mariozechner/pi-coding-agent` v0.70.2).

---

## Decisions locked (from clarification)

- **Where parallelism lives:** in-process worker pool (not child processes, not external-only).
- **Default concurrency:** 2 (`--jobs 1` reproduces today's exact sequential behavior).
- **Flag:** reuse the existing `--jobs <n>` (already documented, plumbed, validated 1–32). Do **not** add a synonym `--concurrency` (DRY/YAGNI). The user's "default 2" decision was framed against a hypothetical `--concurrency`; reusing `--jobs` with default 2 honors it. The existing default 4 was never functional, so changing it breaks no real behavior.

## Open risk this plan gates on

**Does the pi SDK tolerate ≥2 concurrent `createAgentSession` / `runWithPi` calls in one process?** Static analysis is favorable (no module-level mutable singletons in `engine.ts`; no `process.chdir` in the SDK dist; `cwd` threaded explicitly), but provider HTTP-client / connection behavior under concurrency is unverified. **Task 1 is a go/no-go spike.** If it fails, STOP and escalate — the fallback is the heavier child-process architecture, which is out of scope for this plan.

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/utils/concurrency.ts` | Pure bounded worker pool with cooperative stop. No pi/fs deps. | Create |
| `src/utils/index.ts` | Barrel — re-export `runPool`. | Modify |
| `src/utils/__tests__/concurrency.test.ts` | Unit tests for the pool. | Create |
| `src/cli/args.ts:235` | `--jobs` default 4 → 2; help text. | Modify |
| `src/cli/__tests__/args.repo-scope.test.ts:31-34` | Default-jobs assertion 4 → 2. | Modify |
| `src/repo-audit/orchestrator-revalidate.ts` | Per-feature loop → `runPool` worker (primary). | Modify |
| `src/repo-audit/__tests__/orchestrator-revalidate.test.ts` | Add concurrency + abort tests. | Modify |
| `src/repo-audit/orchestrator.ts` | Per-feature loop → `runPool` worker (secondary). | Modify |
| `src/repo-audit/__tests__/orchestrator.test.ts` | Add concurrency + abort tests. | Modify |
| `src/review/__tests__/concurrent-sessions.spike.md` | Recorded go/no-go from Task 1 (scratch, not committed code). | Spike artifact |
| `CLAUDE.md` | Note `--jobs` is now live (default 2) in the repo-audit section. | Modify |

---

### Task 1: Spike — verify pi tolerates concurrent in-process sessions (GO/NO-GO GATE)

**Files:**
- Scratch only: `scripts/spike-concurrent-sessions.mts` (create, run, then delete — do NOT commit)

This is a manual verification, not committed code. It requires a configured pi provider (`pi /login` already done — it's the user's own tool) and makes 2 real, tiny model calls.

- [ ] **Step 1: Write the scratch spike script**

Create `scripts/spike-concurrent-sessions.mts`:

```ts
// Scratch spike — verify pi tolerates 2 concurrent in-process sessions.
// Run from repo root with a configured pi provider. Delete after.
import { runReview } from '../src/review/engine.js'

async function one(word: string) {
  const res = await runReview({
    // userPromptOverride bypasses diff/prompt machinery entirely.
    userPromptOverride: `Reply with exactly one word, in caps: ${word}. Nothing else.`,
    systemPrompt: 'You are a test echo. Output only the single word requested.',
    // Minimal required ReviewOptions fields; consult the ReviewOptions type
    // and pass empty/neutral values for diffContent/context as the type requires.
    diffContent: '',
    context: { mode: 'ci', interactive: false } as never, // shape per createContext(); adjust to the real type
  } as never)
  return res.content
}

const start = Date.now()
const [a, b] = await Promise.all([one('ALPHA'), one('BETA')])
console.log(`alpha=${JSON.stringify(a)}\nbeta=${JSON.stringify(b)}\nelapsedMs=${Date.now() - start}`)

if (!a.includes('ALPHA') || !b.includes('BETA')) {
  console.error('NO-GO: cross-talk or missing content between concurrent sessions')
  process.exit(1)
}
console.log('GO: two concurrent pi sessions returned correct, non-crosstalked content')
```

> The `as never` casts are deliberate scratch-only shortcuts. The engineer running the spike resolves the exact `ReviewOptions` shape against `src/review/engine.ts` (the `ReviewOptions` interface) — this is exploration, not production code.

- [ ] **Step 2: Run the spike**

Run: `bun run build && node --experimental-strip-types scripts/spike-concurrent-sessions.mts`
(or `npx tsx scripts/spike-concurrent-sessions.mts` against `src/`)

**Expected (GO):** prints `GO:` line; `alpha` contains `ALPHA`, `beta` contains `BETA`; no crash, no interleaved/garbled output, no auth/connection error. `elapsedMs` should be roughly one call's latency (overlap), not the sum.

**NO-GO signals:** a throw from `createAgentSession`/provider client, one call's content bleeding into the other, an auth-store race, or a hang. If NO-GO → **STOP. Do not proceed to Task 4/5.** Record findings and escalate to the user; the child-process architecture would be required instead.

- [ ] **Step 3: Record the result and delete the scratch script**

Write the GO/NO-GO verdict + raw output into the plan's execution notes (or `src/review/__tests__/concurrent-sessions.spike.md`). Then:

```bash
rm scripts/spike-concurrent-sessions.mts
```

- [ ] **Step 4: Commit the recorded verdict (if you kept the .spike.md note)**

```bash
git add src/review/__tests__/concurrent-sessions.spike.md 2>/dev/null || true
git commit -m "docs(repo-audit): record pi concurrent-session spike verdict" --allow-empty
```

---

### Task 2: Bounded worker pool utility

**Files:**
- Create: `src/utils/concurrency.ts`
- Test: `src/utils/__tests__/concurrency.test.ts`
- Modify: `src/utils/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/utils/__tests__/concurrency.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runPool } from '../concurrency.js'

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms))

describe('runPool', () => {
  it('processes every item and returns a result per item', async () => {
    const items = [1, 2, 3, 4, 5]
    const outcome = await runPool(items, 2, async (n) => n * 10)
    expect(outcome.results.slice().sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
    expect(outcome.processed).toBe(5)
    expect(outcome.stopped).toBe(false)
  })

  it('never runs more than `concurrency` workers at once', async () => {
    let active = 0
    let maxActive = 0
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick()
      active--
    })
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('concurrency 1 runs items strictly in input order', async () => {
    const seen: number[] = []
    await runPool([1, 2, 3], 1, async (n) => {
      seen.push(n)
      await tick()
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('requestStop() halts dequeuing new items but lets in-flight finish', async () => {
    const started: number[] = []
    const finished: number[] = []
    const outcome = await runPool([1, 2, 3, 4, 5, 6], 2, async (n, _i, handle) => {
      started.push(n)
      await tick()
      if (n === 1) handle.requestStop()
      finished.push(n)
      return n
    })
    expect(outcome.stopped).toBe(true)
    // At most the 2 initially-dequeued items start; no new items after stop.
    expect(started.length).toBeLessThanOrEqual(2)
    // Every started item finished (in-flight drained, not cancelled).
    expect(finished.sort()).toEqual(started.sort())
  })

  it('throws on concurrency < 1', async () => {
    await expect(runPool([1], 0, async (n) => n)).rejects.toThrow(/concurrency must be >= 1/)
  })

  it('returns immediately for an empty item list', async () => {
    const outcome = await runPool([], 4, async (n) => n)
    expect(outcome.results).toEqual([])
    expect(outcome.processed).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/__tests__/concurrency.test.ts`
Expected: FAIL — `runPool` not found / module missing.

- [ ] **Step 3: Implement the pool**

Create `src/utils/concurrency.ts`:

```ts
/**
 * Bounded async worker pool with cooperative early-stop.
 *
 * Runs up to `concurrency` workers over `items`. A worker may call
 * `handle.requestStop()` to ask the pool to stop dequeuing NEW items;
 * already-in-flight workers run to completion (their side effects are not
 * cancelled). This mirrors the orchestrators' rate-limit semantics: the first
 * worker to hit a hard limit stops further scheduling, but partial progress
 * already persisted to disk is preserved.
 *
 * Result ordering is completion order, not input order — callers that only
 * aggregate counters (the repo-audit orchestrators) do not depend on order.
 */

export interface PoolHandle {
  /** Ask the pool to stop dequeuing new items. Idempotent. In-flight workers finish. */
  requestStop(): void
  /** True once any worker has called requestStop(). */
  readonly stopRequested: boolean
}

export interface PoolOutcome<R> {
  /** One entry per item a worker actually ran, in completion order. */
  results: R[]
  /** True if requestStop() was called during the run. */
  stopped: boolean
  /** Number of items a worker was started for (<= items.length when stopped). */
  processed: number
}

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, handle: PoolHandle) => Promise<R>,
): Promise<PoolOutcome<R>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be >= 1 (got ${concurrency})`)
  }

  const results: R[] = []
  let cursor = 0
  let processed = 0
  let stopRequested = false

  const handle: PoolHandle = {
    requestStop() {
      stopRequested = true
    },
    get stopRequested() {
      return stopRequested
    },
  }

  async function drain(): Promise<void> {
    // Cooperative loop: each worker pulls the next index until the list is
    // exhausted or a stop has been requested. cursor++ is atomic in JS's
    // single-threaded model — no two workers can claim the same index.
    for (;;) {
      if (stopRequested) return
      const index = cursor++
      if (index >= items.length) return
      processed++
      const r = await worker(items[index]!, index, handle)
      results.push(r)
    }
  }

  const lanes = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: lanes }, () => drain()))

  return { results, stopped: stopRequested, processed }
}
```

- [ ] **Step 4: Export from the barrel**

Modify `src/utils/index.ts` — add after the retry block (line 16):

```ts
// Bounded async worker pool
export {
  runPool,
  type PoolHandle,
  type PoolOutcome,
} from './concurrency.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/utils/__tests__/concurrency.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/utils/concurrency.ts src/utils/__tests__/concurrency.test.ts src/utils/index.ts
git commit -m "feat(utils): add bounded worker pool with cooperative stop"
```

---

### Task 3: Wire `--jobs` default 4 → 2

**Files:**
- Modify: `src/cli/args.ts:235`
- Modify: `src/cli/__tests__/args.repo-scope.test.ts:31-34`

- [ ] **Step 1: Update the failing test first**

In `src/cli/__tests__/args.repo-scope.test.ts`, change the default-jobs test (around line 31-34):

```ts
  it('--jobs defaults to 2', () => {
    const opts = parseArgs(args('--scope', 'repo'))
    expect(opts.jobs).toBe(2)
  })
```

(Leave the explicit-value test `--jobs 12 → 12` and the range test `0`/`33` reject unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/args.repo-scope.test.ts`
Expected: FAIL — `expected 4 to be 2`.

- [ ] **Step 3: Change the default in args.ts**

In `src/cli/args.ts`, line 235, change:

```ts
    .option('--jobs <n>', 'Worker concurrency for repo-scope reviews (default: 4)', '4')
```

to:

```ts
    .option('--jobs <n>', 'Worker concurrency for repo-scope reviews — features reviewed in parallel (default: 2)', '2')
```

And in `parseArgs`, line 370, change the fallback so a default still resolves correctly:

```ts
  const jobsRaw = opts.jobs ?? '2'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/__tests__/args.repo-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/__tests__/args.repo-scope.test.ts
git commit -m "feat(cli): default --jobs to 2 (parallel repo-scope reviews)"
```

---

### Task 4: Parallelize the revalidate orchestrator (PRIMARY)

**Files:**
- Modify: `src/repo-audit/orchestrator-revalidate.ts`
- Test: `src/repo-audit/__tests__/orchestrator-revalidate.test.ts`

The refactor moves the body of the `outer:` loop (currently `orchestrator-revalidate.ts:169-312`) into a `reviewFeature` worker that returns a per-feature tally, and replaces the loop with a `runPool` call over `byFeature` entries. Counters are summed from the returned tallies instead of mutated in the loop. Lock/persona/persist/verdict logic is preserved verbatim inside the worker.

- [ ] **Step 1: Write the failing concurrency + abort tests**

Add to `src/repo-audit/__tests__/orchestrator-revalidate.test.ts` (uses the existing `baseCli`, tmp findings storage, and `mocks.revalidateFeatureGroupWithAgent`). If `baseCli` does not already set `jobs`, add `jobs: 1` to it so existing tests stay sequential; the new tests override per-call.

```ts
import { isRateLimitError } from '../error-classify.js' // if needed for fixtures

describe('runRevalidate — concurrency', () => {
  it('runs multiple features in parallel under --jobs 3 (overlapping work)', async () => {
    // Three features, each with one open finding + a registered persona.
    // Arrange findings on disk (mirror the existing helper used by other tests).
    await seedOpenFinding(tmp, 'feat-A', 'general', 'A.ts')
    await seedOpenFinding(tmp, 'feat-B', 'general', 'B.ts')
    await seedOpenFinding(tmp, 'feat-C', 'general', 'C.ts')

    let active = 0
    let maxActive = 0
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ openFindings }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return {
        blockParsed: true,
        verdicts: new Map(openFindings.map((f: { findingId: string }) => [
          f.findingId,
          { verdict: 'fixed', evidence: 'gone' },
        ])),
        truncated: false,
      }
    })
    mocks.filterFeaturesBySince.mockResolvedValue({ matched: [], touchedFiles: [] })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://example/r.git',
      cli: { ...baseCli, jobs: 3, revalidate: true },
    })

    expect(maxActive).toBeGreaterThan(1) // proves parallelism
    expect(result.featuresReviewed).toBe(3)
  })

  it('a rate-limit in one worker stops new work but preserves persisted verdicts (aborted=true)', async () => {
    await seedOpenFinding(tmp, 'feat-A', 'general', 'A.ts')
    await seedOpenFinding(tmp, 'feat-B', 'general', 'B.ts')

    const rateLimit = Object.assign(new Error('429 rate limit'), { status: 429 })
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ feature }) => {
      if (feature.featureId === 'feat-A') throw rateLimit
      return { blockParsed: true, verdicts: new Map(), truncated: false }
    })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://example/r.git',
      cli: { ...baseCli, jobs: 2, revalidate: true },
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/rate limit/i)
    // feat-A's finding was never verdicted → still 'open' for retry.
    const recs = await listFindings(tmp)
    expect(recs.find((r) => r.featureId === 'feat-A')?.status).toBe('open')
  })
})
```

> `seedOpenFinding` is a small local helper: write a `RepoFindingRecord` with `status: 'open'`, the given `featureId`/`persona`/`file`, via `writeFinding`, AND make `readFeatures` (mock it the way the file's existing tests do) return a `FeatureRecord` for each `featureId`. Mirror whatever feature-record mocking the existing passing tests in this file already use — reuse that fixture rather than inventing a new one. If the existing tests mock `../features.js`, extend that mock to return `feat-A/B/C`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/repo-audit/__tests__/orchestrator-revalidate.test.ts`
Expected: FAIL — `maxActive` stays 1 (still sequential), abort test may pass-by-accident or fail on `aborted` flag; the concurrency assertion `maxActive > 1` is the key failing assertion.

- [ ] **Step 3: Refactor `runRevalidate` to use `runPool`**

In `src/repo-audit/orchestrator-revalidate.ts`:

(a) Add the import:

```ts
import { runPool } from '../utils/concurrency.js'
```

(b) Define a per-feature tally type near the other helpers (after `interface FeatureGroup`):

```ts
interface FeatureTally {
  featuresTouched: number
  revalidated: number
  closed: number
  uncertain: number
  stillPresent: number
  leftOpen: number
  /** Set when this feature's work hit a hard rate limit. */
  abortReason?: string
}

const ZERO_TALLY: FeatureTally = {
  featuresTouched: 0,
  revalidated: 0,
  closed: 0,
  uncertain: 0,
  stillPresent: 0,
  leftOpen: 0,
}
```

(c) Replace the entire `outer: for (const [featureId, featureGroups] of byFeature) { ... }` block (current lines 169-312) with a worker function + pool call. The worker body is the current loop body, transformed to (1) accumulate into a local `tally` instead of the outer counters, (2) call `handle.requestStop()` + set `tally.abortReason` instead of `break outer` on rate limit, and (3) `return tally` instead of falling through:

```ts
  const featureEntries = Array.from(byFeature.entries())

  async function reviewFeatureGroup(
    [featureId, featureGroups]: [string, FeatureGroup[]],
    _index: number,
    handle: { requestStop(): void; readonly stopRequested: boolean },
  ): Promise<FeatureTally> {
    const tally: FeatureTally = { ...ZERO_TALLY }

    const feature = featureById.get(featureId)
    if (feature === undefined) {
      logger.warn(
        cyan(`feature=${featureId}`) +
          ` — feature no longer in clawpatch map; marking findings as 'uncertain'.`,
      )
      for (const group of featureGroups) {
        for (const record of group.findings) {
          await persistVerdict(repoRoot, record, 'uncertain', runId, {
            agentEvidence: 'feature no longer present in clawpatch map',
          })
          tally.revalidated += 1
          tally.uncertain += 1
        }
      }
      tally.featuresTouched += 1
      return tally
    }

    const lock = await acquireFeatureLock(repoRoot, featureId, runId)
    if (lock === null) {
      logger.info(cyan(`feature=${featureId} skipped — locked by another runner`))
      return tally
    }

    tally.featuresTouched += 1
    try {
      for (const group of featureGroups) {
        logger.info(
          cyan(`feature=${featureId} persona=${group.persona}`) +
            ` revalidating ${group.findings.length} finding(s)`,
        )

        let persona
        try {
          persona = resolveReviewer(group.persona)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(
            `  ${group.persona}: persona no longer registered — marking findings as 'uncertain'. (${msg})`,
          )
          for (const record of group.findings) {
            await persistVerdict(repoRoot, record, 'uncertain', runId, {
              agentEvidence: `persona "${group.persona}" no longer registered`,
            })
            tally.revalidated += 1
            tally.uncertain += 1
          }
          continue
        }

        let result
        try {
          result = await revalidateFeatureGroupWithAgent({
            feature,
            persona,
            openFindings: group.findings,
            repoRoot,
            repoUrl: opts.repoUrl,
            branch: opts.branch,
            indexerUrl: opts.indexerUrl,
            model: cli.model,
            maxIterations: cli.maxIterations,
            timeoutSec: cli.agenticTimeout,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (isRateLimitError(err)) {
            tally.leftOpen += group.findings.length
            tally.abortReason = msg
            logger.error(
              `  ${group.persona}: rate limit hit — stopping new work. Already-written records are preserved. (${msg})`,
            )
            handle.requestStop()
            return tally
          }
          const kind = isTransientModelError(err) ? 'transient model error' : 'error'
          logger.warn(
            `  ${group.persona}: ${kind} — leaving ${group.findings.length} finding(s) untouched for retry. (${msg})`,
          )
          tally.leftOpen += group.findings.length
          continue
        }

        if (!result.blockParsed) {
          logger.warn(
            `  ${group.persona}: agent did not emit a parseable kode-revalidations block (${result.blockError ?? 'unknown'}) — leaving findings untouched for retry.`,
          )
        }

        let missingCount = 0
        for (const record of group.findings) {
          const verdictEntry = result.verdicts.get(record.findingId)
          if (verdictEntry === undefined) {
            missingCount += 1
            tally.leftOpen += 1
            continue
          }
          const verdict = verdictEntry.verdict
          await persistVerdict(repoRoot, record, verdict, runId, {
            agentEvidence: verdictEntry.evidence,
          })
          tally.revalidated += 1
          if (verdict === 'fixed') tally.closed += 1
          else if (verdict === 'uncertain') tally.uncertain += 1
          else if (verdict === 'still-present') tally.stillPresent += 1
        }

        if (missingCount > 0 && result.blockParsed) {
          logger.warn(
            `  ${group.persona}: agent omitted ${missingCount} verdict(s); left untouched for retry.`,
          )
        }

        if (result.truncated) {
          logger.warn(`  ${group.persona}: ${result.truncationReason ?? 'truncated'}`)
        }
      }
    } finally {
      await releaseFeatureLock(repoRoot, featureId)
    }

    return tally
  }

  const concurrency = Math.max(1, cli.jobs)
  const outcome = await runPool(featureEntries, concurrency, reviewFeatureGroup)

  // Sum the per-feature tallies.
  let revalidated = 0
  let closed = 0
  let uncertainCount = 0
  let stillPresent = 0
  let leftOpen = 0
  let featuresTouched = 0
  let abortReason: string | null = null
  for (const t of outcome.results) {
    revalidated += t.revalidated
    closed += t.closed
    uncertainCount += t.uncertain
    stillPresent += t.stillPresent
    leftOpen += t.leftOpen
    featuresTouched += t.featuresTouched
    if (t.abortReason && abortReason === null) abortReason = t.abortReason
  }
```

(d) Remove the now-defunct outer-scope mutable declarations (`let revalidated = 0` … `let abortLoop` and the `byFeature`-building loop stays; the `runId`/`startedAt` stay). The summed locals above replace them. Update the post-loop code:

- `appendRunHistory(...)` — unchanged arguments (uses the summed `revalidated`, `closed`, `uncertainCount`, `stillPresent`, `leftOpen`, `featuresTouched`).
- Replace `if (abortLoop !== null)` with `if (abortReason !== null)` and use `abortReason` for `abortReason:` in the returned object.

```ts
  if (abortReason !== null) {
    return {
      featuresReviewed: featuresTouched,
      featuresSkipped: 0,
      findingsEmitted: 0,
      findingsSuppressed: 0,
      findingsOnDisk,
      aborted: true,
      abortReason,
    }
  }
```

> **Behavior delta (intentional, document in commit):** today `break outer` stops *immediately*; the pooled version lets the (≤ `jobs−1`) in-flight features finish before returning `aborted: true`. Their verdicts are persisted as they complete — strictly more progress preserved, never less. With `--jobs 1` the behavior is identical to today (single lane, stop after the aborting feature).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/repo-audit/__tests__/orchestrator-revalidate.test.ts`
Expected: PASS — including `maxActive > 1` and the abort test (`aborted: true`, feat-A still `open`).

- [ ] **Step 5: Commit**

```bash
git add src/repo-audit/orchestrator-revalidate.ts src/repo-audit/__tests__/orchestrator-revalidate.test.ts
git commit -m "feat(repo-audit): parallelize --revalidate via --jobs worker pool"
```

---

### Task 5: Parallelize the audit orchestrator (SECONDARY)

**Files:**
- Modify: `src/repo-audit/orchestrator.ts`
- Test: `src/repo-audit/__tests__/orchestrator.test.ts`

Same transformation applied to the audit per-feature loop (current `orchestrator.ts:208-323`). `clawpatch init` + `clawpatch map` + feature read + the `toReview` filtering all stay **before** the pool (mapping is once-per-run, sequential). Only the review loop parallelizes.

- [ ] **Step 1: Write the failing concurrency + abort tests**

Add to `src/repo-audit/__tests__/orchestrator.test.ts`, mirroring the existing harness (it mocks `reviewFeatureWithAgent`, clawpatch CLI, and `readFeatures`). Two tests:

```ts
describe('runRepoAudit — concurrency', () => {
  it('reviews multiple pending features in parallel under --jobs 3', async () => {
    // Arrange: clawpatch map mocked OK, readFeatures returns 3 pending features,
    // no existing findings on disk (so all 3 are toReview).
    let active = 0
    let maxActive = 0
    mocks.reviewFeatureWithAgent.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return { findings: [], truncated: false }
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://example/r.git',
      cli: { ...baseCli, scope: 'repo', jobs: 3 },
    })

    expect(maxActive).toBeGreaterThan(1)
    expect(result.featuresReviewed).toBe(3)
  })

  it('a rate-limit aborts the run but preserves prior findings (aborted=true)', async () => {
    const rateLimit = Object.assign(new Error('429 rate limit'), { status: 429 })
    mocks.reviewFeatureWithAgent.mockRejectedValueOnce(rateLimit)
      .mockResolvedValue({ findings: [], truncated: false })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://example/r.git',
      cli: { ...baseCli, scope: 'repo', jobs: 2 },
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/rate limit/i)
  })
})
```

> Reuse the existing mock setup (`mocks.reviewFeatureWithAgent`, the clawpatch/readFeatures mocks) already present in this test file — match its fixture-building helpers; do not invent new mocking infrastructure.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/repo-audit/__tests__/orchestrator.test.ts`
Expected: FAIL — `maxActive` stays 1.

- [ ] **Step 3: Refactor the audit review loop to use `runPool`**

In `src/repo-audit/orchestrator.ts`:

(a) Add import:

```ts
import { runPool } from '../utils/concurrency.js'
```

(b) After the `toReview` filtering and `const runId = newRunId(); const startedAt = ...`, replace the `for (const feature of toReview) { ... }` block (lines 208-323) and the trailing run-history/return with a worker + pool. Worker returns a tally:

```ts
  interface AuditTally {
    reviewed: number
    emitted: number
    suppressed: number
    abortReason?: string
  }

  async function reviewFeature(
    feature: (typeof toReview)[number],
    _index: number,
    handle: { requestStop(): void; readonly stopRequested: boolean },
  ): Promise<AuditTally> {
    const tally: AuditTally = { reviewed: 0, emitted: 0, suppressed: 0 }

    const personaNames = resolvePersonasWithOverride(
      feature,
      cli.reviewers === undefined || arraysEqual(cli.reviewers, ['general']) ? [] : cli.reviewers,
    )

    const lock = await acquireFeatureLock(repoRoot, feature.featureId, runId)
    if (lock === null) {
      logger.info(cyan(`feature=${feature.featureId} skipped — locked by another runner`))
      return tally
    }

    logger.info(cyan(`feature=${feature.featureId} personas=${personaNames.join(',')}`))

    try {
      for (const name of personaNames) {
        const persona = resolveReviewer(name)
        let result
        try {
          result = await reviewFeatureWithAgent({
            feature,
            persona,
            repoRoot,
            repoUrl: opts.repoUrl,
            branch: opts.branch,
            indexerUrl: opts.indexerUrl,
            model: cli.model,
            maxIterations: cli.maxIterations,
            timeoutSec: cli.agenticTimeout,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (isRateLimitError(err)) {
            logger.error(
              `  ${persona.name}: rate limit hit — stopping new work. Already-written findings are preserved. (${msg})`,
            )
            tally.abortReason = msg
            handle.requestStop()
            // Count this feature as reviewed-in-progress before returning so
            // featuresReviewed matches the prior single-threaded accounting.
            tally.reviewed += 1
            return tally
          }
          if (isTransientModelError(err)) {
            logger.warn(`  ${persona.name}: transient model error — skipping this persona. (${msg})`)
          } else {
            logger.warn(`  ${persona.name}: error — skipping this persona. (${msg})`)
          }
          continue
        }

        let kept = result.findings
        if (!cli.noSuppressions) {
          const filtered = await filterSuppressedStructured(result.findings, repoRoot)
          kept = filtered.kept
          tally.suppressed += filtered.suppressedCount
          if (filtered.suppressedCount > 0) {
            logger.info(
              yellow(`  Suppressed ${filtered.suppressedCount} finding(s) via kode-review: ignore markers`),
            )
          }
        }

        for (const f of kept) {
          const findingId = computeFindingId(feature.featureId, f.file, f.lineStart, f.title)
          const record: RepoFindingRecord = {
            schemaVersion: 1,
            findingId,
            featureId: feature.featureId,
            persona: persona.name,
            status: 'open',
            finding: f,
            createdByRunId: runId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          await writeFinding(repoRoot, record)
          tally.emitted += 1
        }

        if (result.truncated) {
          logger.warn(`  ${persona.name}: ${result.truncationReason ?? 'truncated'}`)
        }
      }
    } finally {
      await releaseFeatureLock(repoRoot, feature.featureId)
    }

    tally.reviewed += 1
    return tally
  }

  const concurrency = Math.max(1, cli.jobs)
  const outcome = await runPool(toReview, concurrency, reviewFeature)

  let totalEmitted = 0
  let totalSuppressed = 0
  let reviewed = 0
  let abortReason: string | null = null
  for (const t of outcome.results) {
    totalEmitted += t.emitted
    totalSuppressed += t.suppressed
    reviewed += t.reviewed
    if (t.abortReason && abortReason === null) abortReason = t.abortReason
  }

  await appendRunHistory(repoRoot, {
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    engine: 'kode-agent',
    featuresReviewed: reviewed,
    findingsEmitted: totalEmitted,
    model: cli.model,
    since: cli.since,
  })

  return {
    featuresReviewed: reviewed,
    featuresSkipped: skipped,
    findingsEmitted: totalEmitted,
    findingsSuppressed: totalSuppressed,
    findingsOnDisk: (await listFindings(repoRoot)).length,
    ...(abortReason !== null ? { aborted: true, abortReason } : {}),
  }
```

> This collapses the old code's two run-history-write sites (one in the abort branch, one at the end) into a single post-pool append, matching the revalidate orchestrator's shape. The `abortReason += 1`-style accounting note: a rate-limited feature counts `reviewed += 1` before returning, preserving the old `reviewed += 1; if (abortLoop) ...` accounting where the in-progress feature was counted.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/repo-audit/__tests__/orchestrator.test.ts`
Expected: PASS — including `maxActive > 1` and the abort test.

- [ ] **Step 5: Commit**

```bash
git add src/repo-audit/orchestrator.ts src/repo-audit/__tests__/orchestrator.test.ts
git commit -m "feat(repo-audit): parallelize audit review loop via --jobs worker pool"
```

---

### Task 6: Docs + full verification sweep

**Files:**
- Modify: `CLAUDE.md` (repo-audit section)

- [ ] **Step 1: Update CLAUDE.md**

In the `### Repo-Scope Audit (--scope repo)` section, under **`orchestrator.ts`**, change the description to note parallelism. Replace the orchestrator bullet:

```
- **`orchestrator.ts`** — `runRepoAudit`: install gate → clawpatch map → readFeatures → since/already-reviewed filter → per-feature review (parallel, bounded by `--jobs`, default 2) with persona dispatch → write findings → render
```

And add a line under the orchestrator-revalidate description noting it shares the same `--jobs` pool. Add to the "Caps" or a new note:

```
**Concurrency:** both the audit loop and `--revalidate` review features in parallel via an in-process worker pool (`src/utils/concurrency.ts`), bounded by `--jobs` (default 2). `--jobs 1` is fully sequential. Per-feature locks (`.kode-review/locks/`) still coordinate across separate processes; the pool coordinates within one. The binding constraint on raising `--jobs` is the model provider's rate limit — a rate-limit hit stops scheduling new features and returns `aborted: true` with partial progress preserved on disk.
```

- [ ] **Step 2: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: document --jobs parallelism for repo-scope audit + revalidate"
```

- [ ] **Step 3: Full verification (Step 9 gate)**

Run all of:

```bash
bun run typecheck
bun run lint
bun run test
```

Expected: all green. Fix any fallout (e.g., other test fixtures that assumed sequential ordering of findings — findings are keyed by deterministic id, not order, so ordering should not matter, but verify `orchestrator-revalidate.test.ts` / `orchestrator.test.ts` existing assertions don't depend on log/processing order).

- [ ] **Step 4: User-exercise (Step 7 gate) — drive the real CLI**

Against this repo (which is a git repo; clawpatch must be on PATH for the audit path, but `--revalidate` only needs existing findings):

```bash
bun run build
# Seed or reuse existing findings, then time sequential vs parallel revalidate:
time node dist/index.js --scope repo --revalidate --jobs 1
time node dist/index.js --scope repo --revalidate --jobs 3
```

Verify: both complete, findings update consistently, `--jobs 3` wall-clock is meaningfully lower with multiple open findings across features, and run-history (`.kode-review/run-history.jsonl`) tallies match between runs (same closed/uncertain counts, order-independent). Capture the timing delta as evidence.

---

## Self-Review

**1. Spec coverage:**
- "In-process worker pool" → Task 2 (pool) + Tasks 4/5 (wiring). ✓
- "Default 2" → Task 3. ✓
- "Revalidate parallel" (primary ask) → Task 4. ✓
- Audit parallel (consistent extension) → Task 5. ✓
- Safety gate on pi concurrent sessions → Task 1. ✓
- Rate-limit abort preserved under concurrency → Tasks 4/5 abort tests. ✓
- Cross-process locks still honored → unchanged `acquireFeatureLock` inside workers; documented in Task 6. ✓

**2. Placeholder scan:** Task 1 is an explicit spike with `as never` scratch casts (flagged as exploration, deleted after). All production code steps (Tasks 2-5) show complete code. No "TODO"/"handle edge cases"/"similar to Task N" in committed code.

**3. Type consistency:** `runPool(items, concurrency, worker) → PoolOutcome<R>` with `PoolHandle.requestStop()`/`stopRequested` used identically in Tasks 2, 4, 5. Tally types (`FeatureTally`, `AuditTally`) defined where used. `cli.jobs: number` (existing) read as `Math.max(1, cli.jobs)` in both orchestrators. `RunRepoAuditResult` shape (incl. optional `aborted`/`abortReason`) unchanged.

**Risk flagged for execution:** Task 1 is a hard gate. If pi cannot run concurrent sessions in-process, Tasks 4-5 must not proceed as written — escalate for the child-process fallback.

**Gate reminder (per engineering standards):** each code-shipping task (2-5) runs Step 5 test-audit (sub-agent) before Step 6, Step 8 code review (kode-review agentic mode), and the Step 10 report. Task 6 Step 3/4 satisfy Steps 9 and 7 for the feature as a whole.
