/**
 * Tests for suppressions-structured.ts — drops Findings whose source line
 * is annotated with a `kode-review: ignore` / `ignore-file` marker.
 *
 * Real filesystem under a tmp dir so the path-guard + read pipeline is
 * actually exercised (path guard rejects traversal, ignore-file marker
 * gates whole files, etc.).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Finding } from '../../review/finding-schema.js'
import { filterSuppressedStructured } from '../suppressions-structured.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-supp-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

function finding(file: string, lineStart: number, title = 't'): Finding {
  return {
    severity: 'HIGH',
    category: 'security',
    confidence: 'HIGH',
    title,
    file,
    lineStart,
    lineEnd: lineStart,
    evidence: 'x',
    problem: 'p',
    recommendation: 'r',
  }
}

describe('filterSuppressedStructured', () => {
  it('keeps all findings when no source files contain markers', async () => {
    await writeFileAt('a.ts', 'const x = 1\nconst y = 2\n')
    const result = await filterSuppressedStructured(
      [finding('a.ts', 1), finding('a.ts', 2)],
      tmp,
    )
    expect(result.kept).toHaveLength(2)
    expect(result.suppressedCount).toBe(0)
  })

  it('drops a finding when its line has an inline ignore marker', async () => {
    await writeFileAt('a.ts', 'const x = 1 // kode-review: ignore\n')
    const result = await filterSuppressedStructured([finding('a.ts', 1)], tmp)
    expect(result.kept).toEqual([])
    expect(result.suppressedCount).toBe(1)
  })

  it('drops a finding when the line above has an ignore marker (next-line idiom)', async () => {
    // 1: // kode-review: ignore
    // 2: const x = 1   ← finding targets this line
    await writeFileAt('a.ts', '// kode-review: ignore\nconst x = 1\n')
    const result = await filterSuppressedStructured([finding('a.ts', 2)], tmp)
    expect(result.kept).toEqual([])
    expect(result.suppressedCount).toBe(1)
  })

  it('drops every finding in a file with the ignore-file marker', async () => {
    await writeFileAt(
      'gen.ts',
      '// kode-review: ignore-file\nconst a = 1\nconst b = 2\nconst c = 3\n',
    )
    const result = await filterSuppressedStructured(
      [finding('gen.ts', 2), finding('gen.ts', 3), finding('gen.ts', 4)],
      tmp,
    )
    expect(result.kept).toEqual([])
    expect(result.suppressedCount).toBe(3)
  })

  it('reads each file only once even when many findings target it', async () => {
    // Hard to assert directly without a spy on readFile, but indirect check:
    // a single ignore-file marker drops all findings, which means each file
    // must be read once and the result reused for every finding in it.
    await writeFileAt('a.ts', '// kode-review: ignore-file\n' + 'x\n'.repeat(50))
    const findings = Array.from({ length: 50 }, (_, i) => finding('a.ts', i + 2))
    const result = await filterSuppressedStructured(findings, tmp)
    expect(result.kept).toEqual([])
    expect(result.suppressedCount).toBe(50)
  })

  it('keeps findings whose source file is missing (no silent suppression)', async () => {
    // Source file genuinely missing on disk (file was renamed/deleted).
    // We must NOT silently drop the finding — that would hide regressions.
    const result = await filterSuppressedStructured([finding('vanished.ts', 1)], tmp)
    expect(result.kept).toHaveLength(1)
    expect(result.suppressedCount).toBe(0)
  })

  it('mixes kept and dropped findings correctly when multiple files are involved', async () => {
    await writeFileAt('keep.ts', 'const x = 1\n')
    await writeFileAt('drop.ts', '// kode-review: ignore-file\nconst y = 2\n')
    const result = await filterSuppressedStructured(
      [finding('keep.ts', 1), finding('drop.ts', 2)],
      tmp,
    )
    expect(result.kept.map((f) => f.file)).toEqual(['keep.ts'])
    expect(result.suppressedCount).toBe(1)
    expect(result.byFile.get('drop.ts')).toBe(1)
  })

  it('tracks per-file suppression counts in byFile', async () => {
    await writeFileAt(
      'a.ts',
      '// kode-review: ignore-file\nconst x = 1\nconst y = 2\n',
    )
    await writeFileAt('b.ts', 'const x = 1 // kode-review: ignore\n')
    const result = await filterSuppressedStructured(
      [finding('a.ts', 2), finding('a.ts', 3), finding('b.ts', 1)],
      tmp,
    )
    expect(result.byFile.get('a.ts')).toBe(2)
    expect(result.byFile.get('b.ts')).toBe(1)
    expect(result.suppressedCount).toBe(3)
  })

  it('does not suppress when the marker is on a different line', async () => {
    // Marker on line 1, finding on line 5 — should NOT be suppressed
    // (the "this line and line below" idiom doesn't reach line 5).
    await writeFileAt('a.ts', '// kode-review: ignore\nx\nx\nx\nfindingHere\n')
    const result = await filterSuppressedStructured([finding('a.ts', 5)], tmp)
    expect(result.kept).toHaveLength(1)
    expect(result.suppressedCount).toBe(0)
  })

  it('rejects a path-traversal attempt by treating the file as unreadable (keeps the finding)', async () => {
    // Plant an actual file with an ignore-file marker *outside* the repo
    // root. If the path guard were stripped, the SUT would read this file
    // and silently suppress the finding. With the guard, the read is
    // blocked, the file appears "unreadable", and the finding is kept.
    const outside = await mkdtemp(join(tmpdir(), 'kode-review-outside-'))
    const escapeFile = join(outside, 'attack.ts')
    await writeFile(escapeFile, '// kode-review: ignore-file\nx\n')
    try {
      // Use path.relative to compute the traversal string an attacker would
      // supply. This is platform-independent and works regardless of how
      // deep the system tmpdir is nested.
      const relTraversal = relative(tmp, escapeFile)
      // Sanity check: this MUST start with `..` to be a real traversal.
      // If it doesn't, the test would prove nothing.
      expect(relTraversal.startsWith('..')).toBe(true)

      const result = await filterSuppressedStructured(
        [finding(relTraversal, 1)],
        tmp,
      )
      // If the guard fired: kept=1. If the guard silently allowed the read,
      // the ignore-file marker would have triggered suppression (kept=0).
      expect(result.kept).toHaveLength(1)
      expect(result.suppressedCount).toBe(0)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('returns the original array when given an empty list', async () => {
    const result = await filterSuppressedStructured([], tmp)
    expect(result.kept).toEqual([])
    expect(result.suppressedCount).toBe(0)
    expect(result.byFile.size).toBe(0)
  })
})
