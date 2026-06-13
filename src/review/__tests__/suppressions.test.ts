import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasIgnoreMarker,
  hasIgnoreFileMarker,
  filterSuppressedFindings,
  filterSuppressedStructuredFindings,
} from '../suppressions.js'
import type { Finding } from '../finding-schema.js'

describe('hasIgnoreMarker', () => {
  it('matches // kode-review: ignore', () => {
    expect(hasIgnoreMarker('foo(); // kode-review: ignore')).toBe(true)
  })
  it('matches # kode-review: ignore (Python/shell)', () => {
    expect(hasIgnoreMarker('foo() # kode-review: ignore')).toBe(true)
  })
  it('matches /* kode-review: ignore */ (block comment)', () => {
    expect(hasIgnoreMarker('/* kode-review: ignore */')).toBe(true)
  })
  it('matches <!-- kode-review: ignore --> (HTML)', () => {
    expect(hasIgnoreMarker('<!-- kode-review: ignore -->')).toBe(true)
  })
  it('matches -- kode-review: ignore (SQL/Haskell)', () => {
    expect(hasIgnoreMarker('-- kode-review: ignore')).toBe(true)
  })
  it('tolerates extra whitespace after the colon', () => {
    expect(hasIgnoreMarker('// kode-review:   ignore')).toBe(true)
  })
  it('does NOT match the file-level marker (distinct semantics)', () => {
    expect(hasIgnoreMarker('// kode-review: ignore-file')).toBe(false)
  })
  it('is case-sensitive on the keyword', () => {
    expect(hasIgnoreMarker('// Kode-Review: ignore')).toBe(false)
  })
  it('does not match arbitrary text without the keyword', () => {
    expect(hasIgnoreMarker('we should review and ignore this')).toBe(false)
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
    // src/a.ts line layout:
    // 1: export function foo() {
    // 2:   return 1; // kode-review: ignore
    // 3: }
    // 4: export const x = 2;
    writeFileSync(
      join(repo, 'src/a.ts'),
      'export function foo() {\n  return 1; // kode-review: ignore\n}\nexport const x = 2;\n',
    )
    // File-level suppression
    writeFileSync(join(repo, 'src/b.ts'), '// kode-review: ignore-file\nexport const y = 3;\n')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const md = (path: string, line: number, severity = 'CRITICAL'): string =>
    `**[SEVERITY: ${severity}]** - Cat: title\n\nFile: ${path}:${line}\n\nProblem:\nstuff\n\nConfidence: HIGH\n`

  const structured = (path: string, line: number, severity: Finding['severity'] = 'CRITICAL'): Finding => ({
    severity,
    category: 'correctness',
    confidence: 'HIGH',
    title: `${severity} finding`,
    file: path,
    lineStart: line,
    lineEnd: line,
    evidence: 'code',
    problem: 'problem',
    recommendation: 'fix',
  })

  it('drops findings on a line carrying the ignore marker', async () => {
    const input = md('src/a.ts', 2) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered, suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(1)
    expect(filtered).not.toContain('Cat: title')
    expect(summary.issuesByCount.critical).toBe(0)
  })

  it('drops findings on the line BELOW the ignore marker', async () => {
    const input =
      md('src/a.ts', 3) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered, suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(1)
    expect(filtered).not.toContain('Cat: title')
    expect(summary.issuesByCount.critical).toBe(0)
  })

  it('keeps findings on lines NOT next to the marker', async () => {
    const input =
      md('src/a.ts', 4) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(0)
    expect(summary.issuesByCount.critical).toBe(1)
  })

  it('drops every finding in a file with ignore-file', async () => {
    const input =
      md('src/b.ts', 2) + md('src/b.ts', 1, 'HIGH') +
      '\nIssues Summary: 1 CRITICAL, 1 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount, summary } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(2)
    expect(summary.issuesByCount.critical).toBe(0)
    expect(summary.issuesByCount.high).toBe(0)
  })

  it('keeps the finding when the referenced file cannot be read', async () => {
    const input =
      md('src/does-not-exist.ts', 1) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(0)
  })

  it('keeps the finding when the path attempts traversal (guard rejects, file unreadable)', async () => {
    const input =
      md('../../etc/passwd', 1) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { suppressedCount } = await filterSuppressedFindings(input, repo)
    expect(suppressedCount).toBe(0)
  })

  it('appends a "Suppressed: N findings" line when N > 0', async () => {
    const input = md('src/a.ts', 2) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered } = await filterSuppressedFindings(input, repo)
    expect(filtered).toMatch(/Suppressed: 1 finding/)
  })

  it('does not append the Suppressed line when nothing was filtered', async () => {
    const input = md('src/a.ts', 4) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered } = await filterSuppressedFindings(input, repo)
    expect(filtered).not.toMatch(/Suppressed:/)
  })

  it('rewrites the Issues Summary line to reflect new counts', async () => {
    const input =
      md('src/a.ts', 2) + md('src/a.ts', 4) +
      '\nIssues Summary: 2 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { filtered, summary } = await filterSuppressedFindings(input, repo)
    expect(summary.issuesByCount.critical).toBe(1)
    expect(filtered).toContain('Issues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW')
  })

  it('extracts the verdict from a RECOMMENDATION line', async () => {
    const input = `RECOMMENDATION: REQUEST_CHANGES\n${md('src/a.ts', 4)}\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n`
    const { summary } = await filterSuppressedFindings(input, repo)
    expect(summary.verdict).toBe('REQUEST_CHANGES')
  })

  it('defaults verdict to NEEDS_DISCUSSION when no RECOMMENDATION line is present', async () => {
    const input = md('src/a.ts', 4) + '\nIssues Summary: 1 CRITICAL, 0 HIGH, 0 MEDIUM, 0 LOW\n'
    const { summary } = await filterSuppressedFindings(input, repo)
    expect(summary.verdict).toBe('NEEDS_DISCUSSION')
  })

  it('drops structured findings with the same marker rules used by CI counts', async () => {
    const result = await filterSuppressedStructuredFindings([
      structured('src/a.ts', 2, 'CRITICAL'),
      structured('src/a.ts', 4, 'HIGH'),
      structured('src/b.ts', 2, 'LOW'),
    ], repo)

    expect(result.suppressedCount).toBe(2)
    expect(result.kept.map((f) => f.severity)).toEqual(['HIGH'])
  })
})
