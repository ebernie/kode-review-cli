# Tier 2 — VCS + Repo-Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 6 deferred Tier 2 audit findings on the VCS post-review surface, doctor diagnostic, LRU cache, and project-structure prompt-context reader. All TypeScript, single-file or two-file scope, vitest infrastructure already in place.

**Architecture:** Each task is a surgical fix to one or two existing files. TDD per CLAUDE.md: failing test → implementation → green. Each task is a self-contained commit. Per-task gates: test audit sub-agent before running tests, code review sub-agent before declaring done.

**Tech Stack:** TypeScript, Node 18+, vitest, Bun (package manager). **Use `bun run test` (not `bun test`)** — `bun test` shares module caches and breaks `vi.mock()` between files.

**Scope explicitly out:**
- Tier 3 (Python no-assertion tests, tautological TS tests) — separate plan.
- Indexer schema integrity (`files` PK, DELETE cascades, full re-index purge, usage-lookup ambiguity) — separate plan; needs new pg+pgvector test harness.
- Prompt-injection sanitization (XML tag variants, structural-tag attribute leaks, untrusted PR titles reach LLM) — separate plan; the right fix is one rewritten sanitizer + caller migration, not call-site patches.
- Indexer auth findings — marked `wont-fix` (localhost-only Docker).

**Stale findings dropped from scope after planning verification:**
- "Feature locks are implemented but not used during review" — `orchestrator.ts:191` already calls `acquireFeatureLock`. Audit was stale.
- "`--report-only` is blocked by the clawpatch Node gate" — `orchestrator.ts:84` already short-circuits before the Node-22 check at line 96. Audit was stale.

Both should drop out of `--revalidate` next time it runs.

---

### Task 1: LRU cache must not exceed maxSize when keys can be undefined

**Files:**
- Modify: `src/utils/cache.ts:78-104`
- Test: `src/utils/__tests__/cache.test.ts` (create if missing)

**Audit finding closed:** "LRU cache can exceed maxSize for undefined keys" (general MEDIUM).

**Why this is first:** Single-file, no external deps, no test infrastructure to spin up. Warms up the loop and clears the LRU finding before we touch user-visible surfaces.

**Why the bug exists:** The eviction loop at `cache.ts:90-96` reads `this.cache.keys().next().value`. JS `Map` allows `undefined` as a key — if the cache holds `(undefined, v)` as its oldest entry, `oldestKey !== undefined` evaluates false and the loop `break`s without evicting anything, leaving the cache one entry over `maxSize`. Subsequent `set()` calls keep accumulating.

- [ ] **Step 1: Inspect current LRU surface**

Run: `cat src/utils/cache.ts`

Confirm: the type `LRUCache<K, V>` parameterizes keys, so `K` could be `string | undefined`, `number`, or anything else.

- [ ] **Step 2: Write the failing test**

Create or append to `src/utils/__tests__/cache.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { LRUCache } from '../cache.js'

describe('LRUCache eviction with undefined keys', () => {
  it('evicts the oldest entry even when that key is undefined', () => {
    const cache = new LRUCache<string | undefined, number>({ maxSize: 2, ttlMs: 60_000 })
    cache.set(undefined, 1)
    cache.set('a', 2)
    cache.set('b', 3) // must evict undefined, not silently grow

    expect(cache.size).toBe(2)
    expect(cache.has(undefined)).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(true)
  })

  it('evicts the oldest entry when it is a legitimate string key', () => {
    const cache = new LRUCache<string, number>({ maxSize: 2, ttlMs: 60_000 })
    cache.set('first', 1)
    cache.set('second', 2)
    cache.set('third', 3)
    expect(cache.size).toBe(2)
    expect(cache.has('first')).toBe(false)
  })
})
```

If `LRUCache` doesn't currently expose `size`, add a `get size(): number { return this.cache.size }` accessor in `cache.ts`. Otherwise the test cannot make the invariant observable.

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/utils/__tests__/cache.test.ts`
Expected: `evicts the oldest entry even when that key is undefined` FAILS — cache.size is 3, not 2.

- [ ] **Step 4: Fix the eviction loop**

In `src/utils/cache.ts`, replace lines 89-97:

```typescript
    // Evict oldest entries if still at capacity. Use the iterator's `done`
    // flag — NOT a truthiness check on the key — because `undefined` is a
    // legal Map key and would otherwise cause us to break early and leave
    // the cache one entry over maxSize.
    while (this.cache.size >= this.maxSize) {
      const next = this.cache.keys().next()
      if (next.done) break
      this.cache.delete(next.value)
    }
```

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/utils/__tests__/cache.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Audit the new tests (sub-agent)**

Dispatch `test-quality-auditor` (or `general-purpose`) on `src/utils/__tests__/cache.test.ts`. Brief it: are the assertions tied to the actual bug (eviction count + which key survives), or do they just check `size`? Is the test name aligned with the assertion? Categorize Critical/High/Medium/Low. Address Critical + High.

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Exercise as a user — manual cache stress**

Create `/tmp/lru-smoke.mjs`:

```javascript
import { LRUCache } from './dist/utils/cache.js'
const c = new LRUCache({ maxSize: 3, ttlMs: 60_000 })
c.set(undefined, 'u')
for (let i = 0; i < 10; i++) c.set(`k${i}`, i)
console.log('size:', c.size, '(expected: 3)')
console.log('has undefined:', c.has(undefined), '(expected: false)')
```

Run: `bun run build && node /tmp/lru-smoke.mjs`
Expected: `size: 3`, `has undefined: false`. Delete the smoke file after.

- [ ] **Step 9: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer` on the diff. Brief it: review for correctness of the iterator handling, edge cases (cache full of undefined keys, single-entry cache, maxSize=0). Categorize findings; fix Critical/High.

- [ ] **Step 10: Commit**

```bash
git add src/utils/cache.ts src/utils/__tests__/cache.test.ts
git commit -m "$(cat <<'EOF'
fix(utils): LRU cache evicts entries with undefined keys correctly

The eviction loop in `LRUCache.set` used `oldestKey !== undefined` to
detect "no more keys to evict", but `undefined` is a valid Map key in
JavaScript. If the oldest entry had `undefined` as its key, the loop
broke early and the cache silently grew past `maxSize`.

Switch to the iterator's `done` flag, which is the documented sentinel
for "iterator exhausted".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: project-structure reads README/ARCHITECTURE through symlinks without realpath check

**Files:**
- Modify: `src/review/project-structure.ts:343-380` (`readReadmeSummary`), `src/review/project-structure.ts:389-402` (`readArchitectureContent`)
- Test: `src/review/__tests__/project-structure.test.ts` (extend existing)

**Audit finding closed:** Tier 1 final-review optional follow-up — README/ARCHITECTURE basename reads without realpath verification.

**Why this matters:** The file paths joined here are constant basenames (`README.md`, `ARCHITECTURE.md`, etc.), not user input — but if a committer replaces one of those files with a symlink to `.env` or `/etc/passwd`, the content gets inlined into the review prompt and ships to the LLM provider. This is the same class as the `read-file.ts` symlink bypass we closed in Tier 1, just on a narrower attack surface.

- [ ] **Step 1: Inspect current readers and tests**

Run: `grep -n "describe\|it(" src/review/__tests__/project-structure.test.ts | head -20`
Run: `sed -n '343,402p' src/review/project-structure.ts`

Confirm where the file paths come from (constants `README_FILES`, `ARCHITECTURE_FILES` joined onto `repoRoot`).

- [ ] **Step 2: Write the failing test**

Append to `src/review/__tests__/project-structure.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('project-structure symlink hardening', () => {
  it('does not follow README.md symlinks that resolve outside the repo', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ps-outer-'))
    const repo = await mkdtemp(join(tmpdir(), 'ps-repo-'))
    try {
      await writeFile(join(outer, 'secret.txt'), 'SECRET=hunter2')
      await symlink(join(outer, 'secret.txt'), join(repo, 'README.md'))

      const context = await analyzeProjectStructure(repo)
      expect(context.readmeSummary ?? '').not.toContain('hunter2')
    } finally {
      await rm(outer, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('does not follow ARCHITECTURE.md symlinks that resolve outside the repo', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ps-arch-outer-'))
    const repo = await mkdtemp(join(tmpdir(), 'ps-arch-repo-'))
    try {
      await writeFile(join(outer, 'secret.txt'), 'API_KEY=topsecret')
      await symlink(join(outer, 'secret.txt'), join(repo, 'ARCHITECTURE.md'))

      const context = await analyzeProjectStructure(repo)
      expect(context.architectureContent ?? '').not.toContain('topsecret')
    } finally {
      await rm(outer, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('still reads README.md when it is a regular file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ps-regular-'))
    try {
      await writeFile(join(repo, 'README.md'), '# Real readme\n\nContent here.')
      const context = await analyzeProjectStructure(repo)
      expect(context.readmeSummary).toContain('Real readme')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
```

The first two tests should FAIL before the fix; the third confirms we don't break the happy path.

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/review/__tests__/project-structure.test.ts`
Expected: two new tests FAIL (content leaks through), regular-file test PASSES.

- [ ] **Step 4: Add a realpath containment helper at top of project-structure.ts**

After the imports in `src/review/project-structure.ts`, add:

```typescript
import { realpath } from 'node:fs/promises'
import { relative, sep } from 'node:path'

/**
 * Resolve `filePath` through symlinks and confirm it still lives under
 * `repoRoot`. Returns the canonical path on success, or null if the file
 * doesn't exist or escapes the repo via a symlink.
 *
 * Mirrors the realpath containment check in `src/repo-audit/prompts.ts:64-98`
 * and `src/review/tools/read-file.ts`. Files read for LLM prompts are
 * untrusted: a malicious committer can replace `README.md` with a symlink to
 * `.env` and exfiltrate secrets to the model provider.
 */
async function realpathInsideRepo(filePath: string, repoRoot: string): Promise<string | null> {
  try {
    const [realFile, realRoot] = await Promise.all([
      realpath(filePath),
      realpath(repoRoot),
    ])
    const rel = relative(realRoot, realFile)
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || rel === '..') {
      return null
    }
    return realFile
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Gate both readers behind the realpath check**

In `readReadmeSummary` around line 349, before the `await fs.readFile(readmePath, 'utf-8')`, add:

```typescript
const safePath = await realpathInsideRepo(readmePath, repoRoot)
if (safePath === null) continue
const content = await fs.readFile(safePath, 'utf-8')
```

Apply the same pattern in `readArchitectureContent` around line 392.

- [ ] **Step 6: Run tests, verify green**

Run: `npx vitest run src/review/__tests__/project-structure.test.ts`
Expected: all three new tests PASS.

- [ ] **Step 7: Audit new tests (sub-agent)**

Dispatch `test-quality-auditor`. Brief it: do the tests prove the SUT actually consulted realpath (not just that the content was missing for some other reason)? Is the happy-path test broad enough to catch regressions? Categorize; fix Critical/High.

- [ ] **Step 8: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Exercise as a user**

Skipping — covered by the integration nature of the tests (they invoke `analyzeProjectStructure` end-to-end, the same call site used in review prompt construction).

- [ ] **Step 10: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer` on the diff. Brief it: check for TOCTOU gaps (file vs symlink swap between realpath and readFile — same class as the read-file.ts fix from Tier 1), correctness of the relative-path containment check, behavior on non-existent README.

- [ ] **Step 11: Commit**

```bash
git add src/review/project-structure.ts src/review/__tests__/project-structure.test.ts
git commit -m "$(cat <<'EOF'
sec(review): realpath-check README/ARCHITECTURE before inlining into prompt

`readReadmeSummary` and `readArchitectureContent` join `repoRoot` with a
constant basename then `fs.readFile`. If a committer replaces README.md
with a symlink to `.env` or `/etc/passwd`, the file content is inlined
into the project-structure prompt and shipped to the LLM provider.

Resolve through realpath and confirm the canonical target lives under
`repoRoot` before reading. Mirrors the symlink hardening done in
`src/repo-audit/prompts.ts` (Tier 1) and `src/review/tools/read-file.ts`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Doctor must not crash on corrupt config

**Files:**
- Modify: `src/cli/doctor.ts:48` (the unguarded `getConfig()` at top of `runDoctor`)
- Test: `src/cli/__tests__/doctor.test.ts` (extend existing)

**Audit finding closed:** "Doctor can crash before reporting corrupt config" (general MEDIUM).

**Why the bug exists:** `runDoctor` calls `getConfig()` at line 48 *outside* any try/catch. When the user's config JSON is corrupted (truncated file, schema-mismatched, etc.), `getConfig()` throws synchronously and `kode-review --doctor` dies with an unhandled exception — exactly when the user most needs doctor to tell them their config is the problem.

The per-check `checkConfig()` at line 141 already has structured error handling, but the top-level `getConfig()` call short-circuits before doctor even reaches it.

- [ ] **Step 1: Inspect runDoctor top + config loading**

Run: `sed -n '40,80p' src/cli/doctor.ts`
Run: `grep -n "export function getConfig\|throw" src/config/store.ts src/config/index.ts | head -20`

Confirm: `getConfig()` reads the conf-backed JSON; on parse failure it throws (Zod or JSON parse error).

- [ ] **Step 2: Write the failing test**

Append to `src/cli/__tests__/doctor.test.ts` (or create one if absent):

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('runDoctor — corrupt config recovery', () => {
  let originalConsoleLog: typeof console.log
  let captured: string[]

  beforeEach(() => {
    captured = []
    originalConsoleLog = console.log
    console.log = (...args) => captured.push(args.join(' '))
  })

  afterEach(() => {
    console.log = originalConsoleLog
    vi.restoreAllMocks()
  })

  it('reports a failed Configuration check instead of throwing when getConfig fails', async () => {
    vi.doMock('../../config/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../config/index.js')>('../../config/index.js')
      return {
        ...actual,
        getConfig: () => {
          throw new Error('Invalid config JSON at line 4: unexpected token')
        },
      }
    })

    const { runDoctor } = await import('../doctor.js')
    await expect(runDoctor({ json: false })).resolves.not.toThrow()

    const output = captured.join('\n')
    expect(output).toMatch(/Configuration/)
    expect(output).toMatch(/fail|error/i)
    expect(output).toMatch(/Invalid config JSON/)
  })
})
```

If `runDoctor` doesn't already accept an `options` arg or doesn't write to stdout via `console.log`, adapt the captures to whatever the existing tests use. The point of the test is: doctor runs to completion + the config row reports `fail` + the original error message reaches the user.

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/cli/__tests__/doctor.test.ts`
Expected: FAIL — `runDoctor` rejects with the underlying `getConfig` error.

- [ ] **Step 4: Wrap the top-level getConfig in try/catch**

In `src/cli/doctor.ts:48`, replace the unguarded `const config = getConfig()` with:

```typescript
  let config: ReturnType<typeof getConfig> | null = null
  let configLoadError: string | null = null
  try {
    config = getConfig()
  } catch (err) {
    configLoadError = err instanceof Error ? err.message : String(err)
  }
```

Adjust the downstream conditional check (line ~69) that reads `config.indexer.enabled`:

```typescript
  if (config && (config.indexer.enabled || await isDockerAvailable())) {
    // ...
  }

  if (config && config.indexer.enabled) {
    // ...
  }
```

Adjust `checkConfig` (called at line 51) to take the captured error and surface it:

```typescript
async function checkConfig(loadError: string | null): Promise<DiagnosticCheck> {
  if (loadError !== null) {
    return {
      name: 'Configuration',
      status: 'fail',
      message: 'Failed to load configuration',
      details: loadError,
    }
  }
  // ... existing happy-path body
}
```

And the `Promise.all` call site (around line 51):

```typescript
  const [configCheck, legacyCheck, ...] = await Promise.all([
    checkConfig(configLoadError),
    // ...
  ])
```

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/cli/__tests__/doctor.test.ts`
Expected: PASS — doctor completes, Configuration row reports fail with the parse error.

- [ ] **Step 6: Audit new tests (sub-agent)**

Dispatch `test-quality-auditor`. Brief it: does the test prove the FULL doctor flow ran (not just that the call didn't throw)? Are other checks (Node, git, etc.) still exercised when config is corrupt? Categorize; fix Critical/High.

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Exercise as a user**

Manually corrupt your config, then run doctor:

```bash
cp ~/.config/kode-review/config.json /tmp/config-backup.json
echo '{ invalid json' > ~/.config/kode-review/config.json
bun run build && node dist/index.js --doctor
# Restore:
mv /tmp/config-backup.json ~/.config/kode-review/config.json
```

Expected: full doctor output, Configuration row red/fail with the parse error, no exception trace.

- [ ] **Step 9: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer` on the diff. Brief it: check that downstream `config!` non-null assertions aren't introduced, that all `config.indexer.*` access paths are guarded, that the failure path doesn't swallow useful context.

- [ ] **Step 10: Commit**

```bash
git add src/cli/doctor.ts src/cli/__tests__/doctor.test.ts
git commit -m "$(cat <<'EOF'
fix(cli): doctor reports corrupt config instead of crashing

`runDoctor` called `getConfig()` outside any try/catch. A corrupted
config JSON would throw before doctor had a chance to render any rows,
so users got an unhandled exception trace instead of the diagnostic
that would tell them their config was the problem.

Catch the load error at the top and pass it through to `checkConfig`,
which now renders a structured fail row. All config-dependent
conditional checks are gated on a non-null config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: VCS inline-comment failures must surface to the caller

**Files:**
- Modify: `src/vcs/post-review.ts:102-138` (the inline-comment block)
- Type: `src/vcs/types.ts` (or wherever `PostReviewResult` lives — extend with `inlineCommentsFailed`)
- Test: `src/vcs/__tests__/post-review.test.ts` (create if absent)

**Audit finding closed:** "Inline comment failures are hidden from callers" (general MEDIUM).

**Why the bug exists:** Lines 117 and 129 log inline-comment failures at `logger.debug()` — invisible at default verbosity — and never write them to `result.errors`. The caller has no observable way to detect that some/all inline comments dropped. In CI, this means a "review posted" success message hides the fact that the issue-level annotations the reviewer relies on never made it to the PR.

- [ ] **Step 1: Inspect the result type and current swallowing**

Run: `grep -n "interface PostReviewResult\|type PostReviewResult\|inlineCommentsPosted" src/vcs/post-review.ts src/vcs/types.ts 2>/dev/null | head -10`
Run: `sed -n '40,60p' src/vcs/post-review.ts`

Confirm where `PostReviewResult` is defined and what fields it exposes.

- [ ] **Step 2: Extend the result type**

In the `PostReviewResult` interface (wherever it lives), add:

```typescript
export interface PostReviewResult {
  // existing fields...
  inlineCommentsPosted: number
  inlineCommentsFailed: number     // new
  inlineCommentsAttempted: number  // new
  success: boolean
  errors: string[]
}
```

And in `postReview` initialization (around line 60), add:

```typescript
  const result: PostReviewResult = {
    // existing fields...
    inlineCommentsPosted: 0,
    inlineCommentsFailed: 0,
    inlineCommentsAttempted: 0,
    errors: [],
    // ...
  }
```

- [ ] **Step 3: Write the failing test**

Create `src/vcs/__tests__/post-review.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../github.js', () => ({
  postGitHubPRComment: vi.fn(),
  postGitHubPRLineComment: vi.fn(),
  getGitHubPRContext: vi.fn(),
  submitGitHubPRReview: vi.fn(),
}))

import { postGitHubPRComment, postGitHubPRLineComment, getGitHubPRContext } from '../github.js'
import { postReview } from '../post-review.js'

describe('postReview — inline comment failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records inline comment failures in result.inlineCommentsFailed and result.errors', async () => {
    vi.mocked(postGitHubPRComment).mockResolvedValue({ success: true })
    vi.mocked(getGitHubPRContext).mockResolvedValue({ success: true, context: { /* ... */ } as any })
    vi.mocked(postGitHubPRLineComment)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'API rate limit' })
      .mockResolvedValueOnce({ success: false, error: 'Not found' })

    const result = await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [
          { severity: 'LOW', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any,
          { severity: 'LOW', title: 'b', description: '', confidence: 'HIGH', file: 'b.ts', line: 2 } as any,
          { severity: 'LOW', title: 'c', description: '', confidence: 'HIGH', file: 'c.ts', line: 3 } as any,
        ],
      } as any,
      { platform: 'github', prNumber: 123 },
    )

    expect(result.inlineCommentsAttempted).toBe(3)
    expect(result.inlineCommentsPosted).toBe(1)
    expect(result.inlineCommentsFailed).toBe(2)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/API rate limit/),
        expect.stringMatching(/Not found/),
      ]),
    )
  })

  it('records a single context-fetch failure that prevents all inline comments', async () => {
    vi.mocked(postGitHubPRComment).mockResolvedValue({ success: true })
    vi.mocked(getGitHubPRContext).mockResolvedValue({ success: false, error: 'PR not found' })

    const result = await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [{ severity: 'LOW', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any],
      } as any,
      { platform: 'github', prNumber: 123 },
    )

    expect(result.inlineCommentsAttempted).toBe(1)
    expect(result.inlineCommentsPosted).toBe(0)
    expect(result.inlineCommentsFailed).toBe(1)
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/PR not found/)]))
  })
})
```

- [ ] **Step 4: Run the failing tests**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts`
Expected: both tests FAIL — fields don't exist yet.

- [ ] **Step 5: Wire failures into the result**

In `src/vcs/post-review.ts`, replace the inline-comment block (lines ~102-138):

```typescript
  if (postInlineComments) {
    const issuesWithLocation = review.issues
      .filter(issue => issue.file && issue.line)
      .slice(0, maxInlineComments)

    result.inlineCommentsAttempted = issuesWithLocation.length

    if (issuesWithLocation.length > 0) {
      logger.info(`Posting ${issuesWithLocation.length} inline comment(s)...`)

      const ctxResult = platform === 'github'
        ? await getGitHubPRContext(identifier)
        : await getGitLabMRContext(identifier)

      if (!ctxResult.success) {
        // Context fetch failed → every inline comment is a failure.
        result.inlineCommentsFailed = issuesWithLocation.length
        const msg = `Failed to fetch PR/MR context for inline comments: ${ctxResult.error}`
        result.errors.push(msg)
        logger.warn(msg)
      } else {
        const ctx = ctxResult.context
        for (const issue of issuesWithLocation) {
          const inlineBody = formatInlineComment(issue)
          const inlineResult = platform === 'github'
            ? await postGitHubPRLineComment(identifier, inlineBody, issue.file!, issue.line!, 'RIGHT', ctx as GitHubPRContext)
            : await postGitLabMRLineComment(identifier, inlineBody, issue.file!, issue.line!, ctx as GitLabMRContext)

          if (inlineResult.success) {
            result.inlineCommentsPosted++
          } else {
            result.inlineCommentsFailed++
            const msg = `Inline comment failed (${issue.file}:${issue.line}): ${inlineResult.error}`
            result.errors.push(msg)
            logger.warn(msg)
          }
        }
      }

      if (result.inlineCommentsPosted > 0) {
        logger.success(`Posted ${result.inlineCommentsPosted}/${result.inlineCommentsAttempted} inline comment(s)`)
      }
      if (result.inlineCommentsFailed > 0) {
        logger.warn(`${result.inlineCommentsFailed} inline comment(s) failed`)
      }
    }
  }
```

Keep the existing `result.success = result.commentPosted` invariant — overall success still depends on the main comment landing. Inline failures are now observable but don't flip overall success (that's a follow-up decision, out of scope).

- [ ] **Step 6: Run tests, verify green**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts`
Expected: both tests PASS.

- [ ] **Step 7: Audit new tests (sub-agent)**

Dispatch `test-quality-auditor`. Brief it: do the tests pin the *contract* (count fields agree with errors[] population) or just internal counters? Is the SUT being mocked correctly (no test-doubles for the function under test)?

- [ ] **Step 8: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer` on the diff. Brief it: are there callers of `postReview` that destructure `result` and would silently miss the new fields? Should `result.success` change semantics?

- [ ] **Step 10: Commit**

```bash
git add src/vcs/post-review.ts src/vcs/types.ts src/vcs/__tests__/post-review.test.ts
git commit -m "$(cat <<'EOF'
fix(vcs): surface inline-comment failures in postReview result

Inline-comment failures were logged at debug level and dropped on the
floor. Callers had no way to detect that 0/N inline annotations
actually landed on the PR — a "review posted" success message could
hide a complete inline-comment outage.

Add `inlineCommentsAttempted` and `inlineCommentsFailed` counters,
push every failure into `result.errors[]`, and log failures at warn
level. Context-fetch failure now counts as N failures (the user wanted
N inline comments and got zero) instead of being silently logged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: GitLab REQUEST_CHANGES must revoke any prior bot approval

**Files:**
- Modify: `src/vcs/post-review.ts:188-221` (`setApprovalStatusForReview`)
- May need: `src/vcs/gitlab.ts` — add `unapproveGitLabMR` if it doesn't exist
- Test: extend `src/vcs/__tests__/post-review.test.ts`

**Audit finding closed:** "GitLab REQUEST_CHANGES leaves prior bot approval intact" + "GitLab request-changes leaves stale approvals" (both MEDIUM — different personas, same bug).

**Why the bug exists:** GitLab's UI doesn't have a `REQUEST_CHANGES` button, so the existing code at lines 212-215 just returns success without doing anything when the verdict is REQUEST_CHANGES. But if an *earlier* review by the same bot called `setGitLabMRApproval(identifier, true)` (lines 210-211), that approval is still live. A subsequent regression that the bot flags as REQUEST_CHANGES leaves the prior approval in place, and a maintainer reading "approved" trusts the bot.

The fix: when REQUEST_CHANGES on GitLab, explicitly unapprove via the GitLab `DELETE /projects/:id/merge_requests/:iid/approve` endpoint (or `glab mr unapprove`).

- [ ] **Step 1: Find existing GitLab approval surface**

Run: `grep -n "setGitLabMRApproval\|unapprove\|approve" src/vcs/gitlab.ts | head -20`

If `setGitLabMRApproval` exists but `unapproveGitLabMR` does not, we add the latter. If `setGitLabMRApproval` takes a boolean for approve/unapprove already, we wire through that instead.

- [ ] **Step 2: Write the failing test**

Append to `src/vcs/__tests__/post-review.test.ts`:

```typescript
vi.mock('../gitlab.js', () => ({
  postGitLabMRComment: vi.fn(),
  postGitLabMRLineComment: vi.fn(),
  getGitLabMRContext: vi.fn(),
  setGitLabMRApproval: vi.fn(),
  unapproveGitLabMR: vi.fn(),
}))

import { setGitLabMRApproval, unapproveGitLabMR, postGitLabMRComment } from '../gitlab.js'

describe('postReview — GitLab REQUEST_CHANGES revokes prior approval', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls unapproveGitLabMR when verdict is REQUEST_CHANGES on GitLab', async () => {
    vi.mocked(postGitLabMRComment).mockResolvedValue({ success: true })
    vi.mocked(unapproveGitLabMR).mockResolvedValue({ success: true })

    const result = await postReview(
      {
        verdict: { recommendation: 'REQUEST_CHANGES', reasoning: '', confidence: 'HIGH' },
        issues: [],
      } as any,
      { platform: 'gitlab', mrIid: 42 },
    )

    expect(unapproveGitLabMR).toHaveBeenCalledWith(42)
    expect(setGitLabMRApproval).not.toHaveBeenCalled()
    expect(result.approvalStatusSet).toBe(true)
  })

  it('calls setGitLabMRApproval(true) when verdict is APPROVE on GitLab', async () => {
    vi.mocked(postGitLabMRComment).mockResolvedValue({ success: true })
    vi.mocked(setGitLabMRApproval).mockResolvedValue({ success: true })

    await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [],
      } as any,
      { platform: 'gitlab', mrIid: 42 },
    )

    expect(setGitLabMRApproval).toHaveBeenCalledWith(42, true)
    expect(unapproveGitLabMR).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts -t "REQUEST_CHANGES"`
Expected: FAIL — `unapproveGitLabMR` is never called.

- [ ] **Step 4: Add unapproveGitLabMR to gitlab.ts**

In `src/vcs/gitlab.ts`, add (if not present):

```typescript
/**
 * Revoke an existing bot approval on a GitLab MR. Idempotent — succeeds
 * even if there was no prior approval. Used when the review verdict
 * transitions from APPROVE to REQUEST_CHANGES.
 */
export async function unapproveGitLabMR(
  mrIid: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await execa('glab', ['mr', 'unapprove', String(mrIid)])
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // glab returns non-zero when the MR wasn't approved — treat as success.
    if (/not approved|no approval/i.test(message)) {
      return { success: true }
    }
    return { success: false, error: message }
  }
}
```

- [ ] **Step 5: Wire it into setApprovalStatusForReview**

In `src/vcs/post-review.ts`, replace the GitLab branch (lines 208-220):

```typescript
  } else {
    if (verdict === 'APPROVE') {
      return setGitLabMRApproval(identifier, true)
    } else if (verdict === 'REQUEST_CHANGES') {
      // GitLab has no "request changes" button. Revoke any prior bot
      // approval so the MR doesn't sit in "approved" state while the
      // review comment says otherwise.
      return unapproveGitLabMR(identifier)
    } else {
      // NEEDS_DISCUSSION → no approval action needed.
      return { success: true }
    }
  }
```

Don't forget the import at the top of post-review.ts:

```typescript
import {
  postGitLabMRComment,
  postGitLabMRLineComment,
  getGitLabMRContext,
  setGitLabMRApproval,
  unapproveGitLabMR,    // new
} from './gitlab.js'
```

- [ ] **Step 6: Run tests, verify green**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts`
Expected: PASS.

- [ ] **Step 7: Audit new tests (sub-agent)**

Dispatch `test-quality-auditor`. Brief it: are the mocks for the right functions (no self-mocking)? Does the test catch the "approve was called instead of unapprove" inversion?

- [ ] **Step 8: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Exercise as a user — pi MR fixture**

Skip unless a GitLab sandbox is available; the unit test pins behavior. If a sandbox is available, run `kode-review --mr <iid> --ci` against an MR you previously approved with this bot, and verify the approval is revoked.

- [ ] **Step 10: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer`. Brief it: check that `unapproveGitLabMR` handles the "not approved" idempotent case correctly, that errors propagate to `result.errors`, that we're not introducing inconsistent state if the unapprove call fails.

- [ ] **Step 11: Commit**

```bash
git add src/vcs/post-review.ts src/vcs/gitlab.ts src/vcs/__tests__/post-review.test.ts
git commit -m "$(cat <<'EOF'
fix(vcs): GitLab REQUEST_CHANGES revokes prior bot approval

GitLab has no native "request changes" verb, so the previous code did
nothing on REQUEST_CHANGES — leaving any prior APPROVE from this bot
live. A maintainer reading the MR after a regression would see "approved"
even though the bot's latest verdict was REQUEST_CHANGES.

Add `unapproveGitLabMR` (glab mr unapprove) and call it on
REQUEST_CHANGES. Idempotent — succeeds if there was no prior approval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: VCS approval must respect severity counts, not just the model verdict

**Files:**
- Modify: `src/vcs/post-review.ts:140-159` (the `setApprovalStatus` block in `postReview`)
- Test: extend `src/vcs/__tests__/post-review.test.ts`

**Audit finding closed:** "Model-derived verdict can auto-approve PRs/MRs" (security MEDIUM).

**Why the bug exists:** `setApprovalStatusForReview` trusts `review.verdict.recommendation === 'APPROVE'` and submits a real GitHub APPROVE (line 207) or a GitLab approval (line 211). But the model can emit `APPROVE` even when the issues list contains CRITICAL/HIGH findings — that's exactly the case Tier 1 closed for the CI exit-code path (`src/review/ci-mode.ts`). The same trust gap exists on the publication side here.

The right fix: before submitting an APPROVE, count severities from `review.issues`. If there's any CRITICAL or HIGH, downgrade APPROVE → COMMENT (GitHub) / no-approval (GitLab). The model's verdict becomes advisory, the issue counts are ground truth.

- [ ] **Step 1: Find the existing severity-gate helper**

Run: `grep -n "resolveCiExitCode\|FAIL_ON\|failOn\|critical.*count\|countSeverities" src/review/ci-mode.ts src/output/*.ts | head -15`

The Tier 1 fix lives in `src/review/ci-mode.ts:50-70` (`resolveCiExitCode`). We don't want to call that directly (different concern), but the *pattern* (count critical/high before trusting verdict) is what we mirror.

- [ ] **Step 2: Write the failing tests**

Append to `src/vcs/__tests__/post-review.test.ts`:

```typescript
import { submitGitHubPRReview, postGitHubPRComment } from '../github.js'

describe('postReview — severity gate on auto-approve', () => {
  beforeEach(() => vi.clearAllMocks())

  it('downgrades GitHub APPROVE to COMMENT when there is a CRITICAL issue', async () => {
    vi.mocked(postGitHubPRComment).mockResolvedValue({ success: true })
    vi.mocked(submitGitHubPRReview).mockResolvedValue({ success: true })

    const result = await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [{ severity: 'CRITICAL', title: 'sql injection', description: '', confidence: 'HIGH' } as any],
      } as any,
      { platform: 'github', prNumber: 7 },
    )

    expect(submitGitHubPRReview).not.toHaveBeenCalledWith(7, '', 'APPROVE')
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/downgraded.*APPROVE.*critical/i),
    ]))
  })

  it('downgrades GitHub APPROVE to COMMENT when there is a HIGH issue', async () => {
    vi.mocked(postGitHubPRComment).mockResolvedValue({ success: true })
    vi.mocked(submitGitHubPRReview).mockResolvedValue({ success: true })

    await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [{ severity: 'HIGH', title: 'auth bypass', description: '', confidence: 'HIGH' } as any],
      } as any,
      { platform: 'github', prNumber: 7 },
    )

    expect(submitGitHubPRReview).not.toHaveBeenCalledWith(7, '', 'APPROVE')
  })

  it('lets GitHub APPROVE through when issues are MEDIUM/LOW only', async () => {
    vi.mocked(postGitHubPRComment).mockResolvedValue({ success: true })
    vi.mocked(submitGitHubPRReview).mockResolvedValue({ success: true })

    await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [{ severity: 'MEDIUM', title: 'naming', description: '', confidence: 'HIGH' } as any],
      } as any,
      { platform: 'github', prNumber: 7 },
    )

    expect(submitGitHubPRReview).toHaveBeenCalledWith(7, '', 'APPROVE')
  })

  it('downgrades GitLab APPROVE to no-op when there is a CRITICAL issue', async () => {
    vi.mocked(postGitLabMRComment).mockResolvedValue({ success: true })

    await postReview(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH' },
        issues: [{ severity: 'CRITICAL', title: 'rce', description: '', confidence: 'HIGH' } as any],
      } as any,
      { platform: 'gitlab', mrIid: 7 },
    )

    expect(setGitLabMRApproval).not.toHaveBeenCalledWith(7, true)
  })
})
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts -t "severity gate"`
Expected: 4 tests FAIL — the SUT trusts the verdict.

- [ ] **Step 4: Add a severity-gate helper at top of post-review.ts**

In `src/vcs/post-review.ts`, near the other helpers (around line 160-185), add:

```typescript
/**
 * The `setApprovalStatusForReview` call publishes a verdict to GitHub/GitLab.
 * Mirror the same severity-count ground truth that `resolveCiExitCode`
 * applies to the CI exit code: if there is any CRITICAL or HIGH issue in
 * the review, an APPROVE verdict from the model is downgraded to COMMENT
 * (GitHub) or no-approval (GitLab). The model's recommendation is advisory;
 * the count axis is the ground truth.
 */
function effectiveVerdictForApproval(
  review: { verdict: { recommendation: Verdict }; issues: { severity: string }[] },
): { verdict: Verdict; downgraded: boolean; reason?: string } {
  const declared = review.verdict.recommendation
  if (declared !== 'APPROVE') return { verdict: declared, downgraded: false }

  const critical = review.issues.filter(i => i.severity === 'CRITICAL').length
  const high = review.issues.filter(i => i.severity === 'HIGH').length
  if (critical > 0 || high > 0) {
    return {
      verdict: 'NEEDS_DISCUSSION',  // becomes COMMENT on GitHub / no-op on GitLab
      downgraded: true,
      reason: `APPROVE downgraded: ${critical} critical, ${high} high issue(s) present`,
    }
  }
  return { verdict: declared, downgraded: false }
}
```

- [ ] **Step 5: Wire it into the `setApprovalStatus` block**

In `postReview`, replace lines 140-154:

```typescript
  if (setApprovalStatus) {
    const effective = effectiveVerdictForApproval(review)
    if (effective.downgraded) {
      result.errors.push(effective.reason!)
      logger.warn(effective.reason!)
    }
    const approvalResult = await setApprovalStatusForReview(
      identifier,
      platform,
      effective.verdict,
    )

    if (approvalResult.success) {
      result.approvalStatusSet = true
      logger.success(`Review status set: ${effective.verdict}`)
    } else if (approvalResult.error) {
      result.errors.push(`Failed to set approval status: ${approvalResult.error}`)
    }
  }
```

- [ ] **Step 6: Run tests, verify green**

Run: `npx vitest run src/vcs/__tests__/post-review.test.ts`
Expected: all severity-gate tests PASS. Existing tests still PASS.

- [ ] **Step 7: Audit new tests (sub-agent)**

Dispatch `test-quality-auditor`. Brief it: do tests cover BOTH platforms (GitHub + GitLab)? Do they cover the boundary (no high, no critical)? Are severities case-sensitive (the test uses `CRITICAL` but the schema might accept lowercase — pin that)?

- [ ] **Step 8: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Exercise as a user**

Construct a synthetic review and invoke the post path:

```typescript
// /tmp/post-smoke.mjs (manual test)
import { postReview } from './dist/vcs/post-review.js'
const result = await postReview({
  verdict: { recommendation: 'APPROVE', reasoning: 'looks ok', confidence: 'HIGH' },
  issues: [{ severity: 'CRITICAL', title: 'sql', description: 'x', confidence: 'HIGH' }],
  summary: '', positives: [],
}, { platform: 'github', prNumber: 1, postInlineComments: false })
console.log(JSON.stringify(result, null, 2))
```

(Skip if no GitHub sandbox; unit tests pin the contract.)

- [ ] **Step 10: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer`. Brief it: should the helper live in `src/review/ci-mode.ts` instead (single source of truth)? Should `result.success` change when downgrade happens? Does the downgrade message reach the PR comment body, or only the local CLI? (Decide and document.)

- [ ] **Step 11: Commit**

```bash
git add src/vcs/post-review.ts src/vcs/__tests__/post-review.test.ts
git commit -m "$(cat <<'EOF'
sec(vcs): downgrade APPROVE verdict when CRITICAL/HIGH issues are present

`setApprovalStatusForReview` trusted the model's verdict literally —
an APPROVE recommendation submitted a real GitHub APPROVE or GitLab
approval even when the issues list contained CRITICAL findings.

Mirror the severity-count ground-truth pattern used by `resolveCiExitCode`
(Tier 1): if any CRITICAL or HIGH issue is present, downgrade APPROVE to
NEEDS_DISCUSSION (becomes COMMENT on GitHub / no-op on GitLab) before
publishing. The reason is surfaced in `result.errors` and logged at warn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Final wrap-up

- [ ] **Step W1: Sanity-check the full test suite**

Run: `bun run test`
Expected: 1225+ pass / 1 skipped / 0 failed (6 new tests added across cache, project-structure, doctor, post-review).

- [ ] **Step W2: Final lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean (pre-existing `src/output/parser.ts:271 no-useless-escape` lint warning is acceptable — out of scope).

- [ ] **Step W3: Run `--scope repo` with `--revalidate` to clear stale findings (optional)**

Run: `kode-review --scope repo --revalidate`
The 6 closed findings, plus the 2 stale ones I dropped from scope (feature lock + --report-only), should transition `open` → `fixed` after this pass.

- [ ] **Step W4: Final report block**

Produce the CLAUDE.md Step 10 report block:

```
Step 5 (test audit):     PASS — per-task audit transcripts above
Step 7 (user exercise):  PASS — cache/doctor exercised; VCS unit-pinned, sandbox waived
Step 8 (code review):    PASS — per-task feature-dev:code-reviewer transcripts above
Step 9 (verify):         bun run typecheck (clean), bun run test (1225 pass / 1 skipped)
```

---

## What's next after this plan

Two coherent shipping units remain in the deferred backlog:

**Plan 2 — Prompt-injection sanitization pass** (~5 tasks, all TS):
- `src/review/xml-sanitize.ts` — XML tag attribute variants and whitespace breakouts
- `src/reviewers/prompts.ts` — structural-tag sanitizer misses attributes
- `src/review/revalidate-prompt.ts` — untrusted findings mixed with instructions
- `src/watch/types.ts` — PR titles can inject terminal control sequences
- `src/repo-audit/engines/kode-agent.ts` + `src/repo-audit/prompts.ts` — repo metadata + raw file content steers prompts
- `src/index.ts` — untrusted PR content reaches tool-enabled LLM agent
- `src/indexer/xml-context.ts` — untrusted code context can steer LLM behavior

Right approach: one rewritten sanitizer with explicit allowlist + caller migration. Not a stack of patches.

**Plan 3 — Indexer schema integrity** (~10 tasks, Python + SQL):
- `schema.sql` — `files` PK + `chunks` FK rekey to `(file_path, repo_id, branch)`
- `schema.sql` — `file_imports` composite-key isolation across repos
- `indexer.py` + `incremental.py` — full re-index purges stale rows before insert
- `main.py` — `DELETE /index/{repo_url}` cascades across all tables (not just legacy)
- `main.py` — usage lookup disambiguates by chunk-qualified symbol
- Requires standing up a pg+pgvector test harness (does not exist today)

**Plan 4 — Python test no-assertion cleanup** (~18 tasks, Python):
- `test_ast_chunker.py` and `test_call_graph.py` — every CRITICAL no-assertion test needs hand-written assertions tied to the chunker/graph contract. Mechanical but slow.
- Best parallelized with Plan 3 (same module) but separable.

I'll write the next plan when this one ships and you tell me which.
