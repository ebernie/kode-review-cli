# Repo-Audit Checkpointing + Findings-Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--scope repo` audits (a) survive transient/rate-limit model errors without losing already-persisted findings, and (b) actually produce structured findings under the agentic feature-review prompt.

**Architecture:**

- **Phase 1 (#4 — checkpointing):** Per-persona calls in `src/repo-audit/orchestrator.ts` now run inside a try/catch. Transient errors log and continue; rate-limit errors break the per-feature loop early but `runRepoAudit` returns normally with an `aborted` flag. `src/index.ts:runRepoScopeAudit` wraps `runRepoAudit` in a try/finally so the on-disk report renders even when the audit aborts.
- **Phase 2 (#1 — findings block):** Extract the canonical `kode-findings` instruction block from `src/review/prompt.ts` into a shared exported constant, then append it to the user prompt built by `src/repo-audit/prompts.ts:buildFeatureReviewPrompt`. The persona templates stay untouched.

**Tech Stack:** TypeScript (strict), Vitest, Zod. No new dependencies.

---

## File Structure

**Phase 1 (rate-limit checkpointing):**

- Create: `src/repo-audit/error-classify.ts` — `isRateLimitError(err)` and `isTransientModelError(err)` helpers, string-pattern based.
- Create: `src/repo-audit/__tests__/error-classify.test.ts` — unit tests for the classifier.
- Modify: `src/repo-audit/orchestrator.ts` — wrap each `reviewFeatureWithAgent` call in try/catch; new `aborted` field on the result.
- Modify: `src/repo-audit/types.ts` — extend `RunRepoAuditResult` (the type currently lives inline in `orchestrator.ts`; move it to `types.ts` or extend the inline definition — see Task 3 for the choice).
- Modify: `src/repo-audit/__tests__/orchestrator.test.ts` — new cases for continue-on-error and break-on-rate-limit.
- Modify: `src/index.ts` — try/finally around `runRepoAudit`; always call `writeRepoReport` and `listRepoAuditFindings`.

**Phase 2 (findings block in feature prompt):**

- Modify: `src/review/prompt.ts` — extract the existing kode-findings schema section into an exported `FINDINGS_BLOCK_INSTRUCTIONS` constant and reuse it in the existing `PROMPT_TEMPLATE`.
- Modify: `src/review/index.ts` — re-export `FINDINGS_BLOCK_INSTRUCTIONS`.
- Modify: `src/repo-audit/prompts.ts` — append `FINDINGS_BLOCK_INSTRUCTIONS` to the user prompt body inside `buildFeatureReviewPrompt`.
- Modify: `src/repo-audit/__tests__/prompts.test.ts` — assert the built prompt contains the fence tag and required schema fields.
- Modify: `src/review/__tests__/prompt.test.ts` — keep the existing test green; add a test that `FINDINGS_BLOCK_INSTRUCTIONS` is the substring used by the prompt builder.

---

## Phase 1 — Rate-limit checkpointing

### Task 1: Error classifier

**Files:**
- Create: `src/repo-audit/error-classify.ts`
- Test: `src/repo-audit/__tests__/error-classify.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/repo-audit/__tests__/error-classify.test.ts
import { describe, expect, it } from 'vitest'
import { isRateLimitError, isTransientModelError } from '../error-classify.js'

describe('isRateLimitError', () => {
  it('detects ChatGPT plus-plan usage-limit messages', () => {
    const err = new Error(
      'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~261 min.',
    )
    expect(isRateLimitError(err)).toBe(true)
  })

  it('detects HTTP 429 mentions', () => {
    expect(isRateLimitError(new Error('Request failed: 429 Too Many Requests'))).toBe(true)
  })

  it('detects "rate limit" phrasing regardless of case', () => {
    expect(isRateLimitError(new Error('Rate Limit exceeded for model openai/gpt-5'))).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isRateLimitError(new Error('ENOENT: no such file'))).toBe(false)
    expect(isRateLimitError(new Error('Review response contained no text content.'))).toBe(false)
  })

  it('tolerates non-Error inputs', () => {
    expect(isRateLimitError('429 Too Many Requests')).toBe(true)
    expect(isRateLimitError(undefined)).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})

describe('isTransientModelError', () => {
  it('treats rate-limits as transient', () => {
    expect(isTransientModelError(new Error('429 Too Many Requests'))).toBe(true)
  })

  it('treats timeouts as transient', () => {
    expect(isTransientModelError(new Error('Review did not complete within 600s.'))).toBe(true)
    expect(isTransientModelError(new Error('ETIMEDOUT contacting api.openai.com'))).toBe(true)
  })

  it('returns false for code-side bugs', () => {
    expect(isTransientModelError(new TypeError('foo is not a function'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test — expect failures**

```
npx vitest run src/repo-audit/__tests__/error-classify.test.ts
```
Expected: FAIL — module `../error-classify.js` not found.

- [ ] **Step 3: Implement the classifier**

```ts
// src/repo-audit/error-classify.ts
/**
 * Classify model-side errors so the orchestrator can decide whether to
 * continue with the next persona/feature, break the loop early, or surface
 * the failure as terminal.
 *
 * Pattern-based on the error message because pi exposes upstream provider
 * errors as plain `Error` instances without status codes. We accept some
 * fuzziness here: false negatives mean the loop aborts on a recoverable
 * error (annoying but safe); false positives mean we keep churning through
 * a real rate-limit (the next call hits the same wall and we abort then).
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate[\s-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /quota.*exceeded/i,
]

const TIMEOUT_PATTERNS: RegExp[] = [
  /did not complete within/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bsocket hang up\b/i,
]

function messageOf(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

export function isRateLimitError(err: unknown): boolean {
  const msg = messageOf(err)
  if (msg.length === 0) return false
  return RATE_LIMIT_PATTERNS.some((re) => re.test(msg))
}

export function isTransientModelError(err: unknown): boolean {
  if (isRateLimitError(err)) return true
  const msg = messageOf(err)
  if (msg.length === 0) return false
  return TIMEOUT_PATTERNS.some((re) => re.test(msg))
}
```

- [ ] **Step 4: Run the tests — expect PASS**

```
npx vitest run src/repo-audit/__tests__/error-classify.test.ts
```
Expected: PASS (all 7 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/repo-audit/error-classify.ts src/repo-audit/__tests__/error-classify.test.ts
git commit -m "feat(repo-audit): add isRateLimitError + isTransientModelError classifier"
```

---

### Task 2: Make the per-feature loop resilient + propagate `aborted`

**Files:**
- Modify: `src/repo-audit/orchestrator.ts:41-48` (extend `RunRepoAuditResult`)
- Modify: `src/repo-audit/orchestrator.ts:181-238` (wrap loop body in try/catch)
- Test: `src/repo-audit/__tests__/orchestrator.test.ts` (add two scenarios)

- [ ] **Step 1: Write the failing tests**

Append to `src/repo-audit/__tests__/orchestrator.test.ts` (inside the existing top-level `describe`, after the last `it(...)` block — do NOT remove existing tests; check the bottom of the file for the closing brace):

```ts
  it('continues to the next persona when one persona throws a non-rate-limit error', async () => {
    mocks.isNodeVersionCompatible.mockReturnValue(true)
    mocks.detectClawpatch.mockResolvedValue({ installed: true, version: '0.3.0' })
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await writeFeatureFile(tmp, 'feat_a', { trustBoundaries: ['cli'], kind: 'cli-command' })

    let callCount = 0
    mocks.reviewFeatureWithAgent.mockImplementation(async ({ persona }) => {
      callCount += 1
      if (persona.name === 'security') {
        throw new Error('Some weird transient blip')
      }
      return {
        feature: undefined,
        persona,
        findings: [
          {
            severity: 'LOW',
            category: 'maintainability',
            confidence: 'HIGH',
            title: `tidy from ${persona.name}`,
            file: 'src/foo.ts',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'foo',
            problem: 'p',
            recommendation: 'r',
          },
        ],
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        truncated: false,
      }
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli },
    })

    // general + security + test-auditor were dispatched; security threw,
    // general + test-auditor each emitted one finding.
    expect(callCount).toBe(3)
    expect(result.featuresReviewed).toBe(1)
    expect(result.findingsEmitted).toBe(2)
    expect(result.aborted).toBeFalsy()
  })

  it('breaks the loop on a rate-limit error and reports aborted=true', async () => {
    mocks.isNodeVersionCompatible.mockReturnValue(true)
    mocks.detectClawpatch.mockResolvedValue({ installed: true, version: '0.3.0' })
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await writeFeatureFile(tmp, 'feat_x', { trustBoundaries: ['cli'], kind: 'cli-command' })
    await writeFeatureFile(tmp, 'feat_y', { trustBoundaries: ['cli'], kind: 'cli-command' })

    let call = 0
    mocks.reviewFeatureWithAgent.mockImplementation(async ({ persona }) => {
      call += 1
      if (call === 1) {
        return {
          feature: undefined,
          persona,
          findings: [],
          content: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          truncated: false,
        }
      }
      throw new Error(
        'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min.',
      )
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli },
    })

    // Loop broke after the rate-limit fired on the second persona of feat_x —
    // we should NOT have proceeded to feat_y's personas.
    expect(call).toBeLessThanOrEqual(3)
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/usage limit|rate.?limit/i)
    expect(result.featuresReviewed).toBeLessThanOrEqual(1)
  })
```

You will need a small helper `writeFeatureFile(tmp, featureId, overrides)` if one does not already exist in the test file — check before duplicating. If absent, add this helper near the top of the file:

```ts
async function writeFeatureFile(
  root: string,
  featureId: string,
  overrides: Partial<{ trustBoundaries: string[]; kind: string }> = {},
): Promise<void> {
  const dir = join(root, '.clawpatch', 'features')
  await mkdir(dir, { recursive: true })
  const payload = {
    schemaVersion: 1,
    featureId,
    title: featureId,
    kind: overrides.kind ?? 'cli-command',
    summary: 'test feature',
    confidence: 0.9,
    ownedFiles: [{ path: 'src/foo.ts', reason: 'owned' }],
    contextFiles: [],
    entrypoints: [],
    tests: [],
    trustBoundaries: overrides.trustBoundaries ?? [],
    tags: [],
  }
  await writeFile(join(dir, `${featureId}.json`), JSON.stringify(payload), 'utf-8')
}
```

- [ ] **Step 2: Run the tests — expect failures**

```
npx vitest run src/repo-audit/__tests__/orchestrator.test.ts
```
Expected: FAIL on the new cases (the loop currently rethrows, so the whole `runRepoAudit` call rejects; `result.aborted` does not exist).

- [ ] **Step 3: Extend `RunRepoAuditResult`**

In `src/repo-audit/orchestrator.ts`, modify the `RunRepoAuditResult` interface (currently lines 41–48):

```ts
export interface RunRepoAuditResult {
  featuresReviewed: number
  featuresSkipped: number
  findingsEmitted: number
  findingsSuppressed: number
  /** Total findings on disk after the run (open + closed). */
  findingsOnDisk: number
  /** True if a transient/terminal error stopped the loop before all features were reviewed. */
  aborted?: boolean
  /** Human-readable explanation when aborted is true (e.g. rate-limit notice). */
  abortReason?: string
}
```

Update every `return { ... }` in `runRepoAudit` to be explicit about `aborted: false` ONLY when the run reached the end of `toReview` normally. (Adding the field is sufficient; TypeScript will not require it on every return because it is optional.)

- [ ] **Step 4: Wrap the per-persona call in try/catch and break on rate-limit**

In `src/repo-audit/orchestrator.ts`, replace the existing inner `for (const name of personaNames) { ... }` block (currently lines 187–235) with:

```ts
    let abortLoop: { reason: string } | null = null
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
            `  ${persona.name}: rate limit hit — aborting the run. Already-written findings are preserved. (${msg})`,
          )
          abortLoop = { reason: msg }
          break
        }
        if (isTransientModelError(err)) {
          logger.warn(`  ${persona.name}: transient model error — skipping this persona. (${msg})`)
        } else {
          logger.warn(`  ${persona.name}: error — skipping this persona. (${msg})`)
        }
        continue
      }

      // Apply structured suppression filter (unless --no-suppressions).
      let kept = result.findings
      let suppressedThisRun = 0
      if (!cli.noSuppressions) {
        const filtered = await filterSuppressedStructured(result.findings, repoRoot)
        kept = filtered.kept
        suppressedThisRun = filtered.suppressedCount
        totalSuppressed += suppressedThisRun
        if (suppressedThisRun > 0) {
          logger.info(yellow(`  Suppressed ${suppressedThisRun} finding(s) via kode-review: ignore markers`))
        }
      }

      // Persist findings.
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
        totalEmitted += 1
      }

      if (result.truncated) {
        logger.warn(`  ${persona.name}: ${result.truncationReason ?? 'truncated'}`)
      }
    }

    reviewed += 1
    if (abortLoop) {
      // Record what we accomplished and propagate aborted=true to the caller.
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
        aborted: true,
        abortReason: abortLoop.reason,
      }
    }
  }
```

Then add the import at the top of `src/repo-audit/orchestrator.ts`:

```ts
import { isRateLimitError, isTransientModelError } from './error-classify.js'
```

- [ ] **Step 5: Run the orchestrator tests — expect PASS**

```
npx vitest run src/repo-audit/__tests__/orchestrator.test.ts
```
Expected: PASS for both new tests AND all existing tests in the file (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/repo-audit/orchestrator.ts src/repo-audit/__tests__/orchestrator.test.ts
git commit -m "feat(repo-audit): continue past persona errors, break + checkpoint on rate-limit"
```

---

### Task 3: Render on-disk findings even when audit aborts

**Files:**
- Modify: `src/index.ts:570-609` (runRepoScopeAudit)

- [ ] **Step 1: Replace the body of `runRepoScopeAudit`**

In `src/index.ts`, replace the `runRepoAudit(...)` call and everything after it inside `runRepoScopeAudit` (currently lines 570–609) with:

```ts
  let result: Awaited<ReturnType<typeof runRepoAudit>> | null = null
  let runError: unknown = null
  try {
    result = await runRepoAudit({
      repoRoot,
      repoUrl,
      branch,
      indexerUrl,
      cli: options,
    })
  } catch (err) {
    runError = err
    logger.error(
      `Repo audit terminated early: ${err instanceof Error ? err.message : String(err)}. ` +
        `Rendering whatever findings landed on disk before the failure.`,
    )
  }

  // Always render whatever's on disk — even on hard abort the previously
  // persisted findings are still useful to the user.
  const allFindings = await listRepoAuditFindings(repoRoot)
  await writeRepoReport({
    records: allFindings,
    format: options.format,
    suppressionsDisabled: options.noSuppressions,
    outputFile: options.outputFile,
    quiet: options.quiet,
  })

  if (result) {
    const abortedSuffix = result.aborted ? ' (aborted)' : ''
    logger.success(
      cyan(
        `Repo audit complete${abortedSuffix}: reviewed=${result.featuresReviewed} ` +
          `skipped=${result.featuresSkipped} ` +
          `findings=${result.findingsEmitted} ` +
          `suppressed=${result.findingsSuppressed} ` +
          `on-disk=${result.findingsOnDisk}`,
      ),
    )
    if (result.aborted) {
      logger.warn(`Abort reason: ${result.abortReason ?? '(unspecified)'}`)
    }
  }

  // CI mode: fail on CRITICAL (or HIGH if --fail-on=high).
  if (options.ci) {
    const triggerSev = options.failOn === 'high' ? ['CRITICAL', 'HIGH'] : ['CRITICAL']
    const blockers = allFindings.filter(
      (r) => r.status === 'open' && triggerSev.includes(r.finding.severity),
    )
    if (options.failOn !== 'none' && blockers.length > 0) {
      logger.error(`CI mode: ${blockers.length} ${options.failOn.toUpperCase()}+ finding(s); failing.`)
      process.exit(1)
    }
  }

  // Re-throw any hard error AFTER rendering, so the user still gets their
  // findings file but the shell still sees a non-zero exit.
  if (runError) {
    throw runError
  }
```

- [ ] **Step 2: Type-check**

```
bun run typecheck
```
Expected: PASS.

- [ ] **Step 3: Run all tests to confirm no regression**

```
bun run test
```
Expected: PASS (whole suite green).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(repo-audit): always render on-disk findings, even when audit aborts"
```

---

## Phase 2 — kode-findings instructions in feature prompt

### Task 4: Extract `FINDINGS_BLOCK_INSTRUCTIONS` for reuse

**Files:**
- Modify: `src/review/prompt.ts:222-251` (extract constant)
- Modify: `src/review/index.ts` (re-export)
- Modify: `src/review/__tests__/prompt.test.ts` (add test the constant is used)

- [ ] **Step 1: Read the current `PROMPT_TEMPLATE`**

Open `src/review/prompt.ts` and locate the literal section starting `### Part 2 — Structured findings (REQUIRED)` (line ~222) and ending after the bulleted "Rules for the structured block" list (line ~250).

- [ ] **Step 2: Extract into an exported constant**

Above the `PROMPT_TEMPLATE` definition in `src/review/prompt.ts`, add:

```ts
/**
 * The structured-output instruction block that downstream parsers depend on.
 * Exported so non-diff prompt paths (agentic, repo-scope feature review) can
 * reuse the exact same schema instructions instead of duplicating them.
 */
export const FINDINGS_BLOCK_INSTRUCTIONS = `### Part 2 — Structured findings (REQUIRED)

After the markdown section, you are REQUIRED to emit a fenced code block tagged \`kode-findings\` containing a JSON object that mirrors the issues above. Downstream tooling parses this block; without it the review is incomplete.

\`\`\`kode-findings
{
  "findings": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "security" | "correctness" | "performance" | "maintainability" | "concurrency" | "api-contract" | "error-handling" | "testing" | "documentation" | "other",
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "title": "Short one-line title",
      "file": "path/relative/to/repo.ts",
      "lineStart": 42,
      "lineEnd": 48,
      "evidence": "The exact code or quoted text that demonstrates the issue. REQUIRED. Empty strings are rejected.",
      "problem": "Why this is wrong.",
      "recommendation": "What to do instead."
    }
  ]
}
\`\`\`

Rules for the structured block:
- Every finding must include \`evidence\` quoting the actual code that proves the issue. No evidence = no finding.
- \`category\` must be one of the listed values — do not invent new categories ("style", "nit", "readability" → use \`maintainability\`).
- \`severity\` and \`confidence\` must each be one of the listed values, treated as independent axes.
- If there are no issues, emit \`{ "findings": [] }\`.
- Emit exactly ONE \`kode-findings\` block, after the markdown.
`
```

Then update `PROMPT_TEMPLATE` to interpolate the constant in place of the inline text. The current literal `### Part 2 — Structured findings (REQUIRED)\n\n...Emit exactly ONE \`kode-findings\` block, after the markdown.\n` (lines 222–251) becomes:

```ts
// inside PROMPT_TEMPLATE — replace the inline Part 2 section with:
${FINDINGS_BLOCK_INSTRUCTIONS}
```

Verify by reading the file after editing — `PROMPT_TEMPLATE` should still end with the same trailing back-tick and no duplication.

- [ ] **Step 3: Re-export from the barrel**

In `src/review/index.ts`, add `FINDINGS_BLOCK_INSTRUCTIONS` to the existing `prompt.js` re-export block. Find the existing re-export from `./prompt.js` and add the new symbol alongside it.

- [ ] **Step 4: Strengthen the existing prompt test**

In `src/review/__tests__/prompt.test.ts`, after the existing `it('demands a fenced kode-findings JSON block in the output format', ...)` test, add:

```ts
  it('uses the shared FINDINGS_BLOCK_INSTRUCTIONS constant', () => {
    const p = buildReviewPrompt(SAMPLE_INPUT)
    // Importing inline to avoid changing the top of the file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(p).toContain(FINDINGS_BLOCK_INSTRUCTIONS)
  })
```

And add `FINDINGS_BLOCK_INSTRUCTIONS` to the existing `import { ... } from '../prompt.js'` line at the top of the test file (replace the existing import line — do NOT add a duplicate import). If the test file's existing `SAMPLE_INPUT` constant isn't reachable, use whatever fixture the surrounding tests already build.

- [ ] **Step 5: Run the existing prompt tests — expect PASS**

```
npx vitest run src/review/__tests__/prompt.test.ts
```
Expected: PASS (existing assertions + the new constant-reuse assertion).

- [ ] **Step 6: Type-check**

```
bun run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/review/prompt.ts src/review/index.ts src/review/__tests__/prompt.test.ts
git commit -m "refactor(review): extract FINDINGS_BLOCK_INSTRUCTIONS for cross-path reuse"
```

---

### Task 5: Append findings-block instructions to feature-review prompt

**Files:**
- Modify: `src/repo-audit/prompts.ts:203-210` (append the block)
- Test: `src/repo-audit/__tests__/prompts.test.ts` (assert presence)

- [ ] **Step 1: Write the failing test**

In `src/repo-audit/__tests__/prompts.test.ts`, find the existing `describe('buildFeatureReviewPrompt', ...)` block. Add:

```ts
import { FINDINGS_BLOCK_INSTRUCTIONS, FINDINGS_FENCE_TAG } from '../../review/index.js'

// ... inside the existing describe block:
  it('includes the kode-findings schema instructions in the user prompt', async () => {
    // Reuse whatever feature-record factory the existing tests use, or build
    // a minimal one inline:
    const built = await buildFeatureReviewPrompt({
      feature: minimalFeatureRecord(),
      repoRoot: tmp, // tmp dir already created by beforeEach
    })
    expect(built.userPrompt).toContain(FINDINGS_FENCE_TAG)
    expect(built.userPrompt).toContain(FINDINGS_BLOCK_INSTRUCTIONS)
    expect(built.userPrompt).toMatch(/REQUIRED.*kode-findings/i)
  })
```

If `minimalFeatureRecord()` does not exist in the test file already, add it near the top:

```ts
function minimalFeatureRecord(): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: 'feat_test_min',
    title: 'minimal',
    kind: 'cli-command',
    summary: 's',
    confidence: 1,
    ownedFiles: [],
    contextFiles: [],
    entrypoints: [],
    tests: [],
    trustBoundaries: [],
    tags: [],
  }
}
```

- [ ] **Step 2: Run the test — expect failure**

```
npx vitest run src/repo-audit/__tests__/prompts.test.ts
```
Expected: FAIL — `userPrompt` does not contain `kode-findings`.

- [ ] **Step 3: Append the instructions in `buildFeatureReviewPrompt`**

In `src/repo-audit/prompts.ts`, at the top add the import:

```ts
import { FINDINGS_BLOCK_INSTRUCTIONS } from '../review/index.js'
```

Then replace the current trailing `## Output Instructions` section (currently lines 203–210) with:

```ts
  parts.push('## Output Instructions')
  parts.push('')
  parts.push(
    'Apply your persona\'s severity rubric. Emit findings only with concrete evidence ' +
      'from files visible above OR files you read via tools in this session. Cap your output ' +
      `at ${REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE} findings — pick the most impactful.`,
  )
  parts.push('')
  // Structured-output contract: downstream parsers REQUIRE this block.
  parts.push(FINDINGS_BLOCK_INSTRUCTIONS)
```

- [ ] **Step 4: Run the prompts tests — expect PASS**

```
npx vitest run src/repo-audit/__tests__/prompts.test.ts
```
Expected: PASS (new test + every existing test in the file).

- [ ] **Step 5: Run the whole suite for safety**

```
bun run test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repo-audit/prompts.ts src/repo-audit/__tests__/prompts.test.ts
git commit -m "fix(repo-audit): include kode-findings instructions in feature-review prompt"
```

---

### Task 6: End-to-end verification on the real repo

**Files:** none (verification only).

- [ ] **Step 1: Build**

```
bun run build
```
Expected: build succeeds.

- [ ] **Step 2: Run a narrow repo audit against `openai-codex/gpt-5.5`**

Use `--since HEAD~3` to keep the scope small (rate limit was hit at 9 features previously; this should review <10).

```
rm -rf .kode-review/
node dist/index.js -s repo --model openai-codex/gpt-5.5 --since HEAD~3 --jobs 2 --format markdown -o /tmp/kode-review-run/findings.md 2>&1 | tee /tmp/kode-review-run/run.log
```

Expected:
- Log shows `[INFO] Using model openai-codex/gpt-5.5`
- Log shows `8 tools registered`
- **Zero (or very few) occurrences** of `Review output missing kode-findings block`
- `/tmp/kode-review-run/findings.md` exists and contains a non-empty severity table
- `.kode-review/findings/*.json` files exist

- [ ] **Step 3: Simulate rate-limit recovery**

Manually edit `src/repo-audit/error-classify.ts` temporarily to make `isRateLimitError` always return true (or run with `KODE_REVIEW_FORCE_ABORT=1` if you've wired that in) — OR simpler: just confirm via the unit test that the loop breaks on the synthetic rate-limit error. If you change anything, revert before commit.

- [ ] **Step 4: Lint**

```
bun run lint
```
Expected: clean.

- [ ] **Step 5: Final commit if anything moved**

If steps 2–4 surfaced anything that needed fixing, commit it with a clear message. Otherwise no commit needed.

- [ ] **Step 6: Final test-audit + code-review gates**

Per project CLAUDE.md Steps 5 & 8: dispatch a sub-agent test auditor on the new tests in `src/repo-audit/__tests__/error-classify.test.ts` and the additions to `orchestrator.test.ts` + `prompts.test.ts` + `prompt.test.ts`. Address Critical/High findings, then dispatch a code-reviewer sub-agent on the full diff. Document the agent ids in the Step 10 summary.

---

## Self-Review Checklist

- [x] Spec coverage: #4 (rate-limit checkpointing) → Tasks 1, 2, 3. #1 (kode-findings instructions) → Tasks 4, 5. Verification → Task 6.
- [x] Placeholder scan: no `TBD` / `add error handling` / `similar to Task N` patterns.
- [x] Type consistency: `RunRepoAuditResult.aborted`/`abortReason` introduced in Task 2 are consumed in Task 3. `FINDINGS_BLOCK_INSTRUCTIONS` defined in Task 4 is consumed in Task 5.
- [x] No new dependencies. No new top-level files beyond `error-classify.ts` + its test.
- [x] Each task ends with a commit.
- [x] Existing tests are checked for regression at task boundaries (orchestrator.test.ts in Task 2; `bun run test` in Tasks 3 and 5).
