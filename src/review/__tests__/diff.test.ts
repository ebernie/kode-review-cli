import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'

import { formatChanges, getChangesSummary, getLocalChanges, hasChanges, type LocalChanges } from '../diff.js'

// process.chdir is a process-wide side effect. This file is safe because
// vitest runs each test file in its own worker (default pool: 'forks' or
// 'threads'), and within this file tests run serially. If the project ever
// switches to a shared-process pool, these tests must be revisited.

// ── Pure formatters ───────────────────────────────────────────────────────

const EMPTY: LocalChanges = { staged: '', unstaged: '', stagedFiles: [], unstagedFiles: [] }

describe('hasChanges', () => {
  it('false for an empty LocalChanges', () => {
    expect(hasChanges(EMPTY)).toBe(false)
  })

  it('true when staged is non-empty', () => {
    expect(hasChanges({ ...EMPTY, staged: 'diff' })).toBe(true)
  })

  it('true when unstaged is non-empty', () => {
    expect(hasChanges({ ...EMPTY, unstaged: 'diff' })).toBe(true)
  })

  it('true when both are non-empty', () => {
    expect(hasChanges({ ...EMPTY, staged: 'a', unstaged: 'b' })).toBe(true)
  })

  it('false when only the file-name lists are populated but diffs are empty', () => {
    // Defensive: hasChanges inspects diff strings, not file-name lists.
    expect(hasChanges({ ...EMPTY, stagedFiles: ['x'], unstagedFiles: ['y'] })).toBe(false)
  })
})

describe('formatChanges', () => {
  it('returns empty string for empty input', () => {
    expect(formatChanges(EMPTY)).toBe('')
  })

  it('renders a STAGED CHANGES section when staged is set', () => {
    const out = formatChanges({ ...EMPTY, staged: '+a\n-b' })
    expect(out).toContain('=== STAGED CHANGES ===')
    expect(out).toContain('+a\n-b')
    // Tighten to the full section header (matching the symmetric assertion
    // on the next test) so a diff payload that happens to contain the word
    // "UNSTAGED" can't false-fail.
    expect(out).not.toContain('=== UNSTAGED CHANGES ===')
  })

  it('renders an UNSTAGED CHANGES section when unstaged is set', () => {
    const out = formatChanges({ ...EMPTY, unstaged: '+c' })
    expect(out).toContain('=== UNSTAGED CHANGES ===')
    expect(out).toContain('+c')
    expect(out).not.toContain('=== STAGED CHANGES ===')
  })

  it('renders BOTH sections in staged-then-unstaged order when both are set', () => {
    const out = formatChanges({ ...EMPTY, staged: 'S', unstaged: 'U' })
    const sIdx = out.indexOf('=== STAGED CHANGES ===')
    const uIdx = out.indexOf('=== UNSTAGED CHANGES ===')
    expect(sIdx).toBeGreaterThan(-1)
    expect(uIdx).toBeGreaterThan(-1)
    expect(sIdx).toBeLessThan(uIdx)
  })
})

describe('getChangesSummary', () => {
  it('returns empty string when both file lists are empty', () => {
    expect(getChangesSummary(EMPTY)).toBe('')
  })

  it('lists staged files under a "Staged files:" header', () => {
    const out = getChangesSummary({ ...EMPTY, stagedFiles: ['M\tsrc/a.ts', 'A\tsrc/b.ts'] })
    expect(out).toContain('Staged files:')
    expect(out).toContain('M\tsrc/a.ts')
    expect(out).toContain('A\tsrc/b.ts')
    expect(out).not.toContain('Unstaged files:')
  })

  it('lists unstaged files under an "Unstaged files:" header', () => {
    const out = getChangesSummary({ ...EMPTY, unstagedFiles: ['M\tsrc/c.ts'] })
    expect(out).toContain('Unstaged files:')
    expect(out).toContain('M\tsrc/c.ts')
    expect(out).not.toContain('Staged files:')
  })

  it('lists both sections when both are populated, staged first', () => {
    const out = getChangesSummary({
      ...EMPTY,
      stagedFiles: ['M\ta'],
      unstagedFiles: ['M\tb'],
    })
    const sIdx = out.indexOf('Staged files:')
    const uIdx = out.indexOf('Unstaged files:')
    expect(sIdx).toBeGreaterThan(-1)
    expect(uIdx).toBeGreaterThan(-1)
    expect(sIdx).toBeLessThan(uIdx)
  })
})

// ── getLocalChanges (integration with a tmp git repo) ─────────────────────

describe('getLocalChanges (integration)', () => {
  let repoRoot: string
  let origCwd: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'kode-diff-test-'))
    await execa('git', ['init', '-q'], { cwd: repoRoot })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'base.ts'), 'export const v = 0\n')
    await execa('git', ['add', '.'], { cwd: repoRoot })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot })
    origCwd = process.cwd()
    process.chdir(repoRoot)
  })

  afterEach(async () => {
    process.chdir(origCwd)
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('returns all-empty LocalChanges when the working tree is clean', async () => {
    const c = await getLocalChanges()
    expect(c.staged).toBe('')
    expect(c.unstaged).toBe('')
    expect(c.stagedFiles).toEqual([])
    expect(c.unstagedFiles).toEqual([])
  })

  it('captures an unstaged modification in unstaged + unstagedFiles, leaves staged empty', async () => {
    await writeFile(join(repoRoot, 'base.ts'), 'export const v = 1\n')
    const c = await getLocalChanges()
    expect(c.staged).toBe('')
    expect(c.unstaged).toContain('-export const v = 0')
    expect(c.unstaged).toContain('+export const v = 1')
    expect(c.stagedFiles).toEqual([])
    expect(c.unstagedFiles).toEqual(['M\tbase.ts'])
  })

  it('captures a staged modification in staged + stagedFiles, leaves unstaged empty', async () => {
    await writeFile(join(repoRoot, 'base.ts'), 'export const v = 2\n')
    await execa('git', ['add', 'base.ts'], { cwd: repoRoot })
    const c = await getLocalChanges()
    expect(c.staged).toContain('+export const v = 2')
    expect(c.unstaged).toBe('')
    expect(c.stagedFiles).toEqual(['M\tbase.ts'])
    expect(c.unstagedFiles).toEqual([])
  })

  it('captures both axes simultaneously when one file is staged then modified again', async () => {
    await writeFile(join(repoRoot, 'base.ts'), 'export const v = 9\n')
    await execa('git', ['add', 'base.ts'], { cwd: repoRoot })
    // Modify after staging — `git diff` (unstaged) now shows the delta from
    // the staged version (v=9) to the working tree (v=10).
    await writeFile(join(repoRoot, 'base.ts'), 'export const v = 10\n')
    const c = await getLocalChanges()
    expect(c.staged).toContain('+export const v = 9')
    expect(c.unstaged).toContain('+export const v = 10')
    // Cross-contamination guard: a regression that merged both diff streams
    // into a single field would still pass the toContain checks above. These
    // negative assertions prove the two streams are kept separate.
    expect(c.staged).not.toContain('+export const v = 10')
    expect(c.unstaged).not.toContain('+export const v = 9')
    expect(c.stagedFiles).toEqual(['M\tbase.ts'])
    expect(c.unstagedFiles).toEqual(['M\tbase.ts'])
  })
})
