# Tier 1 Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six highest-impact audit findings that ship code on every run: two security bypasses in our LLM file-read paths, two silent-CLI-behavior bugs, one watch-mode data-loss bug, and one CI gate that trusts model output before checking severity counts.

**Architecture:** Each task is a surgical fix to an existing file. TDD per CLAUDE.md: failing test → implementation → green. Each task is a self-contained commit. Per-task gates: test audit sub-agent before running tests, code review sub-agent before declaring done.

**Tech Stack:** TypeScript, Node 18+, vitest, Bun (package manager), `bun run test` invokes vitest with per-file isolation. **Do not use `bun test`** — it shares module caches and breaks `vi.mock()` between files.

**Scope explicitly out:**
- Tier 2 (indexer FastAPI auth, schema rekey, DELETE-leaves-stale-data, etc.) — separate plan.
- Tier 3 (Python test no-assertion fixes, tautological TS tests, missing route/tool coverage) — separate plan.
- The two false-positive findings: `PKG_VERSION` (already defined in `tsup.config.ts:9`) and `--scope repo --watch` test/runtime mismatch (parse-time rejection at `args.ts:304` matches the test at `args.repo-scope.test.ts:84-89`).

---

### Task 1: Re-check sensitive paths after symlink resolution + extend denylist for real key formats

**Why this is first:** `read_file` is invoked on every agentic review. The bug: a symlink named `notes.md → .env` passes `isSensitivePath()` (which sees `notes.md`), then `realpath()` resolves to `.env` inside the repo, the cross-root check at `read-file.ts:163` confirms it's still inside the repo, and the file is read and returned to the LLM provider. The denylist also matches `.pem` exact-only — real key formats like `prod.pem`, `id_rsa`, `*.key`, `service-account.json` are not caught at all.

**Files:**
- Modify: `src/review/tools/read-file.ts:16-93` (denylist), `src/review/tools/read-file.ts:147-175` (ordering)
- Test: `src/review/__tests__/tools.test.ts` (existing tool test file)

**Audit findings closed:** "Symlink bypass can expose sensitive repo-local files" (HIGH), "Symlinks bypass sensitive-path filtering" (HIGH), "Sensitive-file denylist misses private-key extensions" (HIGH).

- [ ] **Step 1: Inspect the existing test fixture for tools.test.ts**

Run: `grep -n "describe\|tmpdir\|symlink" src/review/__tests__/tools.test.ts | head -20`

We need the existing setup to write tmp files + symlinks. If it uses `os.tmpdir()` plus per-test cleanup, we add new tests alongside.

- [ ] **Step 2: Write failing test — symlink to in-repo .env is blocked**

Add to `src/review/__tests__/tools.test.ts`, inside the existing `readFileHandler` describe block:

```typescript
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('blocks symlinks that resolve to in-repo sensitive files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-symlink-'))
  try {
    await writeFile(join(dir, '.env'), 'SECRET=hunter2')
    await symlink('.env', join(dir, 'notes.md'))
    await expect(
      readFileHandler({ path: 'notes.md' }, dir),
    ).rejects.toThrow(/sensitive|access denied/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('blocks reading a .pem file at the repo root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-pem-'))
  try {
    await writeFile(join(dir, 'prod.pem'), '-----BEGIN PRIVATE KEY-----')
    await expect(
      readFileHandler({ path: 'prod.pem' }, dir),
    ).rejects.toThrow(/sensitive|access denied/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('blocks common SSH private key filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-ssh-'))
  try {
    await writeFile(join(dir, 'id_rsa'), 'fake-key')
    await expect(
      readFileHandler({ path: 'id_rsa' }, dir),
    ).rejects.toThrow(/sensitive|access denied/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('blocks service-account JSON keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-sa-'))
  try {
    await writeFile(join(dir, 'service-account.json'), '{"private_key":"..."}')
    await expect(
      readFileHandler({ path: 'service-account.json' }, dir),
    ).rejects.toThrow(/sensitive|access denied/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('still allows .env.example through the safe-pattern allowlist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kr-safe-'))
  try {
    await writeFile(join(dir, '.env.example'), 'EXAMPLE=value')
    const out = await readFileHandler({ path: '.env.example' }, dir)
    expect(out.content).toContain('EXAMPLE=value')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/review/__tests__/tools.test.ts`
Expected: 5 new tests fail (symlink test passes through to read; `.pem`/`id_rsa`/`service-account.json` not blocked).

- [ ] **Step 4: Extend `SENSITIVE_PATTERNS` and add a regex-based suffix/exact check**

In `src/review/tools/read-file.ts`, replace the denylist constants and `isSensitivePath` with extension- and filename-aware matching. Insert immediately after the existing `SAFE_PATTERNS` constant:

```typescript
/**
 * Filename extensions that almost always indicate private key material.
 * Matched against the basename (the final path component).
 */
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.crt', '.cer']

/**
 * Filename prefixes for common SSH private keys (without extension).
 * Matched against the basename. `.pub` files are allowed because they hold
 * public keys, not private material.
 */
const SSH_PRIVATE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']

/**
 * Filename patterns for service-account / credential JSON files.
 */
const SERVICE_ACCOUNT_PATTERN = /(^|[-_.])service[-_]?account.*\.json$/i
const GCP_CREDENTIAL_PATTERN = /(^|[-_.])credentials?\.json$/i
```

Then replace the existing `isSensitivePath` function with:

```typescript
function isSensitivePath(relativePath: string): boolean {
  const normalizedPath = relativePath.split(sep).join('/')
  const pathParts = normalizedPath.split('/')
  const basename = pathParts[pathParts.length - 1] ?? ''
  const lowerBasename = basename.toLowerCase()

  // Component-wise checks (covers .git/, .env, .env.production, .ssh/, .aws/…)
  for (const part of pathParts) {
    if (SAFE_PATTERNS.includes(part)) continue

    for (const pattern of SENSITIVE_PATTERNS) {
      if (part === pattern) return true
      if (pattern === '.env' && part.startsWith('.env.') && !SAFE_PATTERNS.includes(part)) {
        return true
      }
    }

    if (SPRING_PROFILE_PATTERN.test(part)) return true
  }

  // Basename suffix check (.pem, .key, .p12, .pfx, .crt, .cer) — but exempt .pub.
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (lowerBasename.endsWith(ext) && !lowerBasename.endsWith('.pub')) {
      return true
    }
  }

  // SSH private-key basenames (id_rsa, id_ed25519, …) — exempt the .pub partners.
  for (const name of SSH_PRIVATE_KEY_BASENAMES) {
    if (lowerBasename === name) return true
  }

  // Service-account / credentials JSON.
  if (SERVICE_ACCOUNT_PATTERN.test(lowerBasename)) return true
  if (GCP_CREDENTIAL_PATTERN.test(lowerBasename)) return true

  return false
}
```

- [ ] **Step 5: Re-run the basename-only tests, verify they pass**

Run: `npx vitest run src/review/__tests__/tools.test.ts -t "prod.pem|id_rsa|service-account|env.example"`
Expected: 4 of the 5 new tests pass. The symlink one still fails — that's the next fix.

- [ ] **Step 6: Reorder the symlink check and re-run sensitive-path check on the canonical path**

In `src/review/tools/read-file.ts`, replace the block from line 146 (`// Security check: block access to sensitive files/directories`) through line 175 with:

```typescript
  // Security check: block access to sensitive files/directories.
  // We run this BEFORE realpath (catches direct access) AND AFTER (catches
  // symlinks pointing at sensitive files).
  if (isSensitivePath(relativePath)) {
    throw new Error(`Access denied: "${input.path}" matches a sensitive file pattern (.git, .env, etc.)`)
  }

  // Check if file is gitignored (prevents reading build artifacts, node_modules, etc.)
  if (gitignore && gitignore.ignores(relativePath)) {
    throw new Error(`Access denied: "${input.path}" is in .gitignore (build artifacts, dependencies, etc. are not readable)`)
  }

  // Resolve symlinks. If a symlink resolves outside the repo OR resolves to
  // an in-repo sensitive file, refuse. We then read the canonical path so
  // a future TOCTOU swap can't redirect us.
  let canonicalReadPath = filePath
  try {
    const realFilePath = await realpath(filePath)
    const realRepoRoot = await realpath(normalizedRepoRoot)
    const realRelativePath = relative(realRepoRoot, realFilePath)

    if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
      throw new Error(`Path traversal detected: ${input.path} resolves to symlink outside repository root`)
    }

    if (isSensitivePath(realRelativePath)) {
      throw new Error(`Access denied: "${input.path}" is a symlink to a sensitive file (.git, .env, etc.)`)
    }

    if (gitignore && gitignore.ignores(realRelativePath)) {
      throw new Error(`Access denied: "${input.path}" is a symlink to a gitignored path`)
    }

    canonicalReadPath = realFilePath
  } catch (error) {
    // If realpath fails because the file doesn't exist, fall through to let
    // readFile produce the standard ENOENT. Any other error (EACCES, ELOOP,
    // and the security errors we throw above) propagates.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }

  // Read the canonical (post-realpath) path. If we read `filePath` instead,
  // a TOCTOU swap between realpath() and readFile() could redirect us to a
  // different target.
  const content = await readFile(canonicalReadPath, 'utf-8')
```

You will also need to remove the existing `const content = await readFile(filePath, 'utf-8')` line that used to sit at line 175. The replacement block above already includes the read.

- [ ] **Step 7: Run all read-file tests**

Run: `npx vitest run src/review/__tests__/tools.test.ts`
Expected: all tests in the file pass, including the 5 new ones.

- [ ] **Step 8: Audit the new tests (sub-agent)**

Dispatch `test-quality-auditor` (or `general-purpose` briefed to audit). Brief:

> Audit the 5 new tests in `src/review/__tests__/tools.test.ts` added for symlink+denylist coverage. Check for: tests that would pass even if the code were broken, mocking the SUT, tests that only check error message text instead of behavior, missing edge cases (e.g., does the symlink test actually verify the read was blocked vs. a different error?). Categorize findings Critical / High / Medium / Low. Address every Critical and High.

- [ ] **Step 9: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: both green.

- [ ] **Step 10: Exercise as a user**

Run, from this repo root:

```bash
bun run build
cd /tmp && rm -rf kr-manual && mkdir kr-manual && cd kr-manual && git init -q
echo 'SECRET=hunter2' > .env
ln -s .env notes.md
echo 'normal' > ok.txt
node -e "
import('${PWD}/../../Users/ebernie/dev/kode-review-cli/dist/review/tools/read-file.js').then(async (m) => {
  for (const path of ['notes.md', '.env', 'id_rsa', 'ok.txt']) {
    try {
      const out = await m.readFileHandler({ path }, process.cwd())
      console.log(path, '=> READ', out.content.slice(0,60))
    } catch (e) { console.log(path, '=> BLOCKED', e.message) }
  }
})
"
```

(Adjust the import path to the project's actual `dist/` layout — `dist/index.js` may re-export differently. If `read-file.js` isn't directly importable from `dist`, write a tiny in-repo scratch script `scripts/exercise-read-file.ts` that imports from `src/review/tools/read-file.ts` and run it with `bun run scripts/exercise-read-file.ts`.)

Expected: `notes.md` → BLOCKED with "symlink to a sensitive file", `.env` → BLOCKED, `id_rsa` → BLOCKED (but it doesn't exist, so ENOENT — that's fine, the policy fired first if it existed; create it: `echo fake > id_rsa` and retry), `ok.txt` → READ.

- [ ] **Step 11: Code review (sub-agent)**

Dispatch `feature-dev:code-reviewer` (or `general-purpose` briefed to review). Brief:

> Review the diff for `src/review/tools/read-file.ts` and the new tests in `src/review/__tests__/tools.test.ts`. Focus on: bypasses I missed (Unicode normalization, backslash on Windows, `..` after realpath, race conditions between realpath and readFile), the .pub allowlist for SENSITIVE_EXTENSIONS, whether the regex patterns are tight enough, and whether removing the existing trailing read at line 175 has any caller that depended on `filePath` vs canonicalReadPath. Categorize findings Critical / High / Medium / Low. Fix Critical + High or get explicit user approval to defer.

- [ ] **Step 12: Commit**

```bash
git add src/review/tools/read-file.ts src/review/__tests__/tools.test.ts
git commit -m "$(cat <<'EOF'
sec: harden read_file against symlink-to-sensitive bypass

- run isSensitivePath/gitignore checks AFTER realpath, not just before
- extend denylist with .pem/.key/.p12/.pfx/.crt/.cer extensions
- extend denylist with id_rsa/id_ed25519/id_ecdsa/id_dsa basenames
- extend denylist with service-account.json + credentials.json patterns
- read the canonical (post-realpath) path to close the TOCTOU window
- .pub partners exempted from the suffix denylist

Audit finding: "Symlink bypass can expose sensitive repo-local files" (HIGH)
Audit finding: "Symlinks bypass sensitive-path filtering" (HIGH)
Audit finding: "Sensitive-file denylist misses private-key extensions" (HIGH)
EOF
)"
```

---

### Task 2: Realpath guard on inlined feature files in repo-audit prompts

**Why:** `src/repo-audit/prompts.ts` reads owned/context files and inlines them into the LLM prompt. There is no realpath check, so a symlink in the repo pointing at `~/.aws/credentials` (or any readable local file) would have its contents shipped to the model provider. Distinct surface from Task 1 — this path doesn't go through `read_file`.

**Files:**
- Modify: `src/repo-audit/prompts.ts` (the `readFileSafe` helper + call sites at the owned/context loops)
- Test: `src/repo-audit/__tests__/prompts.test.ts` (existing — if not, create alongside)

**Audit finding closed:** "Symlinked feature files can exfiltrate local secrets to the model" (MEDIUM, security persona).

- [ ] **Step 1: Inspect `readFileSafe` and call sites**

Run:

```bash
grep -n "readFileSafe\|readFile\|realpath" src/repo-audit/prompts.ts
ls src/repo-audit/__tests__/
```

Note the signature, what it returns on missing/binary files, and which loops call it.

- [ ] **Step 2: Write a failing test**

If `src/repo-audit/__tests__/prompts.test.ts` exists, append to it. Otherwise create it with the standard vitest imports. Test body:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Import the helper directly. If readFileSafe isn't exported, export it
// (it's a leaf utility used only inside prompts.ts) before writing the test.
import { readFileSafe } from '../prompts.js'

describe('readFileSafe symlink containment', () => {
  it('refuses to read a symlink that escapes the repo root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kr-outside-'))
    const repo = await mkdtemp(join(tmpdir(), 'kr-repo-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'SECRET')
      await symlink(join(outside, 'secret.txt'), join(repo, 'leak'))
      const body = await readFileSafe(repo, 'leak')
      expect(body).toBeNull() // sentinel returned for unreadable / refused
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reads regular files normally', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kr-repo-ok-'))
    try {
      await writeFile(join(repo, 'a.ts'), 'hello')
      const body = await readFileSafe(repo, 'a.ts')
      expect(body).toBe('hello')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/repo-audit/__tests__/prompts.test.ts`
Expected: the symlink-escape test fails (the file is read, not refused).

- [ ] **Step 4: Add the realpath containment check inside `readFileSafe`**

Open `src/repo-audit/prompts.ts`. Wherever `readFileSafe` is defined, add a realpath containment check before the actual `readFile` call. Pattern:

```typescript
import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

export async function readFileSafe(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    const abs = resolve(repoRoot, relPath)
    const realAbs = await realpath(abs)
    const realRoot = await realpath(resolve(repoRoot))
    const rel = relative(realRoot, realAbs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return null // refuse: symlink escapes repo root
    }
    return await readFile(realAbs, 'utf-8')
  } catch {
    return null
  }
}
```

If the existing implementation has additional checks (e.g., a size cap), preserve them — add the containment check, don't replace the body wholesale. The point is: refuse files whose realpath sits outside `realpath(repoRoot)`.

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/repo-audit/__tests__/prompts.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Audit the new test (sub-agent)**

Brief `test-quality-auditor`: focus on whether the symlink test could pass via an unrelated error path (e.g., `realpath` failing because the outside dir was cleaned up early), and whether `null` is the right sentinel.

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

- [ ] **Step 8: Exercise — run the repo-scope audit on a repo containing a symlink**

```bash
cd /tmp && rm -rf kr-repo-symlink-test && mkdir kr-repo-symlink-test && cd kr-repo-symlink-test
git init -q && echo "irrelevant" > a.ts && git add . && git commit -qm init
ln -s /etc/hosts hosts-symlink
# Even if clawpatch refuses to map this repo, the unit test alone is acceptable evidence.
```

If clawpatch refuses to map a tiny repo, document that and rely on the unit test as the user-exercise evidence — the realpath helper is exercised every audit run.

- [ ] **Step 9: Code review (sub-agent)**

Brief `feature-dev:code-reviewer`: focus on whether other readers in `src/repo-audit/` need the same guard (clawpatch-cli output, feature JSON), and whether the `null` sentinel propagates correctly to the prompt-building loop without producing a misleading "empty file" entry.

- [ ] **Step 10: Commit**

```bash
git add src/repo-audit/prompts.ts src/repo-audit/__tests__/prompts.test.ts
git commit -m "$(cat <<'EOF'
sec: realpath-contain feature-file inlining in repo-audit prompts

Repo-controlled symlinks inside the audited repo could previously point at
host-local files (e.g., ~/.aws/credentials). readFileSafe now resolves the
symlink and refuses anything that escapes realpath(repoRoot).

Audit finding: "Symlinked feature files can exfiltrate local secrets" (MED)
EOF
)"
```

---

### Task 3: Honor `--reviewer` in agentic mode (or reject it loudly)

**Why:** Agentic is the default. Today `kode-review --reviewer security` silently runs the generic agentic prompt — reviewer resolution only happens in the non-agentic branch at `src/index.ts:1017`. Users get the wrong reviewer with no signal.

**Decision:** Honor it. Run each named reviewer's system prompt through the agentic engine (which already supports `systemPrompt` override per `src/review/engine.ts:381`).

**Files:**
- Modify: `src/index.ts:933-1010` (the agentic branch)
- Test: `src/index.ts` is hard to unit-test end-to-end; we'll add an integration-level test that intercepts `runAgenticReview` with a vitest mock and asserts it's called with the resolved reviewer's system prompt.
- Reference: `src/reviewers/index.ts` (`resolveReviewerNames`, `loadReviewerSystemPrompt`)

**Audit finding closed:** "`--reviewer` is ignored in default agentic mode" (HIGH).

- [ ] **Step 1: Confirm the reviewer-resolution surface**

Run:

```bash
grep -n "resolveReviewerNames\|loadReviewerSystemPrompt\|runReviewers" src/reviewers/index.ts | head -20
```

We need: a way to turn `string[]` (the CLI list) into objects with `name` + the system-prompt content, and a way to fan out N agentic reviews and combine their results. The non-agentic branch already does this via `runReviewers` (`src/index.ts:1032`); the agentic branch needs the equivalent.

- [ ] **Step 2: Write a failing test**

Create `src/__tests__/index.agentic-reviewers.test.ts` or extend an existing index-level test if one exists. Skeleton (adjust mocks to match your existing patterns — look at `src/cli/__tests__/` for vitest mock idioms used in this repo):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../review/engine.js', () => ({
  runAgenticReview: vi.fn().mockResolvedValue({
    content: '<kode-findings>[]</kode-findings>',
    toolCallCount: 0,
    truncated: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantMessages: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    findings: [],
  }),
}))

import { runAgenticReview } from '../review/engine.js'

describe('agentic mode + --reviewer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes the security reviewer system prompt into runAgenticReview', async () => {
    // Invoke the index.ts entry by calling the exported main / runReview helper,
    // OR — simpler — extract the agentic dispatch into a helper that takes
    // (reviewerNames, agenticOptions) and assert against the helper directly.
    // The implementation step below extracts that helper. The test asserts:
    //   runAgenticReview was called with systemPrompt containing the
    //   `security` reviewer's template text.
    // (Wire-up depends on how index.ts is structured; see Step 4.)
  })
})
```

You'll flesh this out in Step 4 once the extraction shape is clear. Keep this skeleton failing for now.

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/__tests__/index.agentic-reviewers.test.ts`
Expected: the test is empty / placeholder fails.

- [ ] **Step 4: Extract a `runAgenticReviewers` helper and wire `--reviewer` through it**

In `src/index.ts`, replace the body of the `if (options.agentic) { … }` block (currently lines 933-1009) with logic that:

1. Resolves reviewer infos the same way the non-agentic branch does (`resolveReviewerNames(options.reviewers)`)
2. For the common case `reviewers === ['general']`, runs the existing single-reviewer agentic flow with no system-prompt override (keeps current behavior)
3. For every other case, loops over the resolved reviewers and calls `runAgenticReview` once per reviewer, passing `systemPrompt: <that reviewer's loaded template>`, then merges the outputs the same way `runReviewers` does in the non-agentic branch

The cleanest shape:

```typescript
const reviewerInfos = resolveReviewerNames(options.reviewers)
const isDefaultGeneral =
  reviewerInfos.length === 1 && reviewerInfos[0].name === 'general'

if (isDefaultGeneral) {
  // Unchanged: existing single-shot agentic review with no systemPrompt override.
  const result = await runAgenticReview(agenticOptions)
  // … existing handling
} else {
  // For each named reviewer, run the agentic engine with its system prompt.
  const results = await Promise.all(
    reviewerInfos.map(async (info) => {
      const systemPrompt = await loadReviewerSystemPrompt(info)
      return runAgenticReview({ ...agenticOptions, systemPrompt })
    }),
  )
  // Merge findings/content/usage with the same strategy runReviewers uses.
  // … see src/reviewers/runner.ts for the merge pattern.
}
```

If the merge logic in `src/reviewers/runner.ts` is non-trivial (it likely is — formatting headers per reviewer, deduping, totals), factor it out into an exported helper there and call it from both branches. Don't duplicate it inline.

If you instead choose the loud-rejection path, fail at `parseArgs` when `options.reviewers` is non-default and `options.agentic` is true — but that's a worse UX for users who legitimately want a specific reviewer. Prefer the honor path.

- [ ] **Step 5: Flesh out the test from Step 2**

Now that you have a callable helper, assert:
- For `reviewers = ['security']`, `runAgenticReview` is called exactly once, with `systemPrompt` containing a substring from `src/reviewers/templates/security.md` (e.g., grep `head -1 src/reviewers/templates/security.md` for a stable anchor).
- For `reviewers = ['general']` (default), `runAgenticReview` is called once with `systemPrompt` undefined / unset.
- For `reviewers = ['security', 'architect']`, `runAgenticReview` is called twice with two different system prompts.

- [ ] **Step 6: Run all changed tests**

Run: `npx vitest run src/__tests__/index.agentic-reviewers.test.ts src/reviewers/__tests__/`
Expected: all pass.

- [ ] **Step 7: Audit the new test (sub-agent)**

Brief `test-quality-auditor`. Specifically watch for: does the test assert behavior, or does it tautologically restate the implementation? Does the "general default" case actually verify no systemPrompt is passed, vs. just running and assuming default?

- [ ] **Step 8: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

- [ ] **Step 9: Exercise as a user**

```bash
bun run build
# In a small dirty repo:
node dist/index.js --reviewer security 2>&1 | head -40
```

Expected log output: should mention security (look at `runReviewers`'s usual one-liner) and the model should produce security-focused findings, not the generic agentic prompt's. Compare against `node dist/index.js` (no reviewer) to confirm the prompts differ.

- [ ] **Step 10: Code review (sub-agent)**

Brief `feature-dev:code-reviewer`. Focus: parallel runAgenticReview calls — is there a per-session rate limit pi enforces? CI mode + multiple reviewers — is the sticky comment double-posting concern handled (compare to the non-agentic branch which has explicit logic for this around `src/index.ts:1125-1170`)? Usage totals merged correctly?

- [ ] **Step 11: Commit**

```bash
git add src/index.ts src/__tests__/index.agentic-reviewers.test.ts src/reviewers/runner.ts
git commit -m "$(cat <<'EOF'
fix(cli): honor --reviewer in default agentic mode

Previously, --reviewer was only resolved in the non-agentic branch, so
'kode-review --reviewer security' silently ran the generic agentic prompt.
Now each named reviewer's system prompt is threaded through runAgenticReview
and outputs are merged with the same strategy as the non-agentic path.

Audit finding: "--reviewer is ignored in default agentic mode" (HIGH)
EOF
)"
```

---

### Task 4: Validate `--scope` against the allowed union

**Why:** `src/cli/args.ts:317` casts `opts.scope as ReviewScope | undefined` without validation. `--scope pull` is accepted, then nothing downstream matches it, so the CLI silently runs a different review than the user asked for.

**Files:**
- Modify: `src/cli/args.ts:284-317` (add validation before the existing repo/pr/watch cross-checks)
- Test: `src/cli/__tests__/args.repo-scope.test.ts` or `src/cli/__tests__/args.test.ts` (whichever holds existing scope tests)

**Audit findings closed:** "Invalid `--scope` values have no corresponding test" (HIGH), "Invalid `--scope` values are accepted silently" (HIGH).

- [ ] **Step 1: Find the existing scope test**

Run: `grep -rn "describe.*scope\|opts\.scope" src/cli/__tests__/`

- [ ] **Step 2: Write failing tests**

Add to the relevant test file:

```typescript
import { args, parseArgs } from './_helpers' // or wherever the helper lives

describe('parseArgs: --scope validation', () => {
  it.each(['local', 'pr', 'both', 'auto', 'repo'])(
    'accepts %s',
    (scope) => {
      expect(() => parseArgs(args('--scope', scope))).not.toThrow()
    },
  )

  it('rejects an unknown scope value', () => {
    expect(() => parseArgs(args('--scope', 'pull'))).toThrow(/Invalid --scope/)
  })

  it('rejects an empty string scope value', () => {
    expect(() => parseArgs(args('--scope', ''))).toThrow(/Invalid --scope/)
  })
})
```

If the test helper file (`_helpers` or similar) isn't present, copy the pattern used by `args.repo-scope.test.ts` for declaring `args()` and `parseArgs`.

- [ ] **Step 3: Run failing tests**

Run: `npx vitest run src/cli/__tests__/args.repo-scope.test.ts`
Expected: the 3 new tests fail.

- [ ] **Step 4: Implement validation**

In `src/cli/args.ts`, add an `ALLOWED_SCOPES` constant near the top (alongside the existing `ReviewScope` type definition at line 6):

```typescript
const ALLOWED_SCOPES = ['local', 'pr', 'both', 'auto', 'repo'] as const satisfies readonly ReviewScope[]
```

Then in `parseArgs`, immediately after the `engineRaw` validation block (around the current line 289), add:

```typescript
if (opts.scope !== undefined && !ALLOWED_SCOPES.includes(opts.scope as ReviewScope)) {
  throw new Error(
    `Invalid --scope: "${opts.scope}". Must be one of: ${ALLOWED_SCOPES.join(', ')}.`,
  )
}
```

Place it BEFORE the `--scope repo` cross-checks so we get a clean validation error instead of a confusing combinatorial one.

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/cli/__tests__/args.repo-scope.test.ts`
Expected: all pass.

- [ ] **Step 6: Audit tests (sub-agent)**

Brief `test-quality-auditor`. Quick — this is small. Look for: does the `it.each` cover every scope downstream code actually reads, or only what the type says?

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

- [ ] **Step 8: Exercise as a user**

```bash
bun run build
node dist/index.js --scope pull 2>&1 | head -5
```

Expected: clean error: `Invalid --scope: "pull". Must be one of: local, pr, both, auto, repo.` and exit code != 0.

- [ ] **Step 9: Code review (sub-agent)**

Brief: any downstream code that branches on `scope` without an exhaustive match? Any place that builds a scope value programmatically and could now hit the validation? Quick review.

- [ ] **Step 10: Commit**

```bash
git add src/cli/args.ts src/cli/__tests__/args.repo-scope.test.ts
git commit -m "$(cat <<'EOF'
fix(cli): validate --scope against the allowed union

Previously `--scope pull` and other typos parsed cleanly and silently fell
through downstream branches that compare against the known values. Now we
reject unknown scope values with a clear error.

Audit finding: "Invalid --scope values are accepted silently" (HIGH)
EOF
)"
```

---

### Task 5: Watch mode runs a fresh review after head-move revalidation

**Why:** `src/watch/watcher.ts:329-347` — when the head ref moves and prior findings exist, the code calls `revalidateRequest` and then `return`s. Revalidation only triages stale findings. The new commits pushed since the last review are never reviewed. The new head is then persisted as "reviewed" and skipped on the next poll.

**Files:**
- Modify: `src/watch/watcher.ts` (around lines 329-347)
- Test: `src/watch/__tests__/watcher-revalidation.test.ts` (audit specifically called out that this file only tests the pure helper)

**Audit finding closed:** "Updated PRs with prior findings skip fresh review" (HIGH).

- [ ] **Step 1: Understand the current shape**

Run:

```bash
sed -n '290,360p' src/watch/watcher.ts
```

You need: what `revalidateRequest` does (signature, return value, side effects), how a fresh review is normally dispatched (look at the `else` branch right below), and how outcomes/findings are persisted.

- [ ] **Step 2: Write a failing test**

In `src/watch/__tests__/watcher-revalidation.test.ts`, add a test that drives the head-move branch with a mocked `runReview` (or whichever helper dispatches the fresh review) and asserts BOTH that revalidation happened AND that a fresh review was invoked on the new diff.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
// … existing imports

// Assume the watcher exports a testable function `processRequest` (or
// `reviewRequest`). If it doesn't, extract the inner logic out of
// `runOnce`/`pollOnce` into one before writing this test — name it whatever
// matches the existing codebase style.

describe('processRequest: head-moved with prior findings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('revalidates prior findings AND runs a fresh review on the new diff', async () => {
    const revalidateRequest = vi.fn().mockResolvedValue({ /* shape… */ })
    const runReview = vi.fn().mockResolvedValue({ /* shape… */ })
    const stateManager = {
      getOutcome: vi.fn().mockReturnValue({
        headRef: 'old-sha',
        findings: [{ severity: 'HIGH', title: 'x' }],
      }),
      markReviewed: vi.fn(),
    }
    // … pass these via the function's existing DI surface or vi.mock the modules

    await processRequest({ /* request with new headRef='new-sha' */ })

    expect(revalidateRequest).toHaveBeenCalledOnce()
    expect(runReview).toHaveBeenCalledOnce()
    expect(stateManager.markReviewed).toHaveBeenCalledWith(
      expect.objectContaining({ headRef: 'new-sha' }),
    )
  })
})
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/watch/__tests__/watcher-revalidation.test.ts`
Expected: fails because `runReview` is currently not invoked when revalidation runs.

- [ ] **Step 4: Change the head-move branch to do both**

In `src/watch/watcher.ts` around line 329, change:

```typescript
if (
  prior?.headRef && prior.findings && prior.findings.length > 0 &&
  headRef && prior.headRef !== headRef
) {
  await revalidateRequest(/* … */)
  return
}
```

to:

```typescript
if (
  prior?.headRef && prior.findings && prior.findings.length > 0 &&
  headRef && prior.headRef !== headRef
) {
  // Triage the previously-reported findings against the moved head…
  const revalidatedFindings = await revalidateRequest(
    request, prior.findings, diffContent, prMrInfo, headRef, cliOptions, ctx, stateManager,
  )
  // …but still review the newly-pushed commits as a fresh review.
  // Fall through to the normal review path below; do NOT return here.
  // The fresh review's findings will be merged with revalidatedFindings
  // when we persist state at the end.
  // (Wire the merge through whichever object the fresh-review path uses.)
}

// Normal review path runs below for either: first-time review, head moved
// without prior findings, or head moved WITH prior findings (we just
// revalidated them and now we review the new code).
```

The exact merge plumbing depends on the existing `runReview` / `markReviewed` flow. Make sure the persisted outcome's `findings` is `merge(revalidatedFindings, freshFindings)`, deduped if the merge is non-trivial.

Take care: the original `return` early-exit was there for a reason — probably to skip duplicate state persistence. Trace `markReviewed` calls in the normal path to make sure you're not double-marking. Use a single state write at the end.

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/watch/__tests__/watcher-revalidation.test.ts`
Expected: all pass.

- [ ] **Step 6: Audit tests (sub-agent)**

Brief `test-quality-auditor`. Focus: does the test prove the *new* diff was reviewed (not just that `runReview` was called with some argument)? Verify the mock arguments. Also check whether the test covers the case where revalidation fails partially.

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

- [ ] **Step 8: Exercise as a user**

This is hard to drive end-to-end without a live PR. Acceptable evidence: walk through the watch loop in `--watch-interactive` mode against a sandbox PR you have access to, force a head move (push an empty commit), and confirm the next poll surfaces both: revalidated old findings + new findings on the pushed commit. If you don't have a sandbox PR, document that as "no remote PR fixture available" and rely on the unit test as user-exercise evidence — the watcher's `runOnce` is a pure-ish function with the DI surface the test uses.

- [ ] **Step 9: Code review (sub-agent)**

Brief `feature-dev:code-reviewer`. Focus: state machine — does the new path correctly handle the case where fresh review fails after revalidation succeeds (don't persist a half-state that loses revalidated findings)? Are findings deduped if revalidation says "still present" and the fresh review reports the same line?

- [ ] **Step 10: Commit**

```bash
git add src/watch/watcher.ts src/watch/__tests__/watcher-revalidation.test.ts
git commit -m "$(cat <<'EOF'
fix(watch): review new commits after head-move revalidation

Previously, a PR/MR with prior findings + a moved head went only through
revalidation and then returned — the newly-pushed commits were never
reviewed, and the new head was persisted as 'reviewed' so subsequent polls
skipped it forever. Now we revalidate prior findings AND fresh-review the
new diff, and persist the merged findings under the new head.

Audit finding: "Updated PRs with prior findings skip fresh review" (HIGH)
EOF
)"
```

---

### Task 6: CI gate checks severity counts before trusting `APPROVE`

**Why:** `src/review/ci-mode.ts:57-62` returns 0 whenever `summary.verdict === 'APPROVE'`, BEFORE evaluating `failOn` severity counts. The verdict is generated by the LLM. A prompt-injected diff that produces "APPROVE + critical findings" passes CI silently.

**Files:**
- Modify: `src/review/ci-mode.ts:57-62`
- Test: `src/review/__tests__/ci-mode.test.ts` (or wherever `resolveCiExitCode` is tested today)

**Audit finding closed:** "CI gate trusts APPROVE even when critical counts exist" (HIGH).

- [ ] **Step 1: Find the existing test**

Run: `grep -rn "resolveCiExitCode" src/`

- [ ] **Step 2: Write failing tests**

Add to the existing ci-mode test file:

```typescript
describe('resolveCiExitCode: severity over verdict', () => {
  const apex = (overrides: Partial<ReviewSummary>): ReviewSummary => ({
    verdict: 'APPROVE',
    issuesByCount: { critical: 0, high: 0, medium: 0, low: 0 },
    ...overrides,
  } as ReviewSummary) // shape match — adjust to the real type

  it('fails CI when failOn=critical and critical>0 even if verdict=APPROVE', () => {
    const summary = apex({ issuesByCount: { critical: 1, high: 0, medium: 0, low: 0 } })
    expect(resolveCiExitCode(summary, 'critical')).toBe(1)
  })

  it('fails CI when failOn=high and high>0 even if verdict=APPROVE', () => {
    const summary = apex({ issuesByCount: { critical: 0, high: 1, medium: 0, low: 0 } })
    expect(resolveCiExitCode(summary, 'high')).toBe(1)
  })

  it('still passes CI when verdict=APPROVE and zero counts', () => {
    expect(resolveCiExitCode(apex({}), 'critical')).toBe(0)
  })

  it('respects failOn=none regardless of counts (existing contract)', () => {
    const summary = apex({ issuesByCount: { critical: 5, high: 5, medium: 0, low: 0 } })
    expect(resolveCiExitCode(summary, 'none')).toBe(0)
  })
})
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/review/__tests__/ci-mode.test.ts`
Expected: the critical-with-APPROVE and high-with-APPROVE tests fail.

- [ ] **Step 4: Reorder the checks**

In `src/review/ci-mode.ts:57-62`, replace:

```typescript
export function resolveCiExitCode(summary: ReviewSummary, failOn: FailOn): number {
  if (failOn === 'none') return 0
  if (summary.verdict === 'APPROVE') return 0
  if (failOn === 'critical' && summary.issuesByCount.critical > 0) return 1
  if (failOn === 'high' && (summary.issuesByCount.critical > 0 || summary.issuesByCount.high > 0)) return 1
  return 0
}
```

with:

```typescript
export function resolveCiExitCode(summary: ReviewSummary, failOn: FailOn): number {
  if (failOn === 'none') return 0

  // Severity gate takes precedence over the model-generated verdict.
  // The verdict is text the LLM produced; the counts come from our
  // structured findings parser, which is harder to manipulate via
  // prompt injection in the diff/PR description.
  if (failOn === 'critical' && summary.issuesByCount.critical > 0) return 1
  if (failOn === 'high' && (summary.issuesByCount.critical > 0 || summary.issuesByCount.high > 0)) return 1

  // No blocking severity — fall through to the verdict for the final word.
  if (summary.verdict === 'APPROVE') return 0
  return 0
}
```

Note the last two lines are intentionally equivalent (both `return 0`) — the structure makes the flow readable. If a future contract wants to fail on `REQUEST_CHANGES` even with zero counts, that's where it'd land.

- [ ] **Step 5: Run tests, verify green**

Run: `npx vitest run src/review/__tests__/ci-mode.test.ts`
Expected: all pass.

- [ ] **Step 6: Audit tests (sub-agent)**

Brief `test-quality-auditor`. Quick. Look for: does any test cover the case where the structured-findings parser failed and `issuesByCount` is all zeros while the textual verdict says `REQUEST_CHANGES`? That's a real edge case the audit flagged — "fail closed when verdict/counts conflict."

- [ ] **Step 7: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`

- [ ] **Step 8: Exercise as a user**

Synthesize a CI run: write a tiny scratch script that imports `resolveCiExitCode` with a forged `APPROVE + critical=1` summary and confirms it returns 1. Or, more honestly, document that this is a pure function under test — the unit tests ARE the user exercise.

- [ ] **Step 9: Code review (sub-agent)**

Brief `feature-dev:code-reviewer`. Focus: any caller of `resolveCiExitCode` that relied on the old "APPROVE short-circuits" behavior? Check for the verdict/counts-conflict case the audit flagged — should it fail closed?

- [ ] **Step 10: Commit**

```bash
git add src/review/ci-mode.ts src/review/__tests__/ci-mode.test.ts
git commit -m "$(cat <<'EOF'
sec(ci): check severity counts before trusting model-generated APPROVE

Previously, --fail-on critical would still exit 0 if the model's verdict
was APPROVE, because the verdict check ran first. The verdict is free-form
text the LLM produced over (untrusted) PR content; structured findings come
from our parser. Severity gate now runs first.

Audit finding: "CI gate trusts APPROVE even when critical counts exist" (HIGH)
EOF
)"
```

---

### Final wrap-up

- [ ] **Step W1: Sanity-check the full test suite**

Run: `bun run test`
Expected: full suite green. If anything failed unrelated to these changes, surface it but don't fix it in this plan.

- [ ] **Step W2: Final lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: both green.

- [ ] **Step W3: Run `--scope repo` again to verify these findings no longer surface (optional)**

This is a 60–90 minute run. Not required to ship Tier 1 — but if you want a quick proof, run it. The 6 closed findings should drop out of the open list on the next audit.

- [ ] **Step W4: Final report block**

Per CLAUDE.md Step 10, end with the report block summarizing per-task gate status. Each task's report aggregates to:

```
Step 5 (test audit):     PASS — <agent ids per task>
Step 7 (user exercise):  PASS — <how each task was driven>
Step 8 (code review):    PASS — <agent ids per task>
Step 9 (verify):         bun run lint, bun run typecheck, bun run test — all green
```
