import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { existsSync, statSync } from 'node:fs'

import {
  BUILTIN_REVIEWER_NAMES,
  getBuiltinTemplatesDir,
  getUserReviewersDir,
  isValidReviewerName,
  listAvailableReviewers,
  listUserReviewerNames,
  resolveReviewer,
} from '../registry.js'
import {
  clearReviewerPromptCacheForTests,
  loadReviewerSystemPrompt,
} from '../prompts.js'

describe('registry — built-ins', () => {
  it('ships templates for every built-in reviewer', () => {
    // Force fresh disk reads — otherwise a prior test could mask a missing
    // file via the template cache.
    clearReviewerPromptCacheForTests()
    const dir = getBuiltinTemplatesDir()
    for (const name of BUILTIN_REVIEWER_NAMES) {
      const info = resolveReviewer(name)
      expect(info.builtin).toBe(true)
      expect(info.templatePath).toBe(join(dir, `${name}.md`))
      // Path construction is necessary but not sufficient — a built-in could
      // be declared in BUILTIN_REVIEWER_NAMES yet not actually shipped as a
      // file, or shipped empty. Pin both: the file is on disk, has non-zero
      // size, and loads to non-empty trimmed content via the production path.
      expect(existsSync(info.templatePath)).toBe(true)
      expect(statSync(info.templatePath).size).toBeGreaterThan(0)
      const prompt = loadReviewerSystemPrompt(info)
      expect(prompt.length).toBeGreaterThan(0)
    }
  })

  it('rejects malformed reviewer names with a clear message', () => {
    expect(() => resolveReviewer('-leading-dash')).toThrow(/Invalid reviewer name/)
    expect(() => resolveReviewer('has space')).toThrow(/Invalid reviewer name/)
    expect(() => resolveReviewer('')).toThrow(/Invalid reviewer name/)
    expect(() => resolveReviewer('../etc/passwd')).toThrow(/Invalid reviewer name/)
    // 65 chars (over the 64 limit)
    expect(() => resolveReviewer('a'.repeat(65))).toThrow(/Invalid reviewer name/)
  })

  it('throws an actionable error when an unknown reviewer name is requested', () => {
    expect(() => resolveReviewer('nope-this-doesnt-exist')).toThrow(
      /Unknown reviewer.*nope-this-doesnt-exist/,
    )
  })

  it('accepts the documented character set (lowercase only)', () => {
    expect(isValidReviewerName('general')).toBe(true)
    expect(isValidReviewerName('doc-reviewer')).toBe(true)
    expect(isValidReviewerName('security_2')).toBe(true)
    expect(isValidReviewerName('a')).toBe(true)
    // Uppercase is rejected: built-in names are lowercase and reviewer-name
    // matching is case-sensitive so the same slug behaves identically on
    // case-sensitive (Linux) and case-insensitive (default macOS) filesystems.
    expect(isValidReviewerName('Security')).toBe(false)
    expect(isValidReviewerName('MyReviewer')).toBe(false)
  })
})

describe('registry — user overrides + user-defined reviewers', () => {
  let tmp: string
  let originalEnv: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kode-review-reviewers-'))
    mkdirSync(tmp, { recursive: true })
    originalEnv = process.env.KODE_REVIEW_REVIEWERS_DIR
    process.env.KODE_REVIEW_REVIEWERS_DIR = tmp
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KODE_REVIEW_REVIEWERS_DIR
    } else {
      process.env.KODE_REVIEW_REVIEWERS_DIR = originalEnv
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  it('treats a user reviewers dir matching $KODE_REVIEW_REVIEWERS_DIR', () => {
    expect(getUserReviewersDir()).toBe(tmp)
  })

  it('overrides a built-in reviewer when the user provides a same-named file', () => {
    writeFileSync(join(tmp, 'security.md'), 'CUSTOM SECURITY PROMPT')
    const info = resolveReviewer('security')
    expect(info.builtin).toBe(false)
    expect(info.templatePath).toBe(join(tmp, 'security.md'))
    expect(info.description).toContain('user override')
  })

  it('exposes a new user-defined reviewer that has no built-in counterpart', () => {
    writeFileSync(join(tmp, 'performance.md'), 'PERFORMANCE PROMPT')
    const names = listUserReviewerNames()
    expect(names).toContain('performance')

    const info = resolveReviewer('performance')
    expect(info.builtin).toBe(false)
    expect(info.name).toBe('performance')
    expect(info.templatePath).toBe(join(tmp, 'performance.md'))
  })

  it('lists all available reviewers: built-ins first, then extra user-defined ones', () => {
    writeFileSync(join(tmp, 'performance.md'), 'PERF')
    writeFileSync(join(tmp, 'accessibility.md'), 'A11Y')
    // Also an override that shouldn't be double-counted.
    writeFileSync(join(tmp, 'security.md'), 'OVERRIDE')

    const names = listAvailableReviewers().map((r) => r.name)
    // Built-ins keep canonical order
    expect(names.slice(0, BUILTIN_REVIEWER_NAMES.length)).toEqual(
      Array.from(BUILTIN_REVIEWER_NAMES),
    )
    // User-only reviewers are appended, sorted
    expect(names.slice(BUILTIN_REVIEWER_NAMES.length)).toEqual([
      'accessibility',
      'performance',
    ])
    // No duplicate for the overridden security reviewer
    expect(names.filter((n) => n === 'security')).toHaveLength(1)
  })

  it('ignores non-.md files and invalid names in the user dir', () => {
    // Non-.md extension — ignored.
    writeFileSync(join(tmp, 'notes.txt'), 'ignored')
    // Space in filename — fails isValidReviewerName.
    writeFileSync(join(tmp, 'has space.md'), 'ignored')
    // Leading underscore — fails isValidReviewerName (first char must be
    // [a-z0-9]). Same rule used by both the scan filter and resolveReviewer.
    writeFileSync(join(tmp, '_underscore-start.md'), 'ignored')
    expect(listUserReviewerNames()).toEqual([])
  })

  it('handles a missing user directory without throwing', () => {
    rmSync(tmp, { recursive: true, force: true })
    expect(listUserReviewerNames()).toEqual([])
    // Built-ins still resolve.
    const info = resolveReviewer('general')
    expect(info.builtin).toBe(true)
  })
})
