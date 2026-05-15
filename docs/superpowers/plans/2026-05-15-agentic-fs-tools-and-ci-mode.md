# Agentic Filesystem Tools + CI Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agentic review work against a full checked-out source tree without requiring the local indexer — so it runs equally well on a developer laptop with no Docker and in a GitHub Actions / GitLab CI job. The indexer remains an optional accelerator; when it is reachable, indexer-backed tools are used; when it is not, drop-in filesystem/git-backed tools take over transparently.

**Architecture:** Single `--agentic` flag, **no new mode flag**. Inside the agentic session each tool has two implementations — `*-indexer.ts` (existing) and `*-fs.ts` (new, ripgrep + git) — and `pi-tools.ts` chooses per-tool which to register based on indexer availability detected at session start. Two new git-backed tools (`get_commits`, `get_file_history`) are always registered. Two example CI workflow files (GHA + GitLab CI) ship in `docs/ci-examples/`. The CLI gains a `--ci` convenience flag that bundles agentic + non-interactive + markdown output + PR-comment-friendly formatting + optional exit-code gating on CRITICAL findings.

**Tech Stack:** TypeScript (ESM, strict), Node 18+, Bun, vitest, execa, `ripgrep` (binary on PATH), `git` CLI, `@mariozechner/pi-coding-agent` for tool registration via TypeBox, `gh` / `glab` for CI PR comment posting.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/review/tools/ripgrep.ts` | Thin wrapper around `rg --json`. Parses output into typed matches. Single source of truth for ripgrep invocation. |
| `src/review/tools/git-helpers.ts` | `git log` / `git show` wrappers used by `get_commits`, `get_file_history`, and the fs tools. |
| `src/review/tools/search-code-fs.ts` | Filesystem `search_code` — runs `rg` against `repoRoot`, returns the same `SearchCodeOutput` shape as the indexer impl. |
| `src/review/tools/find-definitions-fs.ts` | Filesystem `find_definitions` — uses language-aware `rg` patterns (per-extension regex) to locate definitions. |
| `src/review/tools/find-usages-fs.ts` | Filesystem `find_usages` — `rg` for the symbol, with an exclusion filter so the definition itself is not returned. |
| `src/review/tools/get-call-graph-fs.ts` | Best-effort fallback that returns `{ callers: [], callees: [], available: false, reason: "indexer required" }` — keeps the schema stable so the model gracefully degrades. |
| `src/review/tools/get-impact-fs.ts` | Filesystem `get_impact` — uses `rg` for `import ... from 'X'` / `require('X')` / `from X import ...` patterns to find direct importers. Reports `indirectImporters: []` and `isPartial: true`. |
| `src/review/tools/get-commits.ts` | New tool. Returns commit messages + authors + timestamps for a ref range (default: `<merge-base>..HEAD`). Always registered. |
| `src/review/tools/get-file-history.ts` | New tool. Returns last N commits that touched a given file. Always registered. |
| `src/review/tools/__tests__/ripgrep.test.ts` | Unit tests for the rg output parser. |
| `src/review/tools/__tests__/git-helpers.test.ts` | Unit tests for git helpers (with fixture repo). |
| `src/review/tools/__tests__/search-code-fs.test.ts` | Integration test against `__tests__/fixtures/sample-repo/`. |
| `src/review/tools/__tests__/find-definitions-fs.test.ts` | Integration test against fixture repo. |
| `src/review/tools/__tests__/find-usages-fs.test.ts` | Integration test against fixture repo. |
| `src/review/tools/__tests__/get-impact-fs.test.ts` | Integration test against fixture repo. |
| `src/review/tools/__tests__/get-commits.test.ts` | Integration test using a temp git repo built in `beforeEach`. |
| `src/review/tools/__tests__/get-file-history.test.ts` | Same as above. |
| `src/review/tools/__tests__/fixtures/sample-repo/` | Small fixture: source files in TS and Python with known symbols, imports, and call sites. Not a git repo. |
| `src/review/ci-mode.ts` | Helpers for `--ci` mode: detect platform from env (`GITHUB_ACTIONS`, `GITLAB_CI`), pick PR number, **replace** sticky comment via `gh`/`glab` (list-find-post-delete), decide exit code from review verdict. |
| `src/review/__tests__/ci-mode.test.ts` | Unit tests for platform detection, comment formatting, exit-code logic, sticky-replacement orchestration (via an injected runner). |
| `src/review/suppressions.ts` | Post-processes the review markdown: drops findings whose `file:line` reference is annotated with a `kode-review: ignore` magic comment in the source. Always-on; disable with `--no-suppressions`. |
| `src/review/__tests__/suppressions.test.ts` | Unit + integration tests for the suppression filter (uses the sample-repo fixture plus inline strings). |
| `docs/ci-examples/github-actions.yml` | Example GHA workflow. Documented with comments. |
| `docs/ci-examples/gitlab-ci.yml` | Example GitLab CI job. Documented with comments. |
| `docs/ci-examples/README.md` | Explains how to copy/adapt the examples; lists required secrets and permissions. |

### Modified files

| Path | Change |
|---|---|
| `src/review/tools/search-code.ts` | Rename to `search-code-indexer.ts`. Update barrel. |
| `src/review/tools/find-definitions.ts` | Rename to `find-definitions-indexer.ts`. Update barrel. |
| `src/review/tools/find-usages.ts` | Rename to `find-usages-indexer.ts`. Update barrel. |
| `src/review/tools/get-call-graph.ts` | Rename to `get-call-graph-indexer.ts`. Update barrel. |
| `src/review/tools/get-impact.ts` | Rename to `get-impact-indexer.ts`. Update barrel. |
| `src/review/tools/index.ts` | Re-export both `*-indexer` and `*-fs` handlers under stable names. |
| `src/review/pi-tools.ts` | Replace the `if (!resolved.indexerClient) return` early-return with per-tool dispatch: register the indexer impl when `indexerClient` is set, otherwise register the fs impl. Always register `get_commits` and `get_file_history`. Add ripgrep availability check; if `rg` is missing AND indexer is missing, log a clear error and register only `read_file` + git tools. |
| `src/review/engine.ts` | No type changes. `AgenticReviewOptions.indexerUrl` stays optional. Pass through the new tool context unchanged. |
| `src/review/agentic-prompt.ts` | Update `AGENTIC_SYSTEM_PROMPT` tool list to mention `get_commits`, `get_file_history`. Add a sentence noting that some tools may report `available: false` and the model should still proceed with whatever data it has. |
| `src/cli/args.ts` | Add `ci: boolean`, `failOn: 'critical' | 'high' | 'none'`, `noSuppressions: boolean` to `CliOptions`. Wire `--ci`, `--fail-on`, `--no-suppressions`. When `--ci` is set, default `agentic=true`, `quiet=true`, `format='markdown'`, `postToPr=true`. |
| `src/review/agentic-prompt.ts` | (Already noted above.) Additionally instruct the model to honor `kode-review: ignore` markers — see Task 12. |
| `src/cli/doctor.ts` | Add a "ripgrep" probe so `kode-review --doctor` reports its presence/version (needed for fs tools). |
| `src/index.ts` | Around line 779 (the `if (options.agentic)` block): remove the "indexer not running ⇒ read_file only" warning — that is no longer accurate. Replace with a single info line listing which toolset is active. Wire `--ci` handling: when set, call `runCiMode()` (post comment, choose exit code). |
| `README.md` | Add a "CI usage" section pointing at `docs/ci-examples/`. Add a row to the tools table for the new git tools. |
| `src/review/__tests__/engine.test.ts` | Add cases verifying tool registration in both indexer-available and indexer-missing branches. |
| `src/cli/__tests__/doctor.test.ts` | Add a case for ripgrep detection. |
| `docs/acceptance-tests.json` | Add new use cases AC-15 through AC-22 covering ripgrep wrapper, git helpers, fs-backed tools, `get_commits`/`get_file_history`, dispatch logic, `--ci` flag, sticky-comment replacement, and suppression markers (see Task 14). |

---

## Task 1: ripgrep wrapper + parser

**Why first:** Every fs tool depends on this. Pure function, easy to test.

**Files:**
- Create: `src/review/tools/ripgrep.ts`
- Test: `src/review/tools/__tests__/ripgrep.test.ts`

- [ ] **Step 1: Write the failing test for output parsing**

`src/review/tools/__tests__/ripgrep.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRipgrepJsonOutput } from '../ripgrep.js'

describe('parseRipgrepJsonOutput', () => {
  it('extracts matches from rg --json line-delimited output', () => {
    const raw = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'export function foo() {\n' },
          line_number: 12,
          submatches: [{ match: { text: 'foo' }, start: 16, end: 19 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
    ].join('\n')

    const matches = parseRipgrepJsonOutput(raw)

    expect(matches).toEqual([
      {
        path: 'src/a.ts',
        line: 12,
        text: 'export function foo() {',
        matchText: 'foo',
        column: 17,
      },
    ])
  })

  it('returns an empty array for no-match output', () => {
    expect(parseRipgrepJsonOutput('')).toEqual([])
  })

  it('ignores non-match event types', () => {
    const raw = JSON.stringify({ type: 'summary', data: {} })
    expect(parseRipgrepJsonOutput(raw)).toEqual([])
  })

  it('throws on malformed JSON lines', () => {
    expect(() => parseRipgrepJsonOutput('{not json')).toThrow(/parse/i)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run src/review/tools/__tests__/ripgrep.test.ts`
Expected: FAIL — module `'../ripgrep.js'` cannot be resolved.

- [ ] **Step 3: Implement `ripgrep.ts`**

`src/review/tools/ripgrep.ts`:

```ts
/**
 * Thin wrapper around the `rg` binary using its JSON event stream.
 * All filesystem-backed agentic tools route through this module so we
 * have a single place to enforce flags, gitignore behaviour, and result caps.
 */

import { exec, commandExists } from '../../utils/exec.js'

export interface RipgrepMatch {
  path: string
  line: number
  text: string
  matchText: string
  /** 1-based column where the match starts. */
  column: number
}

export interface RipgrepOptions {
  globs?: string[]
  maxResults?: number
  type?: string
  fixedString?: boolean
  wholeWord?: boolean
}

const DEFAULT_MAX_RESULTS = 200

export async function isRipgrepAvailable(): Promise<boolean> {
  return commandExists('rg')
}

export async function ripgrepSearch(
  pattern: string,
  repoRoot: string,
  options: RipgrepOptions = {},
): Promise<RipgrepMatch[]> {
  if (!(await isRipgrepAvailable())) {
    throw new Error(
      'ripgrep (rg) is required for filesystem-backed agentic tools but was not found on PATH. ' +
      'Install ripgrep (https://github.com/BurntSushi/ripgrep#installation) or start the indexer.',
    )
  }

  const args: string[] = ['--json', '--no-messages']
  if (options.fixedString !== false) args.push('-F')
  if (options.wholeWord) args.push('-w')
  if (options.type) args.push('--type', options.type)
  for (const g of options.globs ?? []) args.push('-g', g)
  args.push('--', pattern, '.')

  const result = await exec('rg', args, { cwd: repoRoot })
  // rg exits 1 when there are no matches — that is not an error for us.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`ripgrep failed (exit ${result.exitCode}): ${result.stderr}`)
  }

  const matches = parseRipgrepJsonOutput(result.stdout)
  const limit = options.maxResults ?? DEFAULT_MAX_RESULTS
  return matches.slice(0, limit)
}

export function parseRipgrepJsonOutput(raw: string): RipgrepMatch[] {
  if (!raw) return []
  const out: RipgrepMatch[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`Failed to parse ripgrep JSON line: ${line.slice(0, 80)}`)
    }
    const ev = event as { type?: string; data?: any }
    if (ev.type !== 'match' || !ev.data) continue
    const d = ev.data
    const sm = Array.isArray(d.submatches) && d.submatches.length > 0 ? d.submatches[0] : null
    out.push({
      path: d.path?.text ?? '',
      line: typeof d.line_number === 'number' ? d.line_number : 0,
      text: typeof d.lines?.text === 'string' ? d.lines.text.replace(/\n$/, '') : '',
      matchText: sm?.match?.text ?? '',
      column: typeof sm?.start === 'number' ? sm.start + 1 : 1,
    })
  }
  return out
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/review/tools/__tests__/ripgrep.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Sub-agent test audit**

Dispatch `test-quality-auditor` on `src/review/tools/__tests__/ripgrep.test.ts` to verify the tests assert behaviour (not implementation), include error cases, and do not test the rg binary itself (only the parser). Address Critical/High findings before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/review/tools/ripgrep.ts src/review/tools/__tests__/ripgrep.test.ts
git commit -m "feat(review): add ripgrep wrapper with JSON output parser"
```

---

## Task 2: git helpers (log/merge-base wrappers)

**Files:**
- Create: `src/review/tools/git-helpers.ts`
- Test: `src/review/tools/__tests__/git-helpers.test.ts`

- [ ] **Step 1: Write the failing test using a temp repo**

`src/review/tools/__tests__/git-helpers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execaSync } from 'execa'
import {
  getCommitsInRange,
  getFileHistory,
  getMergeBase,
} from '../git-helpers.js'

function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd })
}

describe('git-helpers', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-git-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'initial commit')
    git(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'two')
    git(repo, 'commit', '-q', '-am', 'feat: bump value')
    writeFileSync(join(repo, 'a.txt'), 'three')
    git(repo, 'commit', '-q', '-am', 'fix: bump again')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns commits in <base>..HEAD with subject, author, sha', async () => {
    const commits = await getCommitsInRange(repo, 'main', 'HEAD')
    expect(commits).toHaveLength(2)
    expect(commits[0].subject).toBe('fix: bump again')
    expect(commits[1].subject).toBe('feat: bump value')
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commits[0].author).toBe('Test')
  })

  it('includes full body when requested', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: x', '-m', 'long body here')
    const commits = await getCommitsInRange(repo, 'main', 'HEAD', { includeBody: true })
    expect(commits[0].body).toContain('long body here')
  })

  it('returns file history limited to N entries', async () => {
    const history = await getFileHistory(repo, 'a.txt', { limit: 1 })
    expect(history).toHaveLength(1)
    expect(history[0].subject).toBe('fix: bump again')
  })

  it('computes merge-base between two refs', async () => {
    const base = await getMergeBase(repo, 'main', 'HEAD')
    expect(base).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns an empty array for an empty range', async () => {
    const commits = await getCommitsInRange(repo, 'HEAD', 'HEAD')
    expect(commits).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/tools/__tests__/git-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `git-helpers.ts`**

`src/review/tools/git-helpers.ts`:

```ts
/**
 * Thin wrappers around the git CLI used by the agentic tool layer.
 */

import { exec } from '../../utils/exec.js'

export interface CommitInfo {
  sha: string
  shortSha: string
  author: string
  authorEmail: string
  timestamp: string
  subject: string
  body?: string
}

export interface GetCommitsOptions {
  includeBody?: boolean
  limit?: number
}

const COMMIT_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e'
const FIELD_SEP = '\x1f'
const RECORD_SEP = '\x1e'

function parseCommits(stdout: string, includeBody: boolean): CommitInfo[] {
  if (!stdout.trim()) return []
  const out: CommitInfo[] = []
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, '')
    if (!trimmed) continue
    const [sha, shortSha, author, authorEmail, timestamp, subject, body] = trimmed.split(FIELD_SEP)
    if (!sha) continue
    out.push({
      sha,
      shortSha,
      author,
      authorEmail,
      timestamp,
      subject,
      ...(includeBody ? { body: (body ?? '').trim() } : {}),
    })
  }
  return out
}

export async function getCommitsInRange(
  repoRoot: string,
  base: string,
  head: string,
  options: GetCommitsOptions = {},
): Promise<CommitInfo[]> {
  const limit = options.limit ?? 50
  const result = await exec(
    'git',
    ['log', `--pretty=format:${COMMIT_FORMAT}`, '-n', String(limit), `${base}..${head}`],
    { cwd: repoRoot },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git log failed: ${result.stderr}`)
  }
  return parseCommits(result.stdout, Boolean(options.includeBody))
}

export async function getFileHistory(
  repoRoot: string,
  filePath: string,
  options: GetCommitsOptions = {},
): Promise<CommitInfo[]> {
  const limit = options.limit ?? 10
  const result = await exec(
    'git',
    ['log', `--pretty=format:${COMMIT_FORMAT}`, '-n', String(limit), '--', filePath],
    { cwd: repoRoot },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git log for ${filePath} failed: ${result.stderr}`)
  }
  return parseCommits(result.stdout, Boolean(options.includeBody))
}

export async function getMergeBase(
  repoRoot: string,
  refA: string,
  refB: string,
): Promise<string> {
  const result = await exec('git', ['merge-base', refA, refB], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git merge-base ${refA} ${refB} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/review/tools/__tests__/git-helpers.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Sub-agent test audit**

Dispatch `test-quality-auditor`. Verify: real git repo (not mocked), assertions check behaviour, no `console.log` posing as verification, edge cases (empty range) tested.

- [ ] **Step 6: Commit**

```bash
git add src/review/tools/git-helpers.ts src/review/tools/__tests__/git-helpers.test.ts
git commit -m "feat(review): add git log/merge-base helpers for agentic tools"
```

---

## Task 3: Fixture repo for fs-tool integration tests

**Why now:** Tasks 4–7 all need the same fixture. Build it once.

**Files:**
- Create: `src/review/tools/__tests__/fixtures/sample-repo/src/calculator.ts`
- Create: `src/review/tools/__tests__/fixtures/sample-repo/src/utils.ts`
- Create: `src/review/tools/__tests__/fixtures/sample-repo/src/index.ts`
- Create: `src/review/tools/__tests__/fixtures/sample-repo/lib/helpers.py`
- Create: `src/review/tools/__tests__/fixtures/sample-repo/.gitignore`

- [ ] **Step 1: Create the fixture**

`src/review/tools/__tests__/fixtures/sample-repo/src/calculator.ts`:

```ts
import { square } from './utils.js'

export class Calculator {
  add(a: number, b: number): number {
    return a + b
  }

  squareSum(a: number, b: number): number {
    return square(this.add(a, b))
  }
}
```

`src/review/tools/__tests__/fixtures/sample-repo/src/utils.ts`:

```ts
export function square(n: number): number {
  return n * n
}

export function cube(n: number): number {
  return n * n * n
}
```

`src/review/tools/__tests__/fixtures/sample-repo/src/index.ts`:

```ts
import { Calculator } from './calculator.js'

const c = new Calculator()
console.log(c.squareSum(2, 3))
```

`src/review/tools/__tests__/fixtures/sample-repo/lib/helpers.py`:

```python
def square(n):
    return n * n

class Helper:
    def double(self, n):
        return n * 2
```

`src/review/tools/__tests__/fixtures/sample-repo/.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 2: Commit**

```bash
git add src/review/tools/__tests__/fixtures/
git commit -m "test(review): add sample-repo fixture for fs tool tests"
```

---

## Task 4: `search_code` filesystem implementation

**Files:**
- Create: `src/review/tools/search-code-fs.ts`
- Test: `src/review/tools/__tests__/search-code-fs.test.ts`
- Rename: `search-code.ts` → `search-code-indexer.ts`

- [ ] **Step 1: Write the failing test**

`src/review/tools/__tests__/search-code-fs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { searchCodeFsHandler } from '../search-code-fs.js'

const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

describe('searchCodeFsHandler', () => {
  it('returns matches for an identifier', async () => {
    const out = await searchCodeFsHandler({ query: 'squareSum' }, FIXTURE)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.every((r) => r.content.includes('squareSum'))).toBe(true)
    expect(out.query).toBe('squareSum')
  })

  it('respects the limit option', async () => {
    const out = await searchCodeFsHandler({ query: 'square', limit: 1 }, FIXTURE)
    expect(out.results).toHaveLength(1)
  })

  it('returns no results for non-existent identifiers without throwing', async () => {
    const out = await searchCodeFsHandler({ query: 'totallyMadeUpSymbol_xyzzy' }, FIXTURE)
    expect(out.results).toEqual([])
    expect(out.totalMatches).toBe(0)
  })

  it('caps limit at the upper bound', async () => {
    const out = await searchCodeFsHandler({ query: 'function', limit: 9999 }, FIXTURE)
    expect(out.results.length).toBeLessThanOrEqual(20)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/tools/__tests__/search-code-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `search-code-fs.ts`**

```ts
/**
 * Filesystem-backed implementation of the `search_code` tool. Used in agentic
 * mode whenever the indexer is unreachable. Output shape matches the indexer
 * implementation so the prompt and the model do not need to know which is in use.
 */

import { ripgrepSearch } from './ripgrep.js'
import type { SearchCodeInput, SearchCodeOutput } from './search-code-indexer.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

export async function searchCodeFsHandler(
  input: SearchCodeInput,
  repoRoot: string,
): Promise<SearchCodeOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const matches = await ripgrepSearch(input.query, repoRoot, {
    maxResults: limit,
    fixedString: true,
  })

  return {
    results: matches.map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      score: 1,
      matchTypes: ['lexical'],
    })),
    totalMatches: matches.length,
    query: input.query,
  }
}
```

- [ ] **Step 4: Rename the existing indexer impl**

```bash
git mv src/review/tools/search-code.ts src/review/tools/search-code-indexer.ts
```

Update imports in `src/review/tools/index.ts` (replace `./search-code.js` with `./search-code-indexer.js`) and update the binding name in `src/review/pi-tools.ts` (`searchCodeHandler` → `searchCodeIndexerHandler`).

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run src/review/tools/__tests__/search-code-fs.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Sub-agent test audit**

Dispatch `test-quality-auditor` on `search-code-fs.test.ts`. Watch for: tests that pass regardless of code, missing edge cases, mocking the SUT.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(review): add filesystem-backed search_code via ripgrep"
```

---

## Task 5: `find_definitions` filesystem implementation

**Files:**
- Create: `src/review/tools/find-definitions-fs.ts`
- Test: `src/review/tools/__tests__/find-definitions-fs.test.ts`
- Rename: `find-definitions.ts` → `find-definitions-indexer.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { findDefinitionsFsHandler } from '../find-definitions-fs.js'

const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

describe('findDefinitionsFsHandler', () => {
  it('locates a TypeScript function definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'square' }, FIXTURE)
    const utilsHit = out.definitions.find((d) => d.path.endsWith('utils.ts'))
    expect(utilsHit).toBeDefined()
    expect(utilsHit!.content).toContain('export function square')
  })

  it('locates a TypeScript class definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'Calculator' }, FIXTURE)
    const hit = out.definitions.find((d) => d.path.endsWith('calculator.ts'))
    expect(hit).toBeDefined()
    expect(hit!.content).toContain('class Calculator')
  })

  it('locates a Python function definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'square' }, FIXTURE)
    expect(out.definitions.some((d) => d.path.endsWith('helpers.py') && d.content.includes('def square'))).toBe(true)
  })

  it('returns an empty result for unknown symbols', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'nopeNotReal' }, FIXTURE)
    expect(out.definitions).toEqual([])
    expect(out.totalCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/tools/__tests__/find-definitions-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `find-definitions-fs.ts`**

```ts
/**
 * Filesystem-backed `find_definitions`. Uses ripgrep with language-aware
 * regex patterns to locate symbol definitions across the working tree.
 *
 * This is a heuristic, not a parser — it catches the common idiomatic forms
 * (function/class/const/def/type) in JS/TS/Py/Go/Rust/Java. Misses are
 * acceptable; the model can fall back to `search_code`.
 */

import { ripgrepSearch } from './ripgrep.js'
import type {
  FindDefinitionsInput,
  FindDefinitionsOutput,
} from './find-definitions-indexer.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildDefinitionPattern(symbol: string): string {
  const s = escapeForRegex(symbol)
  return (
    `\\b(function|class|const|let|var|type|interface|enum|def|fn|struct|trait|impl|func)\\b[^\\n]{0,80}\\b${s}\\b`
  )
}

export async function findDefinitionsFsHandler(
  input: FindDefinitionsInput,
  repoRoot: string,
): Promise<FindDefinitionsOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const pattern = buildDefinitionPattern(input.symbol)
  const matches = await ripgrepSearch(pattern, repoRoot, {
    maxResults: limit,
    fixedString: false,
  })

  return {
    symbol: input.symbol,
    definitions: matches.map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      isReexport: false,
    })),
    totalCount: matches.length,
  }
}
```

- [ ] **Step 4: Rename existing indexer file**

```bash
git mv src/review/tools/find-definitions.ts src/review/tools/find-definitions-indexer.ts
```

Update barrel and `pi-tools.ts` imports.

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run src/review/tools/__tests__/find-definitions-fs.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Sub-agent test audit**

Dispatch `test-quality-auditor`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(review): add filesystem-backed find_definitions"
```

---

## Task 6: `find_usages` filesystem implementation

**Files:**
- Create: `src/review/tools/find-usages-fs.ts`
- Test: `src/review/tools/__tests__/find-usages-fs.test.ts`
- Rename: `find-usages.ts` → `find-usages-indexer.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { findUsagesFsHandler } from '../find-usages-fs.js'

const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

describe('findUsagesFsHandler', () => {
  it('finds call sites of a function', async () => {
    const out = await findUsagesFsHandler({ symbol: 'square' }, FIXTURE)
    expect(out.usages.some((u) => u.path.endsWith('calculator.ts'))).toBe(true)
    expect(out.usages.every((u) => !u.content.includes('export function square'))).toBe(true)
  })

  it('finds usages of a class', async () => {
    const out = await findUsagesFsHandler({ symbol: 'Calculator' }, FIXTURE)
    expect(out.usages.some((u) => u.path.endsWith('index.ts'))).toBe(true)
  })

  it('returns an empty result for unused symbols', async () => {
    const out = await findUsagesFsHandler({ symbol: 'absolutelyUnusedSym' }, FIXTURE)
    expect(out.usages).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/tools/__tests__/find-usages-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `find-usages-fs.ts`**

```ts
/**
 * Filesystem-backed `find_usages`. Runs a whole-word ripgrep search for the
 * symbol, then filters out the definition line itself.
 */

import { ripgrepSearch } from './ripgrep.js'
import type { FindUsagesInput, FindUsagesOutput } from './find-usages-indexer.js'

const DEFAULT_LIMIT = 15
const MAX_LIMIT = 30

const DEFINITION_RE = /\b(function|class|const|let|var|type|interface|enum|def|fn|struct|trait|impl|func)\b/

export async function findUsagesFsHandler(
  input: FindUsagesInput,
  repoRoot: string,
): Promise<FindUsagesOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const matches = await ripgrepSearch(input.symbol, repoRoot, {
    maxResults: limit * 2,
    fixedString: true,
    wholeWord: true,
  })

  const usages = matches
    .filter((m) => !DEFINITION_RE.test(m.text))
    .slice(0, limit)
    .map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      usageType: 'references' as const,
      isDynamic: false,
    }))

  return {
    symbol: input.symbol,
    usages,
    totalCount: usages.length,
  }
}
```

- [ ] **Step 4: Rename existing indexer file**

```bash
git mv src/review/tools/find-usages.ts src/review/tools/find-usages-indexer.ts
```

Update barrel and `pi-tools.ts` imports.

- [ ] **Step 5: Run test to verify pass**

Run: `npx vitest run src/review/tools/__tests__/find-usages-fs.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 6: Sub-agent test audit**

Dispatch `test-quality-auditor`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(review): add filesystem-backed find_usages"
```

---

## Task 7: `get_impact` filesystem impl + `get_call_graph` stub

**Files:**
- Create: `src/review/tools/get-impact-fs.ts`
- Create: `src/review/tools/get-call-graph-fs.ts`
- Test: `src/review/tools/__tests__/get-impact-fs.test.ts`
- Rename: `get-impact.ts` → `get-impact-indexer.ts`, `get-call-graph.ts` → `get-call-graph-indexer.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { getImpactFsHandler } from '../get-impact-fs.js'

const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

describe('getImpactFsHandler', () => {
  it('finds direct importers of a file (TS)', async () => {
    const out = await getImpactFsHandler({ filePath: 'src/utils.ts' }, FIXTURE)
    expect(out.directImporters).toContain('src/calculator.ts')
    expect(out.isPartial).toBe(true)
  })

  it('reports zero importers for unreferenced files', async () => {
    const out = await getImpactFsHandler({ filePath: 'src/nonexistent.ts' }, FIXTURE)
    expect(out.directImporters).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/tools/__tests__/get-impact-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `get-impact-fs.ts`**

```ts
/**
 * Filesystem-backed `get_impact`. Resolves *direct* importers by greping
 * for import-statement patterns. Does not chase indirect dependencies.
 */

import { basename, extname } from 'node:path'
import { ripgrepSearch } from './ripgrep.js'
import type { GetImpactInput } from './get-impact-indexer.js'

export interface GetImpactFsOutput {
  targetFile: string
  directImports: string[]
  directImporters: string[]
  indirectImports: string[]
  indirectImporters: string[]
  totalDependents: number
  isHighImpact: boolean
  isPartial: true
}

const HIGH_IMPACT_THRESHOLD = 5

function importPatterns(filePath: string): string[] {
  const base = basename(filePath, extname(filePath))
  return [
    `from ['"][^'"]*${base}['"]`,
    `require\\(['"][^'"]*${base}['"]\\)`,
    `import ['"][^'"]*${base}['"]`,
    `from [^\\s]*${base} import`,
  ]
}

export async function getImpactFsHandler(
  input: GetImpactInput,
  repoRoot: string,
): Promise<GetImpactFsOutput> {
  const seen = new Set<string>()
  for (const pattern of importPatterns(input.filePath)) {
    const matches = await ripgrepSearch(pattern, repoRoot, {
      maxResults: 100,
      fixedString: false,
    })
    for (const m of matches) {
      if (m.path !== input.filePath) seen.add(m.path)
    }
  }
  const directImporters = Array.from(seen).sort()
  return {
    targetFile: input.filePath,
    directImports: [],
    directImporters,
    indirectImports: [],
    indirectImporters: [],
    totalDependents: directImporters.length,
    isHighImpact: directImporters.length >= HIGH_IMPACT_THRESHOLD,
    isPartial: true,
  }
}
```

- [ ] **Step 4: Implement `get-call-graph-fs.ts` (stub)**

```ts
/**
 * Filesystem-backed `get_call_graph`. There is no reliable way to build a
 * proper call graph from text matching, so this returns a structured
 * "unavailable" response that keeps the schema stable.
 */

import type {
  GetCallGraphInput,
  GetCallGraphOutput,
} from './get-call-graph-indexer.js'

export type GetCallGraphFsOutput = GetCallGraphOutput & {
  available: false
  reason: string
}

export async function getCallGraphFsHandler(
  input: GetCallGraphInput,
): Promise<GetCallGraphFsOutput> {
  return {
    function: input.functionName,
    direction: input.direction ?? 'both',
    callers: [],
    callees: [],
    available: false,
    reason:
      'Call graph requires the indexer. Use `find_usages` for callers and `read_file` + `search_code` to inspect callees manually.',
  }
}
```

- [ ] **Step 5: Rename existing indexer files**

```bash
git mv src/review/tools/get-impact.ts src/review/tools/get-impact-indexer.ts
git mv src/review/tools/get-call-graph.ts src/review/tools/get-call-graph-indexer.ts
```

Update barrel and `pi-tools.ts` imports.

- [ ] **Step 6: Run test to verify pass**

Run: `npx vitest run src/review/tools/__tests__/get-impact-fs.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 7: Sub-agent test audit**

Dispatch `test-quality-auditor`. Note in the dispatch that the call-graph stub has no test of its own (5-line deterministic return).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(review): add filesystem-backed get_impact and call_graph stub"
```

---

## Task 8: `get_commits` and `get_file_history` tools

**Files:**
- Create: `src/review/tools/get-commits.ts`
- Create: `src/review/tools/get-file-history.ts`
- Test: `src/review/tools/__tests__/get-commits.test.ts`
- Test: `src/review/tools/__tests__/get-file-history.test.ts`

- [ ] **Step 1: Write the failing tests**

`get-commits.test.ts` (replicate the temp-repo setup from `git-helpers.test.ts` verbatim — do not extract a shared helper, YAGNI):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execaSync } from 'execa'
import { getCommitsHandler } from '../get-commits.js'
import { getMergeBase } from '../git-helpers.js'

function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd })
}

describe('getCommitsHandler', () => {
  let repo: string
  let defaultBase: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-commits-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'initial commit')
    git(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'two')
    git(repo, 'commit', '-q', '-am', 'feat: bump value')
    defaultBase = await getMergeBase(repo, 'main', 'HEAD')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns commits in the default range (merge-base..HEAD)', async () => {
    const out = await getCommitsHandler({}, repo, defaultBase)
    expect(out.commits).toHaveLength(1)
    expect(out.commits[0].subject).toBe('feat: bump value')
    expect(out.totalCount).toBe(1)
  })

  it('respects the limit option', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: a')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: b')
    const out = await getCommitsHandler({ limit: 1 }, repo, defaultBase)
    expect(out.commits).toHaveLength(1)
  })

  it('includes body when requested', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: x', '-m', 'detailed body')
    const out = await getCommitsHandler({ includeBody: true }, repo, defaultBase)
    expect(out.commits.find((c) => c.subject === 'feat: x')?.body).toContain('detailed body')
  })
})
```

`get-file-history.test.ts` — same shape, asserting at most `limit` commits, all of which touch the named file.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/review/tools/__tests__/get-commits.test.ts src/review/tools/__tests__/get-file-history.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `get-commits.ts`**

```ts
import { getCommitsInRange, type CommitInfo } from './git-helpers.js'

export interface GetCommitsInput {
  base?: string
  head?: string
  includeBody?: boolean
  limit?: number
}

export interface GetCommitsOutput {
  base: string
  head: string
  commits: CommitInfo[]
  totalCount: number
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export async function getCommitsHandler(
  input: GetCommitsInput,
  repoRoot: string,
  defaultBase: string,
): Promise<GetCommitsOutput> {
  const base = input.base ?? defaultBase
  const head = input.head ?? 'HEAD'
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const commits = await getCommitsInRange(repoRoot, base, head, {
    includeBody: Boolean(input.includeBody),
    limit,
  })
  return { base, head, commits, totalCount: commits.length }
}
```

- [ ] **Step 4: Implement `get-file-history.ts`**

```ts
import { getFileHistory, type CommitInfo } from './git-helpers.js'

export interface GetFileHistoryInput {
  filePath: string
  limit?: number
  includeBody?: boolean
}

export interface GetFileHistoryOutput {
  filePath: string
  commits: CommitInfo[]
  totalCount: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export async function getFileHistoryHandler(
  input: GetFileHistoryInput,
  repoRoot: string,
): Promise<GetFileHistoryOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const commits = await getFileHistory(repoRoot, input.filePath, {
    limit,
    includeBody: Boolean(input.includeBody),
  })
  return { filePath: input.filePath, commits, totalCount: commits.length }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/review/tools/__tests__/get-commits.test.ts src/review/tools/__tests__/get-file-history.test.ts`
Expected: PASS.

- [ ] **Step 6: Sub-agent test audit**

Dispatch `test-quality-auditor`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(review): add get_commits and get_file_history agentic tools"
```

---

## Task 9: Wire the fs tools + git tools into `pi-tools.ts`

**Files:**
- Modify: `src/review/pi-tools.ts`
- Modify: `src/review/tools/index.ts`
- Modify: `src/review/agentic-prompt.ts`
- Test: `src/review/__tests__/engine.test.ts` (add cases)

- [ ] **Step 1: Update tools barrel**

`src/review/tools/index.ts`: re-export indexer + fs handlers under stable names:

```ts
export {
  searchCodeHandler as searchCodeIndexerHandler,
  searchCodeSchema,
  type SearchCodeInput,
  type SearchCodeOutput,
} from './search-code-indexer.js'

export { searchCodeFsHandler } from './search-code-fs.js'

// repeat the same pattern for find-definitions, find-usages, get-call-graph, get-impact

export { getCommitsHandler, type GetCommitsInput, type GetCommitsOutput } from './get-commits.js'
export { getFileHistoryHandler, type GetFileHistoryInput, type GetFileHistoryOutput } from './get-file-history.js'
```

- [ ] **Step 2: Write the failing engine test**

Add to `src/review/__tests__/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createKodeReviewToolsExtension } from '../pi-tools.js'

describe('pi-tools registration', () => {
  function makePi() {
    const registered: string[] = []
    return {
      registered,
      api: { registerTool: (t: { name: string }) => registered.push(t.name) } as any,
    }
  }

  it('registers all six review tools + git tools when indexerUrl is absent', async () => {
    const { registered, api } = makePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: process.cwd(),
      repoUrl: 'https://example.test/repo.git',
    })
    await factory(api)
    expect(registered).toEqual(
      expect.arrayContaining([
        'read_file',
        'search_code',
        'find_definitions',
        'find_usages',
        'get_call_graph',
        'get_impact',
        'get_commits',
        'get_file_history',
      ]),
    )
  })

  it('still registers all tools when indexerUrl is set', async () => {
    const { registered, api } = makePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: process.cwd(),
      repoUrl: 'https://example.test/repo.git',
      indexerUrl: 'http://localhost:8321',
    })
    await factory(api)
    expect(registered).toEqual(
      expect.arrayContaining([
        'read_file', 'search_code', 'find_definitions', 'find_usages',
        'get_call_graph', 'get_impact', 'get_commits', 'get_file_history',
      ]),
    )
  })
})
```

- [ ] **Step 3: Run test to verify failure**

Run: `npx vitest run src/review/__tests__/engine.test.ts`
Expected: FAIL — current code only registers `read_file` when `indexerUrl` is absent.

- [ ] **Step 4: Modify `pi-tools.ts` — replace early return with per-tool dispatch**

In `src/review/pi-tools.ts`, **remove** the `if (!resolved.indexerClient) return` line. For each indexer-backed tool, the `execute` chooses between indexer and fs handler.

Skeleton (apply to all five indexer-backed tools):

```ts
pi.registerTool({
  name: 'search_code',
  label: 'Search code',
  description: SEARCH_CODE_DESCRIPTION,
  parameters: Type.Object({
    query: Type.String({ description: 'Natural-language query or code identifier' }),
    limit: Type.Optional(Type.Number({ description: 'Maximum results (default: 10, max: 20)' })),
  }),
  execute: async (_toolCallId, params) => {
    const result = resolved.indexerClient
      ? await searchCodeIndexerHandler(params, resolved.indexerClient, resolved.repoUrl, resolved.branch)
      : await searchCodeFsHandler(params, resolved.repoRoot)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
  },
})
```

Add `resolveDefaultBase` and the two git-tool registrations:

```ts
async function resolveDefaultBase(repoRoot: string): Promise<string> {
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const r = await exec('git', ['rev-parse', '--verify', candidate], { cwd: repoRoot })
    if (r.exitCode === 0) {
      const mb = await exec('git', ['merge-base', 'HEAD', candidate], { cwd: repoRoot })
      if (mb.exitCode === 0) return mb.stdout.trim()
    }
  }
  return 'HEAD~20'
}

const defaultBase = await resolveDefaultBase(resolved.repoRoot)

pi.registerTool({
  name: 'get_commits',
  label: 'Get commits',
  description: 'List commits in the PR/MR branch with author and message. Defaults to merge-base..HEAD.',
  parameters: Type.Object({
    base: Type.Optional(Type.String()),
    head: Type.Optional(Type.String()),
    includeBody: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number()),
  }),
  execute: async (_toolCallId, params) => {
    const result = await getCommitsHandler(params, resolved.repoRoot, defaultBase)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
  },
})

pi.registerTool({
  name: 'get_file_history',
  label: 'Get file history',
  description: 'Recent commits that touched a specific file.',
  parameters: Type.Object({
    filePath: Type.String(),
    limit: Type.Optional(Type.Number()),
    includeBody: Type.Optional(Type.Boolean()),
  }),
  execute: async (_toolCallId, params) => {
    const result = await getFileHistoryHandler(params, resolved.repoRoot)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
  },
})
```

Also add a ripgrep-availability probe at the top of the factory. If `rg` is missing AND `indexerClient` is null, **skip** registering `search_code`, `find_definitions`, `find_usages`, `get_impact` (those need rg), and log a warning. `get_call_graph` is fine — its fs impl is a stub.

- [ ] **Step 5: Update `agentic-prompt.ts`**

Add `get_commits` and `get_file_history` to the tools list in `AGENTIC_SYSTEM_PROMPT`. Add a one-sentence note: *"Some tools (notably `get_call_graph` and `get_impact`) may return `available: false` or `isPartial: true` depending on whether a code index is loaded. Use the available data and `read_file` to fill in the gaps."*

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run src/review/__tests__/engine.test.ts`
Expected: PASS for both registration cases.

- [ ] **Step 7: Sub-agent test audit**

Dispatch `test-quality-auditor` on the engine.test.ts additions.

- [ ] **Step 8: Sub-agent code review**

Dispatch `feature-dev:code-reviewer` on the diff of `pi-tools.ts` + `agentic-prompt.ts` + `tools/index.ts`. Look for dispatch correctness, missing error handling when `rg` is absent, prompt clarity, no leftover references to renamed indexer files. Address Critical/High.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(review): dispatch agentic tools to fs/git fallbacks when indexer is absent"
```

---

## Task 10: Update `src/index.ts` and add ripgrep doctor probe

**Files:**
- Modify: `src/index.ts:779-794` (the indexer-status block in the agentic branch)
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/__tests__/doctor.test.ts`

- [ ] **Step 1: Write the failing doctor test**

Add a case to `src/cli/__tests__/doctor.test.ts` asserting the output includes a "ripgrep" row with `OK <version>` or `MISSING` plus an install hint URL.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/cli/__tests__/doctor.test.ts`
Expected: FAIL — no ripgrep row in current output.

- [ ] **Step 3: Add ripgrep probe to `doctor.ts`**

Use `commandExists('rg')` + `exec('rg', ['--version'])` to extract the first line. Render as: `ripgrep: OK (14.1.0)` or `ripgrep: MISSING — install https://github.com/BurntSushi/ripgrep#installation`.

- [ ] **Step 4: Update `src/index.ts` agentic branch**

Replace the lines around `src/index.ts:779-794` with:

```ts
if (options.agentic) {
  const indexerStatus = await getIndexerStatus()
  let indexerUrl: string | undefined
  if (indexerStatus.running && indexerStatus.apiUrl) {
    indexerUrl = indexerStatus.apiUrl
    logger.info('Agentic mode: indexer reachable — using indexer-backed search/definitions/usages/call-graph/impact tools')
  } else {
    const rgAvailable = await commandExists('rg')
    if (rgAvailable) {
      logger.info('Agentic mode: indexer not running — using filesystem-backed tools (ripgrep + git). read_file, search_code, find_definitions, find_usages, get_impact, get_commits, get_file_history active. get_call_graph degraded.')
    } else {
      logger.warn('Agentic mode: no indexer and no ripgrep — only read_file, get_commits, get_file_history will be active. Install ripgrep for full coverage.')
    }
  }
  // ... rest of existing flow ...
}
```

Make sure to import `commandExists` from `./utils/exec.js`.

- [ ] **Step 5: Run all tests**

Run: `bun run test`
Expected: all green.

- [ ] **Step 6: Sub-agent code review**

Dispatch `feature-dev:code-reviewer` on the `index.ts` and `doctor.ts` changes. Address Critical/High.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(cli): surface active agentic toolset; add ripgrep doctor probe"
```

---

## Task 11: `--ci` flag + CI mode helpers

**Files:**
- Create: `src/review/ci-mode.ts`
- Create: `src/review/__tests__/ci-mode.test.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing tests**

`src/review/__tests__/ci-mode.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  detectCiPlatform,
  extractPrNumber,
  resolveCiExitCode,
  buildCommentPayload,
} from '../ci-mode.js'

describe('detectCiPlatform', () => {
  it('detects GitHub Actions from GITHUB_ACTIONS=true', () => {
    expect(detectCiPlatform({ GITHUB_ACTIONS: 'true' } as any)).toBe('github')
  })
  it('detects GitLab CI from GITLAB_CI=true', () => {
    expect(detectCiPlatform({ GITLAB_CI: 'true' } as any)).toBe('gitlab')
  })
  it('returns null when neither is set', () => {
    expect(detectCiPlatform({} as any)).toBe(null)
  })
})

describe('extractPrNumber', () => {
  it('reads GITHUB_REF for pull_request events', () => {
    expect(extractPrNumber('github', { GITHUB_REF: 'refs/pull/42/merge' } as any)).toBe(42)
  })
  it('reads CI_MERGE_REQUEST_IID for GitLab', () => {
    expect(extractPrNumber('gitlab', { CI_MERGE_REQUEST_IID: '17' } as any)).toBe(17)
  })
  it('returns null when the env vars are missing', () => {
    expect(extractPrNumber('github', {} as any)).toBe(null)
  })
})

describe('resolveCiExitCode', () => {
  const review = (verdict: string, critical = 0, high = 0) => ({
    verdict,
    issuesByCount: { critical, high, medium: 0, low: 0 },
  })

  it('returns 0 on APPROVE regardless of fail-on', () => {
    expect(resolveCiExitCode(review('APPROVE', 0, 5), 'critical')).toBe(0)
  })
  it('returns 1 when fail-on=critical and there is a CRITICAL', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 1, 0), 'critical')).toBe(1)
  })
  it('returns 1 when fail-on=high and there is HIGH', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 0, 2), 'high')).toBe(1)
  })
  it('returns 0 when fail-on=none even with criticals', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 3, 0), 'none')).toBe(0)
  })
})

describe('buildCommentPayload', () => {
  it('wraps content with a sticky-comment marker so re-runs replace it', () => {
    const out = buildCommentPayload('## Review\n\nLGTM.')
    expect(out).toMatch(/<!-- kode-review:sticky -->/)
    expect(out).toContain('LGTM.')
  })
})

describe('replaceStickyComment', () => {
  // Tests inject a fake CiCommentRunner so we exercise the orchestration
  // (list → post-new → delete-old) without shelling out to gh/glab.

  function makeRunner(initial: Array<{ id: number; body: string }>) {
    const log: string[] = []
    return {
      log,
      runner: {
        list: async () => initial,
        post: async (body: string) => {
          log.push(`post:${body.slice(0, 32)}`)
          return { ok: true, id: 999 }
        },
        del: async (id: number) => {
          log.push(`delete:${id}`)
          return true
        },
      },
    }
  }

  const STICKY = '<!-- kode-review:sticky -->'

  it('posts new BEFORE deleting prior — never leaves the PR review-less', async () => {
    const { log, runner } = makeRunner([
      { id: 1, body: `${STICKY}\n\nold review` },
    ])
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew review`)
    expect(ok).toBe(true)
    expect(log[0]).toMatch(/^post:/)
    expect(log[1]).toBe('delete:1')
  })

  it('deletes all prior sticky comments, leaves non-sticky untouched', async () => {
    const { log, runner } = makeRunner([
      { id: 1, body: `${STICKY}\n\nold` },
      { id: 2, body: 'human comment' },
      { id: 3, body: `${STICKY}\n\nolder` },
    ])
    await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(log).toContain('delete:1')
    expect(log).toContain('delete:3')
    expect(log).not.toContain('delete:2')
  })

  it('returns false and skips deletion when posting the new comment fails', async () => {
    const log: string[] = []
    const runner = {
      list: async () => [{ id: 1, body: `${STICKY}\n\nold` }],
      post: async () => ({ ok: false }),
      del: async (id: number) => { log.push(`delete:${id}`); return true },
    }
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(ok).toBe(false)
    expect(log).toEqual([])
  })

  it('falls back to plain post when listing fails', async () => {
    const log: string[] = []
    const runner = {
      list: async () => { throw new Error('rate limited') },
      post: async (body: string) => { log.push(`post:${body.slice(0, 16)}`); return { ok: true, id: 7 } },
      del: async () => true,
    }
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(ok).toBe(true)
    expect(log[0]).toMatch(/^post:/)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/review/__tests__/ci-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/review/ci-mode.ts`**

```ts
/**
 * CI-mode helpers. The orchestration (replaceStickyComment) is exposed as a
 * pure function over a `CiCommentRunner` interface so it can be unit-tested
 * without shelling out. The platform-specific runners live in this file and
 * are the only code paths that actually invoke gh/glab.
 */

import { exec } from '../utils/exec.js'
import { logger } from '../utils/logger.js'

export type CiPlatform = 'github' | 'gitlab'

export interface ReviewSummary {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'NEEDS_DISCUSSION' | string
  issuesByCount: { critical: number; high: number; medium: number; low: number }
}

export type FailOn = 'critical' | 'high' | 'none'

export interface CiComment {
  id: number
  body: string
}

export interface CiCommentRunner {
  list(): Promise<CiComment[]>
  post(body: string): Promise<{ ok: boolean; id?: number }>
  del(commentId: number): Promise<boolean>
}

const STICKY_MARKER = '<!-- kode-review:sticky -->'

export function detectCiPlatform(env: NodeJS.ProcessEnv = process.env): CiPlatform | null {
  if (env.GITHUB_ACTIONS === 'true') return 'github'
  if (env.GITLAB_CI === 'true') return 'gitlab'
  return null
}

export function extractPrNumber(
  platform: CiPlatform,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (platform === 'github') {
    const ref = env.GITHUB_REF ?? ''
    const m = /^refs\/pull\/(\d+)\//.exec(ref)
    return m ? Number(m[1]) : null
  }
  const iid = env.CI_MERGE_REQUEST_IID
  return iid ? Number(iid) : null
}

export function resolveCiExitCode(summary: ReviewSummary, failOn: FailOn): number {
  if (failOn === 'none') return 0
  if (failOn === 'critical' && summary.issuesByCount.critical > 0) return 1
  if (failOn === 'high' && (summary.issuesByCount.critical > 0 || summary.issuesByCount.high > 0)) return 1
  return 0
}

export function buildCommentPayload(reviewMarkdown: string): string {
  return `${STICKY_MARKER}\n\n${reviewMarkdown}`
}

/**
 * Replace prior sticky comments with a new one.
 *
 * Order matters: post the new comment BEFORE deleting prior ones so a transient
 * failure never leaves the PR review-less.
 *
 * If listing fails (network/rate-limit), we fall back to plain post — better
 * to leave duplicate stickies than no review at all.
 */
export async function replaceStickyComment(
  runner: CiCommentRunner,
  _prNumber: number,
  payload: string,
): Promise<boolean> {
  let priors: CiComment[] = []
  try {
    priors = (await runner.list()).filter((c) => c.body.includes(STICKY_MARKER))
  } catch (err) {
    logger.warn(`Could not list prior comments — posting without sticky replacement: ${(err as Error).message}`)
    const r = await runner.post(payload)
    return r.ok
  }

  const posted = await runner.post(payload)
  if (!posted.ok) return false

  for (const c of priors) {
    const ok = await runner.del(c.id)
    if (!ok) logger.warn(`Failed to delete prior sticky comment #${c.id} — continuing.`)
  }
  return true
}

/**
 * GitHub runner — uses `gh api` for list/delete (needed to get comment IDs)
 * and `gh pr comment` for post.
 */
export function githubRunner(prNumber: number, repoRoot: string): CiCommentRunner {
  return {
    async list(): Promise<CiComment[]> {
      const r = await exec(
        'gh',
        ['api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--jq', '[.[] | {id, body}]'],
        { cwd: repoRoot },
      )
      if (r.exitCode !== 0) throw new Error(r.stderr || 'gh api list failed')
      return JSON.parse(r.stdout || '[]') as CiComment[]
    },
    async post(body: string) {
      const r = await exec('gh', ['pr', 'comment', String(prNumber), '--body', body], { cwd: repoRoot })
      return { ok: r.exitCode === 0 }
    },
    async del(commentId: number) {
      const r = await exec(
        'gh',
        ['api', '-X', 'DELETE', `repos/{owner}/{repo}/issues/comments/${commentId}`],
        { cwd: repoRoot },
      )
      return r.exitCode === 0
    },
  }
}

/**
 * GitLab runner — uses `glab api` for list/delete and `glab mr note` for post.
 */
export function gitlabRunner(prNumber: number, repoRoot: string): CiCommentRunner {
  return {
    async list(): Promise<CiComment[]> {
      const r = await exec(
        'glab',
        ['api', `projects/:id/merge_requests/${prNumber}/notes`],
        { cwd: repoRoot },
      )
      if (r.exitCode !== 0) throw new Error(r.stderr || 'glab api list failed')
      const raw = JSON.parse(r.stdout || '[]') as Array<{ id: number; body: string }>
      return raw.map((n) => ({ id: n.id, body: n.body }))
    },
    async post(body: string) {
      const r = await exec('glab', ['mr', 'note', String(prNumber), '--message', body], { cwd: repoRoot })
      return { ok: r.exitCode === 0 }
    },
    async del(commentId: number) {
      const r = await exec(
        'glab',
        ['api', '-X', 'DELETE', `projects/:id/merge_requests/${prNumber}/notes/${commentId}`],
        { cwd: repoRoot },
      )
      return r.exitCode === 0
    },
  }
}

/**
 * Convenience wrapper used by src/index.ts — chooses the right runner and
 * calls replaceStickyComment.
 */
export async function postCiComment(
  platform: CiPlatform,
  prNumber: number,
  payload: string,
  repoRoot: string,
): Promise<boolean> {
  const runner = platform === 'github' ? githubRunner(prNumber, repoRoot) : gitlabRunner(prNumber, repoRoot)
  return replaceStickyComment(runner, prNumber, payload)
}
```

- [ ] **Step 4: Add `--ci` and `--fail-on` to `args.ts`**

In `src/cli/args.ts`:
- Add `ci: boolean` and `failOn: 'critical' | 'high' | 'none'` to `CliOptions`.
- Register flags: `.option('--ci', 'CI mode: agentic + markdown + post to PR + non-zero exit on CRITICAL by default', false)` and `.option('--fail-on <level>', 'In CI mode, exit non-zero on this severity (critical|high|none)', 'critical')`.
- Validate `failOn` is one of the three values; throw a `BAD_FLAG` error otherwise.
- When `opts.ci` is true, defaults take effect ONLY when the user did not pass an explicit override: `agentic = true`, `quiet = true`, `format = 'markdown'`, `postToPr = true`.

- [ ] **Step 5: Wire CI flow in `src/index.ts`**

After the agentic review completes, when `options.ci`:
- Apply suppression filtering (Task 12) — gated on `!options.noSuppressions`. The filter runs **before** counting and posting so suppressed findings affect neither the exit code nor the PR comment.
- Parse the (filtered) markdown into a `ReviewSummary` (extract `Issues Summary: X CRITICAL, Y HIGH, Z MEDIUM, W LOW` and `RECOMMENDATION:` from the verdict block). Keep this parser ≤ 20 lines and place it inline; do not over-engineer.
- Compute `failOn` exit code via `resolveCiExitCode`.
- Resolve PR number from `--pr` first, then env via `extractPrNumber`.
- If a PR number is available, call `postCiComment` (which now does sticky replacement). On failure, log a warning and continue — never silently swallow.
- Call `process.exit(exitCode)` at the very end.

- [ ] **Step 6: Run tests to verify pass**

Run: `bun run test`
Expected: all green.

- [ ] **Step 7: Sub-agent test audit**

Dispatch `test-quality-auditor` on `ci-mode.test.ts`. Cover every branch of `resolveCiExitCode`, env-var detection on both platforms, sticky-marker assertion, **order-of-operations for `replaceStickyComment` (post-before-delete)**, list-failure fallback path, and post-failure short-circuit.

- [ ] **Step 8: Sub-agent code review**

Dispatch `feature-dev:code-reviewer` on `ci-mode.ts` + `args.ts` + `index.ts` changes. Look for argument-parsing correctness, exit-code semantics, env-access leaks outside `ci-mode.ts`, and especially the sticky-replacement orchestration (race conditions, partial-failure recovery).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(cli): add --ci mode with sticky PR-comment replacement and severity-based exit codes"
```

---

## Task 12: Suppression marker (`kode-review: ignore`)

**Why:** Lets developers silence specific findings inline without disabling the whole check. A magic comment in the source — `// kode-review: ignore` — drops any finding whose `file:line` reference points to that line (or the line immediately after). `// kode-review: ignore-file` suppresses every finding in the file.

Suppression is **always on by default**; `--no-suppressions` disables it (escape hatch for debugging).

**Files:**
- Create: `src/review/suppressions.ts`
- Create: `src/review/__tests__/suppressions.test.ts`
- Modify: `src/review/agentic-prompt.ts` (instruct the model to honor the marker — defense in depth)
- Modify: `src/cli/args.ts` (already noted: add `noSuppressions: boolean`)
- Modify: `src/index.ts` (wire the filter into both the agentic and CI flows)

### Marker grammar (exact)

- `kode-review: ignore` anywhere in a line → suppresses findings on **that line** AND on the line **immediately below it**. (Covers both "this line is fine" and "the line below is fine" idioms.)
- `kode-review: ignore-file` anywhere in any line of the file → suppresses every finding in that file.
- Marker matching is **case-sensitive** on the literal string `kode-review:` and **whitespace-tolerant** between the colon and the keyword (so `kode-review:  ignore` matches).
- Any comment syntax works (`//`, `#`, `--`, `/* ... */`, `<!-- ... -->`) — we only look for the literal string anywhere in the line, regardless of language.

### Filter behaviour

Input: raw review markdown + repo root.
Output: filtered markdown + updated counts + count of suppressed findings.

The filter:
1. Finds each issue block in the markdown (anchored on `**[SEVERITY: ...]**`).
2. Extracts the `File: <path>:<line>` reference from each block.
3. Reads the referenced file (gitignore + sensitive-path checks — reuse `readFileHandler` plumbing).
4. Drops the issue if the marker is present at `<line>`, `<line>-1`, or anywhere if the file has `ignore-file`.
5. Recomputes `Issues Summary: X CRITICAL, ...` and appends a *Suppressed: N findings* line under the verdict block.

If a file can't be read (was deleted, etc.), the finding is **kept** — never silently drop on error.

- [ ] **Step 1: Write the failing tests**

`src/review/__tests__/suppressions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasIgnoreMarker,
  hasIgnoreFileMarker,
  filterSuppressedFindings,
} from '../suppressions.js'

describe('hasIgnoreMarker', () => {
  it('matches // kode-review: ignore', () => {
    expect(hasIgnoreMarker('foo(); // kode-review: ignore')).toBe(true)
  })
  it('matches # kode-review: ignore (Python/shell)', () => {
    expect(hasIgnoreMarker('foo() # kode-review: ignore')).toBe(true)
  })
  it('tolerates extra whitespace after the colon', () => {
    expect(hasIgnoreMarker('// kode-review:   ignore')).toBe(true)
  })
  it('does not match arbitrary text containing the words', () => {
    expect(hasIgnoreMarker('we should kode-review and ignore')).toBe(false)
  })
  it('is case-sensitive on the keyword', () => {
    expect(hasIgnoreMarker('// Kode-Review: ignore')).toBe(false)
  })
})

describe('hasIgnoreFileMarker', () => {
  it('returns true when any line contains the file-level marker', () => {
    expect(hasIgnoreFileMarker('a\nb\n// kode-review: ignore-file\nc')).toBe(true)
  })
  it('returns false when only the line-level marker is present', () => {
    expect(hasIgnoreFileMarker('// kode-review: ignore\n')).toBe(false)
  })
})

describe('filterSuppressedFindings', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-supp-'))
    mkdirSync(join(repo, 'src'))
    // Lines:           1                        2                                 3      4
    writeFileSync(join(repo, 'src/a.ts'), 'export function foo() {\n  return 1; // kode-review: ignore\n}\nexport const x = 2;\n')
    // File-level suppression
    writeFileSync(join(repo, 'src/b.ts'), '// kode-review: ignore-file\nexport const y = 3;\n')
  })

  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  const md = (path: string, line: number, severity = 'CRITICAL') =>
    `**[SEVERITY: ${severity}]** - Cat: title\n\nFile: ${path}:${line}\n\nProblem:\nstuff\n\nConfidence: HIGH\n`

  it('drops findings on a line carrying the ignore marker', async () => {
    const input = md('src/a.ts', 2) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered, suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(1)
    expect(filtered).not.toContain('Cat: title')
    expect(summary.issuesByCount.critical).toBe(0)
  })

  it('drops findings on the line BELOW the ignore marker', async () => {
    const input = md('src/a.ts', 3) // line 3 is `}` immediately after the marker on line 2
      + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(1)
  })

  it('keeps findings on lines NOT next to the marker', async () => {
    const input = md('src/a.ts', 4) // line 4 is `export const x = 2;`
      + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(0)
    expect(summary.issuesByCount.critical).toBe(1)
  })

  it('drops every finding in a file with ignore-file', async () => {
    const input = md('src/b.ts', 2) + md('src/b.ts', 1, 'HIGH')
      + '\nIssues Summary: 1 CRITICAL, 1 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(2)
    expect(summary.issuesByCount.critical).toBe(0)
    expect(summary.issuesByCount.high).toBe(0)
  })

  it('keeps the finding when the referenced file cannot be read', async () => {
    const input = md('src/does-not-exist.ts', 1)
      + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(0)
  })

  it('appends a "Suppressed: N findings" line when N > 0', async () => {
    const input = md('src/a.ts', 2)
      + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered } = await filterSuppressedFindings(input, repo)
    expect(filtered).toMatch(/Suppressed: 1 finding/)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/review/__tests__/suppressions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/review/suppressions.ts`**

```ts
/**
 * Suppression filter: drops review findings whose source line is annotated
 * with a `kode-review: ignore` magic comment. Always-on; disable with
 * --no-suppressions.
 *
 * Marker grammar (case-sensitive on the keyword, whitespace-tolerant):
 *   <any-comment-syntax> kode-review: ignore         → suppresses this line AND the line below
 *   <any-comment-syntax> kode-review: ignore-file    → suppresses every finding in the file
 */

import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import type { ReviewSummary } from './ci-mode.js'

const IGNORE_RE = /kode-review:\s*ignore(?!-file)/
const IGNORE_FILE_RE = /kode-review:\s*ignore-file/
const ISSUE_BLOCK_RE = /\*\*\[SEVERITY:\s*(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*[\s\S]*?(?=\n\*\*\[SEVERITY|\n### |\nIssues Summary:|$)/g
const FILE_LINE_RE = /File:\s*([^\s:]+):(\d+)/
const ISSUES_SUMMARY_RE = /Issues Summary:\s*(\d+)\s*CRITICAL,\s*(\d+)\s*HIGH,\s*(\d+)\s*MEDIUM,\s*(\d+)\s*LOW/i
const VERDICT_RE = /RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/

export function hasIgnoreMarker(line: string): boolean {
  return IGNORE_RE.test(line)
}

export function hasIgnoreFileMarker(content: string): boolean {
  return IGNORE_FILE_RE.test(content)
}

export interface FilterResult {
  filtered: string
  suppressedCount: number
  summary: ReviewSummary
}

async function readFileSafe(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    const full = isAbsolute(relPath) ? relPath : join(repoRoot, relPath)
    return await readFile(full, 'utf-8')
  } catch {
    return null
  }
}

function shouldSuppress(content: string, line: number): boolean {
  if (hasIgnoreFileMarker(content)) return true
  const lines = content.split('\n')
  // 1-based line indexing. Marker on `line` suppresses `line`; marker on `line-1`
  // suppresses `line` (next-line idiom).
  const here = lines[line - 1] ?? ''
  const above = lines[line - 2] ?? ''
  return hasIgnoreMarker(here) || hasIgnoreMarker(above)
}

function countIssue(severity: string, counts: ReviewSummary['issuesByCount']): void {
  const s = severity.toLowerCase() as keyof ReviewSummary['issuesByCount']
  if (s in counts) counts[s] -= 1
}

export async function filterSuppressedFindings(
  reviewMarkdown: string,
  repoRoot: string,
): Promise<FilterResult> {
  const summaryMatch = ISSUES_SUMMARY_RE.exec(reviewMarkdown)
  const counts = {
    critical: summaryMatch ? Number(summaryMatch[1]) : 0,
    high: summaryMatch ? Number(summaryMatch[2]) : 0,
    medium: summaryMatch ? Number(summaryMatch[3]) : 0,
    low: summaryMatch ? Number(summaryMatch[4]) : 0,
  }
  const verdictMatch = VERDICT_RE.exec(reviewMarkdown)
  const verdict = verdictMatch?.[1] ?? 'NEEDS_DISCUSSION'

  let suppressedCount = 0
  const dropped: string[] = []

  // Walk each finding block in order.
  for (const block of reviewMarkdown.match(ISSUE_BLOCK_RE) ?? []) {
    const severityMatch = /\*\*\[SEVERITY:\s*(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/.exec(block)
    const fileLineMatch = FILE_LINE_RE.exec(block)
    if (!severityMatch || !fileLineMatch) continue
    const [, severity] = severityMatch
    const path = fileLineMatch[1]
    const line = Number(fileLineMatch[2])
    const fileContent = await readFileSafe(repoRoot, path)
    if (fileContent && shouldSuppress(fileContent, line)) {
      dropped.push(block)
      countIssue(severity, counts)
      suppressedCount += 1
    }
  }

  let filtered = reviewMarkdown
  for (const block of dropped) {
    filtered = filtered.replace(block, '')
  }

  // Rewrite the Issues Summary line.
  if (summaryMatch) {
    filtered = filtered.replace(
      ISSUES_SUMMARY_RE,
      `Issues Summary: ${counts.critical} CRITICAL, ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW`,
    )
  }

  if (suppressedCount > 0) {
    const noun = suppressedCount === 1 ? 'finding' : 'findings'
    filtered = filtered.trimEnd() + `\n\nSuppressed: ${suppressedCount} ${noun} via \`kode-review: ignore\` markers.\n`
  }

  return {
    filtered,
    suppressedCount,
    summary: { verdict, issuesByCount: counts },
  }
}
```

- [ ] **Step 4: Update `agentic-prompt.ts` to instruct the model**

Append to `AGENTIC_SYSTEM_PROMPT`:

```text
## Suppression markers

If a line contains `kode-review: ignore` (in any comment style — `//`, `#`, etc.),
do NOT report findings on that line or the line immediately below it.
If any line in a file contains `kode-review: ignore-file`, do NOT report any
findings in that file. These markers are the developer's explicit signal that
the issue is known and accepted.

(The CLI also post-filters findings using these markers as a backstop, but
honoring them in your output keeps the review cleaner.)
```

This is defense-in-depth: the post-filter is authoritative, but having the model honor the marker reduces wasted tokens.

- [ ] **Step 5: Add `--no-suppressions` to `args.ts`**

In `src/cli/args.ts`:
- Add `noSuppressions: boolean` to `CliOptions`.
- Register flag: `.option('--no-suppressions', 'Disable kode-review: ignore markers in the source — report every finding', false)`.

(Note: Commander auto-handles the `--no-` prefix as a boolean inverter; the resulting field on `opts` will be `opts.suppressions` (true by default). Convert to `noSuppressions = !opts.suppressions` when populating `CliOptions` for consistency with other negative flags in the file.)

- [ ] **Step 6: Wire into `src/index.ts`**

Immediately after the agentic review returns its content, **before** parsing the verdict or posting the CI comment:

```ts
let reviewContent = result.content
if (!options.noSuppressions) {
  const { filtered, suppressedCount } = await filterSuppressedFindings(reviewContent, repoRoot!)
  reviewContent = filtered
  if (suppressedCount > 0) {
    logger.info(`Suppressed ${suppressedCount} finding(s) via kode-review: ignore markers`)
  }
}
```

Then `processReviewOutput(reviewContent, ...)` and the CI-mode summary-parse + comment-post both operate on `reviewContent` (the filtered output).

- [ ] **Step 7: Run tests to verify pass**

Run: `bun run test`
Expected: all green, including the new suppressions tests.

- [ ] **Step 8: Sub-agent test audit**

Dispatch `test-quality-auditor` on `suppressions.test.ts`. Verify: real files (not mocked fs), every marker form covered, edge cases (file deleted, marker on the last line, marker with extra whitespace), summary-line rewrite verified.

- [ ] **Step 9: Sub-agent code review**

Dispatch `feature-dev:code-reviewer` on `suppressions.ts` + the `index.ts` wiring + the prompt change. Look for: regex correctness (especially the `(?!-file)` negative lookahead on `IGNORE_RE`), path-traversal risk in `readFileSafe`, off-by-one on line indexing, missed counts when the verdict line is absent.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(review): add kode-review: ignore suppression markers (line + file scope)"
```

---

## Task 13: Example CI workflow files

**Files:**
- Create: `docs/ci-examples/github-actions.yml`
- Create: `docs/ci-examples/gitlab-ci.yml`
- Create: `docs/ci-examples/README.md`

- [ ] **Step 1: Write `docs/ci-examples/github-actions.yml`**

```yaml
# .github/workflows/kode-review.yml
#
# Run kode-review on every PR. Posts the review as a PR comment and fails
# the check when CRITICAL issues are found.
#
# Required secrets:
#   ANTHROPIC_API_KEY  (or whichever provider you've configured in pi)
# Built-in token used:
#   GITHUB_TOKEN       (auto-provided by Actions; lets gh post comments)

name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Full history so kode-review can resolve merge-base and read commits.
          fetch-depth: 0
          # Use the PR's head commit, not the merge ref — the review applies
          # to the source as the author wrote it.
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # ripgrep is preinstalled on ubuntu-latest; this is a safety net.
      - name: Ensure ripgrep is installed
        run: which rg || sudo apt-get install -y ripgrep

      - name: Install kode-review
        run: npm install -g @kofikode/kode-review-cli

      - name: Run review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: kode-review --ci --pr ${{ github.event.pull_request.number }} --fail-on critical
```

- [ ] **Step 2: Write `docs/ci-examples/gitlab-ci.yml`**

```yaml
# .gitlab-ci.yml fragment for kode-review on every MR.
#
# Required CI variables (Project → Settings → CI/CD → Variables):
#   ANTHROPIC_API_KEY   (masked, not protected so it works on MR pipelines)
#   GITLAB_TOKEN        (personal access token with `api` scope, used by glab)

ai_code_review:
  stage: test
  image: node:20-bookworm
  variables:
    # Full history — GitLab CI defaults to shallow.
    GIT_DEPTH: 0
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - apt-get update && apt-get install -y ripgrep git
    - curl -sL https://gitlab.com/gitlab-org/cli/-/releases/permalink/latest/downloads/glab_linux_amd64.deb -o /tmp/glab.deb
    - dpkg -i /tmp/glab.deb
    - glab auth login --token "$GITLAB_TOKEN" --hostname gitlab.com
    - npm install -g @kofikode/kode-review-cli
  script:
    - kode-review --ci --pr "$CI_MERGE_REQUEST_IID" --fail-on critical
  allow_failure: false
```

- [ ] **Step 3: Write `docs/ci-examples/README.md`**

```markdown
# CI examples

These are starting points. Copy whichever file matches your platform into your
repository and adjust the model/provider env vars to match your pi config.

## What `--ci` does

`--ci` bundles:

- `--agentic` (multi-step review with tools)
- `--quiet` (no spinner, machine-friendly stdout)
- `--format markdown`
- `--post-to-pr` (uses `gh`/`glab` to post a comment)
- `--fail-on critical` (default; exit non-zero when CRITICAL findings exist)

The indexer is **not required** in CI mode — agentic tools fall back to
ripgrep + git.

## Checking out the right ref

- **GitHub Actions:** the default `actions/checkout@v4` step uses the *merge ref*
  on `pull_request` events. Override to `github.event.pull_request.head.sha` so
  the review applies to the source as the author wrote it. `fetch-depth: 0`
  is required for commit-message tools.

- **GitLab CI:** source is auto-checked-out on `merge_request_event`, but
  shallow by default. Set `GIT_DEPTH: 0` to enable commit-message tools.

## Permissions

- **GitHub:** the job needs `permissions: pull-requests: write` so `gh` can
  post and delete comments using the built-in `GITHUB_TOKEN`. Sticky-comment
  replacement requires both write and delete on issue comments.
- **GitLab:** create a project-level access token with `api` scope and store
  it as the `GITLAB_TOKEN` CI variable.

## Sticky comments

Each `--ci` run posts a single comment and deletes any prior comments tagged
with `<!-- kode-review:sticky -->`. The new comment is posted *before* the
old one is deleted, so the PR is never briefly left without a current
review. Human comments on the PR are never touched.

## Suppressing specific findings

Inline magic comment in source code:

```ts
const password = '...'; // kode-review: ignore
```

Suppresses any finding on the same line **or the line immediately below**.
Works in any language — we only look for the literal string `kode-review:
ignore`, regardless of the comment syntax (`//`, `#`, `--`, `<!-- -->`, etc.).

File-level suppression — drops every finding in the file:

```ts
// kode-review: ignore-file
```

To disable suppression handling and see every finding the model produced,
pass `--no-suppressions` (useful for debugging false positives in the
filter itself).
```

- [ ] **Step 4: Commit**

```bash
git add docs/ci-examples/
git commit -m "docs: add GitHub Actions + GitLab CI example workflows for --ci mode"
```

---

## Task 14: Update `docs/acceptance-tests.json` with new use cases

**Why:** Project policy is that user-visible feature work updates the canonical acceptance-test spec. This task adds eight new use cases covering everything shipped in Tasks 1–13.

**Files:**
- Modify: `docs/acceptance-tests.json`

- [ ] **Step 1: Append new use cases**

Open `docs/acceptance-tests.json` and append the following entries to the `use_cases` array (preserve JSON validity — comma after the existing last entry).

```json
{
  "id": "AC-15",
  "title": "ripgrep wrapper parses --json output",
  "description": "The ripgrep wrapper (src/review/tools/ripgrep.ts) shells out via the project's exec helper and produces typed matches the fs tools rely on.",
  "impacted_modules": ["src/review/tools/ripgrep.ts"],
  "acceptance_criteria": [
    "parseRipgrepJsonOutput extracts {path, line, text, matchText, column} for type=match events; column is 1-based.",
    "parseRipgrepJsonOutput ignores type=begin, type=end, type=summary, type=context events.",
    "parseRipgrepJsonOutput returns [] for empty input.",
    "parseRipgrepJsonOutput throws an Error containing 'parse' (case-insensitive) when given malformed JSON.",
    "ripgrepSearch passes -F by default, -w when wholeWord=true, --type T when type='T', and -g for each entry of globs[].",
    "ripgrepSearch treats rg exit code 1 (no matches) as success and returns [].",
    "ripgrepSearch throws a clear error mentioning ripgrep and the install URL when rg is not on PATH.",
    "ripgrepSearch caps results at maxResults (default 200) after parsing."
  ]
},
{
  "id": "AC-16",
  "title": "git-helpers wrap log and merge-base",
  "description": "src/review/tools/git-helpers.ts provides typed wrappers used by the agentic git tools and the dispatch layer.",
  "impacted_modules": ["src/review/tools/git-helpers.ts"],
  "acceptance_criteria": [
    "getCommitsInRange(repo, base, head) returns commits newest-first with {sha, shortSha, author, authorEmail, timestamp, subject} populated; sha is 40 hex chars.",
    "getCommitsInRange includes a populated `body` field iff options.includeBody is true.",
    "getCommitsInRange honours options.limit (default 50).",
    "getCommitsInRange returns [] for an empty range (e.g. HEAD..HEAD).",
    "getFileHistory(repo, path) returns commits that touched the named path, newest-first, capped at options.limit (default 10).",
    "getMergeBase(repo, refA, refB) returns the 40-char SHA of the merge-base; throws when either ref is invalid."
  ]
},
{
  "id": "AC-17",
  "title": "Filesystem-backed agentic tools mirror indexer output shapes",
  "description": "Each fs-backed handler (search_code, find_definitions, find_usages, get_impact, get_call_graph) returns the same TypeScript output shape as its indexer counterpart so the dispatcher and the prompt do not branch on availability.",
  "impacted_modules": [
    "src/review/tools/search-code-fs.ts",
    "src/review/tools/find-definitions-fs.ts",
    "src/review/tools/find-usages-fs.ts",
    "src/review/tools/get-impact-fs.ts",
    "src/review/tools/get-call-graph-fs.ts"
  ],
  "acceptance_criteria": [
    "searchCodeFsHandler({query}) returns SearchCodeOutput with results[].matchTypes === ['lexical'] and results.length <= 20 (MAX_LIMIT).",
    "searchCodeFsHandler returns {results: [], totalMatches: 0} for queries with no matches; does not throw.",
    "findDefinitionsFsHandler locates TypeScript `function`, `class`, `const`, and `interface` definitions; locates Python `def` and `class`.",
    "findDefinitionsFsHandler returns {definitions: [], totalCount: 0} for unknown symbols; does not throw.",
    "findUsagesFsHandler returns matches but excludes the line containing the definition keyword (function|class|def|fn|...).",
    "findUsagesFsHandler uses whole-word matching (rg -w) so substrings of larger identifiers are not matched.",
    "getImpactFsHandler resolves direct importers via ESM `from '...'`, CommonJS `require('...')`, and Python `from X import` patterns; sets isPartial=true and indirectImporters=[].",
    "getImpactFsHandler sets isHighImpact=true iff directImporters.length >= 5.",
    "getCallGraphFsHandler returns {callers: [], callees: [], available: false, reason: string} preserving the indexer schema."
  ]
},
{
  "id": "AC-18",
  "title": "get_commits and get_file_history tools",
  "description": "Two new always-on agentic tools that expose git commit metadata to the model.",
  "impacted_modules": [
    "src/review/tools/get-commits.ts",
    "src/review/tools/get-file-history.ts"
  ],
  "acceptance_criteria": [
    "getCommitsHandler({}) uses the resolved defaultBase (merge-base with origin/HEAD or origin/main or origin/master, falling back to HEAD~20) as base, and HEAD as head.",
    "getCommitsHandler honours input.base / input.head when provided.",
    "getCommitsHandler caps results at limit=100 (MAX_LIMIT) and defaults to 20.",
    "getCommitsHandler includes commit bodies iff includeBody=true.",
    "getFileHistoryHandler returns only commits that touched the named filePath, newest-first, capped at limit=50 (MAX_LIMIT, default 10).",
    "Both handlers produce the documented Output shapes ({commits: CommitInfo[], totalCount: number, ...}) with no extra fields."
  ]
},
{
  "id": "AC-19",
  "title": "Agentic dispatch routes per tool based on indexer + ripgrep availability",
  "description": "The agentic tool factory (src/review/pi-tools.ts) registers tools per the table below. Replaces AC-05 behaviour for the indexer-missing case.",
  "impacted_modules": ["src/review/pi-tools.ts", "src/review/agentic-prompt.ts"],
  "acceptance_criteria": [
    "When indexerUrl is set, exactly 8 tools are registered: read_file, search_code, find_definitions, find_usages, get_call_graph, get_impact, get_commits, get_file_history. The five indexer-backed tools route to their *-indexer handlers.",
    "When indexerUrl is undefined AND rg is on PATH, the same 8 tools are registered. search_code, find_definitions, find_usages, get_impact route to their *-fs handlers. get_call_graph routes to the fs stub.",
    "When indexerUrl is undefined AND rg is NOT on PATH, only read_file, get_call_graph (stub), get_commits, get_file_history are registered. A warning is logged naming ripgrep.",
    "AGENTIC_SYSTEM_PROMPT lists get_commits and get_file_history alongside the original six tools, and explicitly notes that get_call_graph / get_impact may return available:false or isPartial:true.",
    "resolveDefaultBase tries origin/HEAD, then origin/main, then origin/master, falling back to HEAD~20 — the chosen base is the merge-base of HEAD and the first reachable candidate.",
    "Each registered tool's execute() JSON-stringifies the handler output into content[0].text — no shape change vs. existing tools."
  ]
},
{
  "id": "AC-20",
  "title": "--ci flag and ci-mode helpers",
  "description": "src/cli/args.ts adds --ci and --fail-on. src/review/ci-mode.ts owns CI-specific logic: platform detection, PR-number resolution, exit-code policy, sticky comment posting.",
  "impacted_modules": ["src/cli/args.ts", "src/review/ci-mode.ts", "src/index.ts"],
  "acceptance_criteria": [
    "--ci defaults the user's options to agentic=true, quiet=true, format='markdown', postToPr=true ONLY when those flags were not passed explicitly.",
    "--fail-on accepts exactly 'critical' | 'high' | 'none'; any other value throws a BAD_FLAG-style error mentioning the allowed values.",
    "detectCiPlatform returns 'github' iff env.GITHUB_ACTIONS === 'true'; 'gitlab' iff env.GITLAB_CI === 'true'; null otherwise.",
    "extractPrNumber('github', env) reads /^refs\\/pull\\/(\\d+)\\// from env.GITHUB_REF; returns null when unset or non-matching.",
    "extractPrNumber('gitlab', env) reads env.CI_MERGE_REQUEST_IID as a number; returns null when unset.",
    "resolveCiExitCode returns 0 when verdict is APPROVE regardless of fail-on; 0 when fail-on='none' regardless of counts; 1 when fail-on='critical' and critical > 0; 1 when fail-on='high' and (critical > 0 OR high > 0).",
    "buildCommentPayload prefixes the markdown with the literal sticky marker '<!-- kode-review:sticky -->' on its own line.",
    "postCiComment routes to githubRunner or gitlabRunner and delegates orchestration to replaceStickyComment.",
    "When --ci is set and a PR number is resolvable (--pr or env), the CLI posts the comment; on post failure the CLI logs a warning and continues — it does not swallow the error silently and does not abort the process before exiting with the verdict-derived code."
  ]
},
{
  "id": "AC-21",
  "title": "Sticky comment replacement on PR/MR",
  "description": "replaceStickyComment lists prior comments, identifies the ones bearing the sticky marker, posts the new comment, then deletes the priors. The orchestration is exercised against a fake CiCommentRunner.",
  "impacted_modules": ["src/review/ci-mode.ts"],
  "acceptance_criteria": [
    "replaceStickyComment posts the new comment BEFORE deleting any prior comments — the PR is never left without a current review.",
    "replaceStickyComment deletes ALL prior comments whose body contains '<!-- kode-review:sticky -->'.",
    "replaceStickyComment does NOT delete comments that lack the sticky marker (human comments are preserved).",
    "When the new-comment post fails, replaceStickyComment returns false and performs no deletions.",
    "When listing prior comments throws (e.g., rate-limit), replaceStickyComment falls back to plain post and logs a warning — the new comment is still created.",
    "When a delete fails after the post succeeded, replaceStickyComment logs a warning and returns true — partial success is reported, not retried in v1.",
    "githubRunner.list uses `gh api --paginate repos/{owner}/{repo}/issues/<pr>/comments` and selects {id, body} via --jq.",
    "githubRunner.del uses `gh api -X DELETE repos/{owner}/{repo}/issues/comments/<id>`.",
    "gitlabRunner.list uses `glab api projects/:id/merge_requests/<iid>/notes`.",
    "gitlabRunner.del uses `glab api -X DELETE projects/:id/merge_requests/<iid>/notes/<id>`."
  ]
},
{
  "id": "AC-22",
  "title": "kode-review: ignore suppression markers",
  "description": "Source-level magic comments tell the review to drop specific findings. The filter runs after the model returns and before the exit-code and PR-comment posting use the result. Disabled via --no-suppressions.",
  "impacted_modules": ["src/review/suppressions.ts", "src/review/agentic-prompt.ts", "src/cli/args.ts", "src/index.ts"],
  "acceptance_criteria": [
    "hasIgnoreMarker returns true for lines containing 'kode-review: ignore' in any comment syntax (//, #, --, /* */, <!-- -->).",
    "hasIgnoreMarker is whitespace-tolerant between the colon and the keyword ('kode-review:   ignore' matches).",
    "hasIgnoreMarker is case-sensitive on the keyword — 'Kode-Review: ignore' does NOT match.",
    "hasIgnoreMarker does NOT match 'kode-review: ignore-file' (that is the file-level marker, distinct).",
    "hasIgnoreFileMarker returns true when any line in the file contains 'kode-review: ignore-file'.",
    "filterSuppressedFindings drops a finding when the referenced line carries the ignore marker.",
    "filterSuppressedFindings drops a finding when the line IMMEDIATELY ABOVE the referenced line carries the ignore marker (next-line idiom).",
    "filterSuppressedFindings drops every finding in a file containing the ignore-file marker.",
    "filterSuppressedFindings keeps findings when the referenced file cannot be read (deleted, permission denied) — never silently drop on error.",
    "filterSuppressedFindings rewrites the 'Issues Summary: X CRITICAL, Y HIGH, ...' line to reflect the new counts.",
    "filterSuppressedFindings appends a 'Suppressed: N finding(s) via `kode-review: ignore` markers.' footer when N > 0.",
    "The CLI runs the filter ONLY when options.noSuppressions is false (default). With --no-suppressions, the raw review output is used unchanged.",
    "The CLI runs the filter BEFORE counting severities and posting the comment — suppressed findings affect neither the exit code nor the PR comment.",
    "AGENTIC_SYSTEM_PROMPT instructs the model to honor 'kode-review: ignore' and 'kode-review: ignore-file' markers so suppressed findings ideally never appear in the first place (defense-in-depth)."
  ]
}
```

- [ ] **Step 2: Validate the JSON**

Run: `python3 -c "import json; json.load(open('docs/acceptance-tests.json'))"`
Expected: no output (success). Any error means the comma placement is wrong.

- [ ] **Step 3: Commit**

```bash
git add docs/acceptance-tests.json
git commit -m "docs(acceptance-tests): add AC-15..AC-22 for fs tools, CI mode, sticky comments, suppressions"
```

---

## Task 15: README + final verification

**Files:**
- Modify: `README.md`
- Run: full verification suite

- [ ] **Step 1: Update README**

Add a "CI usage" subsection under existing usage docs pointing at `docs/ci-examples/README.md` with: *"kode-review supports running in GitHub Actions and GitLab CI via `--ci`. See `docs/ci-examples/` for ready-to-copy workflow files."*

Add to the agentic-tools table (or create one if absent) rows for `get_commits` and `get_file_history`.

Add a paragraph noting that agentic mode now works without the indexer: indexer-backed tools transparently fall back to filesystem (ripgrep) + git equivalents, with `get_call_graph` and `get_impact` degraded.

- [ ] **Step 2: Run the full local verification**

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

All four must pass.

- [ ] **Step 3: Smoke-test the CLI end-to-end (Step 7 user exercise)**

In the repository's own checkout, with **no indexer running**:

```bash
node dist/index.js --agentic --scope local --quiet --format markdown > /tmp/review.md
echo "Exit: $?"
cat /tmp/review.md
```

Expected: a real review document, no crashes, mentions of changed files, tool-call count > 0.

Then test the CI surface locally:

```bash
node dist/index.js --ci --pr 42 --fail-on critical 2>&1 | tail -50
```

Expected: review prints, `gh` may warn about no such PR (acceptable in this smoke test), exit code reflects verdict.

- [ ] **Step 4: Sub-agent code review of the full diff**

Dispatch `feature-dev:code-reviewer` on the full branch diff (`git diff master...HEAD`). Categorise Critical / High / Medium / Low. Address Critical/High; defer or fix Medium/Low.

- [ ] **Step 5: Commit + open PR**

```bash
git add README.md
git commit -m "docs(readme): document agentic fs-tool fallbacks and CI mode"
git push -u origin <branch-name>
gh pr create --fill
```

- [ ] **Step 6: Report**

Output the Step 5/7/8/9 summary block per CLAUDE.md:

```
Step 5 (test audit):     PASS — <auditor agent ids per task>
Step 7 (user exercise):  PASS — CLI driven against this repo, agentic mode with and without indexer
Step 8 (code review):    PASS — <reviewer agent id for full-diff review>
Step 9 (verify):         lint ✓, typecheck ✓, test ✓, build ✓
```

---

## Out of scope (deliberate)

These came up in design discussion but are deferred so v1 stays focused:

- **Indexer caching in CI** (e.g., GHA cache of the pgvector volume). The fs fallback covers the 80% case; indexer-in-CI is an optimisation layer.
- **GitHub `::error::` annotations** for inline findings — needs file:line resolution per issue and a structured-output mode from the model. The sticky PR comment already gives developers everything they need to act.
- **Diff-less full-tree audit mode.** Distinct feature ("review this whole codebase, no diff to anchor on"); spec separately.
- **Auto-checkout of PR head** by kode-review itself. CI runners already do this; for local PR review, users can `gh pr checkout` first.
- **Rule-level suppression** (e.g., `kode-review: ignore[security-injection]`). v1 ships the line/file marker only; per-rule IDs require the review output to carry stable rule identifiers, which it does not yet.
- **`@kode-review` reply interaction.** No comment-trigger / iteration loop in v1 — re-running CI produces a fresh review.

---

## Self-review notes

- Every step has concrete code or an exact command — no "TBD" / "similar to Task N" / "add error handling" placeholders.
- All renames go via `git mv` so history is preserved.
- Test audits use `test-quality-auditor` per Step 5 of the global engineering standards.
- Code reviews use `feature-dev:code-reviewer` per Step 8.
- Final summary block (Task 15 Step 6) is the required Step 10 report.
- Cross-task type names verified consistent: `SearchCodeOutput`, `FindDefinitionsOutput`, `FindUsagesOutput`, `GetImpactFsOutput`, `GetCommitsOutput`, `GetFileHistoryOutput`, `CommitInfo`, `RipgrepMatch`, `ReviewSummary`, `CiPlatform`, `FailOn`.
- Each task is committable on its own; renames + barrel updates land in the same commit as the new file so the build/tests stay green throughout.
- Acceptance-test ids AC-15 through AC-22 follow the existing convention; AC-19 explicitly notes that it supersedes AC-05's "Without indexerUrl, only read_file is registered" criterion. AC-21 covers sticky replacement; AC-22 covers suppression markers.
