/**
 * Tests for report.ts — text / markdown / json rendering of RepoFindingRecord[].
 *
 * Pure-function tests against rendered strings. The text + markdown
 * variants are expected to include a Feature × Severity matrix; the JSON
 * variant is expected to be stable, machine-readable, and schema-tagged.
 */
import { describe, expect, it } from 'vitest'
import { renderRepoReport } from '../report.js'
import type { RepoFindingRecord } from '../types.js'

function makeRecord(overrides: Partial<RepoFindingRecord> & {
  finding?: Partial<RepoFindingRecord['finding']>
} = {}): RepoFindingRecord {
  return {
    schemaVersion: 1,
    findingId: 'abc',
    featureId: 'feat-a',
    persona: 'general',
    status: 'open',
    finding: {
      severity: 'HIGH',
      category: 'security',
      confidence: 'HIGH',
      title: 'Hardcoded API key',
      file: 'src/auth.ts',
      lineStart: 42,
      lineEnd: 42,
      evidence: 'const apiKey = "sk-abc"',
      problem: 'Secret in source.',
      recommendation: 'Move to env var.',
      ...overrides.finding,
    },
    createdByRunId: 'run-1',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('renderRepoReport — JSON', () => {
  it('produces parseable JSON tagged with version + generatedAt', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'json',
    })
    const parsed = JSON.parse(out)
    expect(parsed.version).toBe(1)
    expect(typeof parsed.generatedAt).toBe('string')
    expect(parsed.total).toBe(1)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0].title).toBe('Hardcoded API key')
  })

  it('counts by status and by severity (only open contributes to bySeverity)', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ findingId: 'a', status: 'open', finding: { severity: 'CRITICAL', category: 'security', confidence: 'HIGH', title: 'a', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
        makeRecord({ findingId: 'b', status: 'fixed', finding: { severity: 'HIGH', category: 'security', confidence: 'HIGH', title: 'b', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
      ],
      format: 'json',
    })
    const parsed = JSON.parse(out)
    expect(parsed.byStatus.open).toBe(1)
    expect(parsed.byStatus.fixed).toBe(1)
    expect(parsed.bySeverity.CRITICAL).toBe(1)
    expect(parsed.bySeverity.HIGH).toBeUndefined() // fixed → not counted
  })

  it('handles zero findings without error', () => {
    const out = renderRepoReport({ records: [], format: 'json' })
    const parsed = JSON.parse(out)
    expect(parsed.total).toBe(0)
    expect(parsed.findings).toEqual([])
  })
})

describe('renderRepoReport — text', () => {
  it('opens with a banner and summary counts', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'text',
    })
    expect(out).toContain('Repo Audit Report')
    expect(out).toContain('Total findings:  1')
    expect(out).toContain('Open:            1')
  })

  it('includes the Feature × Severity matrix', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ featureId: 'feat-a', finding: { severity: 'CRITICAL', category: 'security', confidence: 'HIGH', title: 'a', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
        makeRecord({ featureId: 'feat-a', findingId: 'a2', finding: { severity: 'HIGH', category: 'security', confidence: 'HIGH', title: 'a2', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
        makeRecord({ featureId: 'feat-b', findingId: 'b', finding: { severity: 'LOW', category: 'other', confidence: 'LOW', title: 'b', file: 'g', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
      ],
      format: 'text',
    })
    expect(out).toContain('Feature × Severity')
    expect(out).toContain('feat-a')
    expect(out).toContain('feat-b')
  })

  it('sorts feature rows by CRITICAL desc, then HIGH desc, then total desc', () => {
    const out = renderRepoReport({
      records: [
        // feat-low: 1 LOW
        makeRecord({ featureId: 'feat-low', finding: { severity: 'LOW', category: 'other', confidence: 'LOW', title: 'l', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
        // feat-crit: 1 CRITICAL
        makeRecord({ featureId: 'feat-crit', findingId: 'c', finding: { severity: 'CRITICAL', category: 'security', confidence: 'HIGH', title: 'c', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
        // feat-high: 1 HIGH
        makeRecord({ featureId: 'feat-high', findingId: 'h', finding: { severity: 'HIGH', category: 'security', confidence: 'HIGH', title: 'h', file: 'f', lineStart: 1, lineEnd: 1, evidence: 'x', problem: 'p', recommendation: 'r' } }),
      ],
      format: 'text',
    })
    const critIdx = out.indexOf('feat-crit')
    const highIdx = out.indexOf('feat-high')
    const lowIdx = out.indexOf('feat-low')
    expect(critIdx).toBeGreaterThan(-1)
    expect(highIdx).toBeGreaterThan(-1)
    expect(lowIdx).toBeGreaterThan(-1)
    expect(critIdx).toBeLessThan(highIdx)
    expect(highIdx).toBeLessThan(lowIdx)
  })

  it('renders per-finding detail grouped by severity', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'text',
    })
    expect(out).toContain('[HIGH]')
    expect(out).toContain('Hardcoded API key')
    expect(out).toContain('src/auth.ts:42')
    expect(out).toContain('evidence:')
    expect(out).toContain('problem:')
    expect(out).toContain('fix:')
  })

  it('emits a clear "no findings" hint for an empty record set', () => {
    const out = renderRepoReport({ records: [], format: 'text' })
    expect(out).toMatch(/No findings on disk/)
  })

  it('flags --no-suppressions in the header when suppressionsDisabled is true', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'text',
      suppressionsDisabled: true,
    })
    expect(out).toContain('Suppressions:    DISABLED')
  })

  it('does not show the suppression line when suppressionsDisabled is false/undefined', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'text',
    })
    expect(out).not.toMatch(/Suppressions:.*DISABLED/)
  })

  it('collapses multi-line evidence/problem/recommendation onto single lines', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          finding: {
            severity: 'HIGH', category: 'security', confidence: 'HIGH',
            title: 't', file: 'f.ts', lineStart: 1, lineEnd: 1,
            evidence: 'line1\nline2\nline3',
            problem: 'p1\np2',
            recommendation: 'r',
          },
        }),
      ],
      format: 'text',
    })
    // Multi-line content collapsed to a single line in text output.
    expect(out).toContain('line1 line2 line3')
    expect(out).toContain('p1 p2')
  })

  it('renders an end-line range when lineStart !== lineEnd', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          finding: {
            severity: 'HIGH', category: 'security', confidence: 'HIGH',
            title: 't', file: 'f.ts', lineStart: 10, lineEnd: 14,
            evidence: 'x', problem: 'p', recommendation: 'r',
          },
        }),
      ],
      format: 'text',
    })
    expect(out).toContain('f.ts:10-14')
  })
})

describe('renderRepoReport — markdown', () => {
  it('opens with an H1 heading and bullet summary', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'markdown',
    })
    expect(out).toMatch(/^# Repo Audit Report/)
    expect(out).toContain('- **Total findings:** 1')
    expect(out).toContain('- **Open:** 1')
  })

  it('emits a markdown severity-summary table', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'markdown',
    })
    expect(out).toContain('| Severity | Count |')
    expect(out).toContain('| HIGH | 1 |')
  })

  it('emits the Feature × Severity matrix as a markdown table', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ featureId: 'feat-a' }),
        makeRecord({ featureId: 'feat-b', findingId: 'b' }),
      ],
      format: 'markdown',
    })
    expect(out).toContain('| Feature | CRITICAL | HIGH | MEDIUM | LOW | Total |')
    expect(out).toContain('| `feat-a` |')
    expect(out).toContain('| `feat-b` |')
  })

  it('renders per-finding detail grouped by severity heading', () => {
    const out = renderRepoReport({
      records: [makeRecord()],
      format: 'markdown',
    })
    expect(out).toContain('## HIGH Findings')
    expect(out).toContain('### Hardcoded API key')
    expect(out).toContain('**Recommendation:**')
  })

  it('emits a "no unresolved findings" placeholder and no feature table rows when all findings are closed', () => {
    const out = renderRepoReport({
      records: [makeRecord({ status: 'fixed' })],
      format: 'markdown',
    })
    // No table data rows (each starts with `| `<featureId>...).
    expect(out).not.toMatch(/^\| `feat-/m)
    // Explicit placeholder is present.
    expect(out).toContain('_(no unresolved findings)_')
  })
})

// ── Uncertain status handling ───────────────────────────────────────────────
//
// `uncertain` is set by `--revalidate` when the agent can't determine whether
// a finding has been fixed. The bug being guarded against: an `uncertain`
// CRITICAL finding silently disappearing from the "Open" view because the
// renderer was filtering on `status === 'open'` exclusively. That bug let CI
// gates pass on findings the agent literally said it couldn't verify.

describe('renderRepoReport — uncertain status (text)', () => {
  it('counts uncertain findings under "Uncertain" (separate from Open and Closed)', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ findingId: 'open-1', status: 'open' }),
        makeRecord({ findingId: 'unc-1', status: 'uncertain' }),
        makeRecord({ findingId: 'unc-2', status: 'uncertain' }),
        makeRecord({ findingId: 'fix-1', status: 'fixed' }),
      ],
      format: 'text',
    })
    expect(out).toContain('Total findings:  4')
    expect(out).toContain('Open:            1')
    expect(out).toContain('Uncertain:       2  (revalidation could not determine)')
    // Closed = total - open - uncertain = 4 - 1 - 2 = 1 (only the `fixed` one).
    expect(out).toContain('Closed:          1  (fixed / wont-fix / false-positive)')
  })

  it('renders an uncertain CRITICAL finding in the per-finding detail with an [UNCERTAIN] tag', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          findingId: 'crit-unc',
          status: 'uncertain',
          finding: {
            severity: 'CRITICAL',
            category: 'security',
            confidence: 'HIGH',
            title: 'SQL injection in auth handler',
            file: 'src/auth.ts',
            lineStart: 10,
            lineEnd: 10,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
      ],
      format: 'text',
    })
    // The finding MUST appear in the per-severity detail, not vanish.
    expect(out).toContain('[CRITICAL]')
    expect(out).toContain('SQL injection in auth handler')
    expect(out).toContain('[UNCERTAIN]')
    // And it MUST contribute to the severity rollup.
    expect(out).toMatch(/CRITICAL\s+1/)
  })

  it('includes uncertain findings in the Feature × Severity matrix', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          findingId: 'unc-feat',
          featureId: 'feat-unc',
          status: 'uncertain',
          finding: {
            severity: 'HIGH',
            category: 'security',
            confidence: 'HIGH',
            title: 't',
            file: 'f.ts',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
      ],
      format: 'text',
    })
    expect(out).toContain('feat-unc')
  })

  it('does NOT tag open findings with [UNCERTAIN]', () => {
    const out = renderRepoReport({
      records: [makeRecord({ status: 'open' })],
      format: 'text',
    })
    expect(out).not.toContain('[UNCERTAIN]')
  })

  it('Closed count is records minus open minus uncertain (only true terminal states count as closed)', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ findingId: '1', status: 'open' }),
        makeRecord({ findingId: '2', status: 'uncertain' }),
        makeRecord({ findingId: '3', status: 'fixed' }),
        makeRecord({ findingId: '4', status: 'wont-fix' }),
        makeRecord({ findingId: '5', status: 'false-positive' }),
      ],
      format: 'text',
    })
    expect(out).toContain('Open:            1')
    expect(out).toContain('Uncertain:       1')
    // fixed + wont-fix + false-positive = 3
    expect(out).toContain('Closed:          3')
  })
})

describe('renderRepoReport — uncertain status (markdown)', () => {
  it('emits a separate **Uncertain** summary bullet', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ findingId: 'open-1', status: 'open' }),
        makeRecord({ findingId: 'unc-1', status: 'uncertain' }),
      ],
      format: 'markdown',
    })
    expect(out).toContain('- **Open:** 1')
    expect(out).toContain('- **Uncertain:** 1 _(revalidation could not determine)_')
  })

  it('includes uncertain finding in the severity-summary table count', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          findingId: 'unc-1',
          status: 'uncertain',
          finding: {
            severity: 'CRITICAL',
            category: 'security',
            confidence: 'HIGH',
            title: 't',
            file: 'f',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
      ],
      format: 'markdown',
    })
    expect(out).toContain('| CRITICAL | 1 |')
  })

  it('marks uncertain findings with [UNCERTAIN] in the per-finding heading', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          findingId: 'unc-1',
          status: 'uncertain',
          finding: {
            severity: 'HIGH',
            category: 'security',
            confidence: 'HIGH',
            title: 'Possibly fixed thing',
            file: 'f.ts',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
      ],
      format: 'markdown',
    })
    expect(out).toContain('### Possibly fixed thing [UNCERTAIN]')
    expect(out).toContain('- **Status:** uncertain')
  })
})

describe('renderRepoReport — uncertain status (JSON)', () => {
  it('exposes separate openCount / uncertainCount / closedCount fields', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({ findingId: '1', status: 'open' }),
        makeRecord({ findingId: '2', status: 'uncertain' }),
        makeRecord({ findingId: '3', status: 'fixed' }),
        makeRecord({ findingId: '4', status: 'wont-fix' }),
      ],
      format: 'json',
    })
    const parsed = JSON.parse(out)
    expect(parsed.openCount).toBe(1)
    expect(parsed.uncertainCount).toBe(1)
    expect(parsed.closedCount).toBe(2)
  })

  it('counts uncertain findings in bySeverity (unresolved rollup includes uncertain)', () => {
    const out = renderRepoReport({
      records: [
        makeRecord({
          findingId: '1',
          status: 'uncertain',
          finding: {
            severity: 'CRITICAL',
            category: 'security',
            confidence: 'HIGH',
            title: 't',
            file: 'f',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
        makeRecord({
          findingId: '2',
          status: 'fixed',
          finding: {
            severity: 'CRITICAL',
            category: 'security',
            confidence: 'HIGH',
            title: 't2',
            file: 'f',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'x',
            problem: 'p',
            recommendation: 'r',
          },
        }),
      ],
      format: 'json',
    })
    const parsed = JSON.parse(out)
    // The uncertain CRITICAL must be in bySeverity. The fixed CRITICAL must NOT.
    expect(parsed.bySeverity.CRITICAL).toBe(1)
  })
})
