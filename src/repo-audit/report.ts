/**
 * Render repo-scope findings as text / markdown / json.
 *
 * Separate from the diff-scope formatters in src/output/ because the
 * input shape is fundamentally different: repo scope deals in stored
 * RepoFindingRecord[] keyed by feature, with lifecycle states; diff
 * scope deals in a single per-run StructuredReview.
 *
 * The text + markdown variants emit a Feature × Severity matrix to give
 * users a glanceable overview before they scroll the per-finding detail.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OutputFormat } from '../output/types.js'
import type { RepoFindingRecord } from './types.js'

export type RepoSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
const SEVERITIES: RepoSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

/**
 * "Needs-attention" predicate: open + uncertain.
 *
 * `uncertain` is set by `--revalidate` when the agent cannot determine
 * whether a finding has been fixed. Treating it as closed would silently
 * drop CRITICAL findings from the report and let CI gates pass — which
 * is the exact opposite of the intent. The agent gave up; a human still
 * needs to look. So uncertain rolls up alongside open everywhere a
 * human-eyeball gate is applied (Open section, severity rollup, Feature ×
 * Severity matrix, per-finding detail, CI fail-on gate).
 *
 * The truly-closed terminal states are: `fixed`, `wont-fix`, `false-positive`.
 */
function isUnresolved(r: RepoFindingRecord): boolean {
  return r.status === 'open' || r.status === 'uncertain'
}

export interface RenderRepoReportOptions {
  records: RepoFindingRecord[]
  format: OutputFormat
  /** True if --no-suppressions was used; included in the header for clarity. */
  suppressionsDisabled?: boolean
}

/**
 * Build the formatted report for the given records. Pure function — write
 * side effects live in `writeRepoReport`.
 */
export function renderRepoReport(opts: RenderRepoReportOptions): string {
  switch (opts.format) {
    case 'json':
      return renderJson(opts.records)
    case 'markdown':
      return renderMarkdown(opts.records, opts.suppressionsDisabled)
    case 'text':
    default:
      return renderText(opts.records, opts.suppressionsDisabled)
  }
}

/**
 * Render + write. Mirrors src/output/writer.ts ergonomics.
 */
export async function writeRepoReport(
  opts: RenderRepoReportOptions & { outputFile?: string; quiet?: boolean },
): Promise<void> {
  const content = renderRepoReport(opts)
  if (opts.outputFile) {
    const dir = dirname(opts.outputFile)
    if (dir && dir !== '.') {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(opts.outputFile, content, 'utf-8')
  }
  if (!opts.quiet) {
    console.log(content)
  }
}

// ── JSON ──────────────────────────────────────────────────────────────────

function renderJson(records: RepoFindingRecord[]): string {
  const openCount = records.filter((r) => r.status === 'open').length
  const uncertainCount = records.filter((r) => r.status === 'uncertain').length
  return JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      total: records.length,
      // openCount / uncertainCount / closedCount: separate counts so machine
      // consumers (CI bots, dashboards) can distinguish "needs human" from
      // truly-closed without re-deriving from byStatus.
      openCount,
      uncertainCount,
      closedCount: records.length - openCount - uncertainCount,
      byStatus: groupCounts(records, (r) => r.status),
      // bySeverity counts unresolved (open + uncertain) — uncertain still
      // represents unresolved risk that needs human attention.
      bySeverity: groupCounts(records.filter(isUnresolved), (r) => r.finding.severity),
      findings: records.map((r) => ({
        findingId: r.findingId,
        featureId: r.featureId,
        persona: r.persona,
        status: r.status,
        severity: r.finding.severity,
        category: r.finding.category,
        confidence: r.finding.confidence,
        title: r.finding.title,
        file: r.finding.file,
        lineStart: r.finding.lineStart,
        lineEnd: r.finding.lineEnd,
        evidence: r.finding.evidence,
        problem: r.finding.problem,
        recommendation: r.finding.recommendation,
        createdByRunId: r.createdByRunId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    },
    null,
    2,
  )
}

// ── Text ──────────────────────────────────────────────────────────────────

function renderText(records: RepoFindingRecord[], suppressionsDisabled?: boolean): string {
  const unresolved = records.filter(isUnresolved)
  const openOnly = records.filter((r) => r.status === 'open')
  const uncertain = records.filter((r) => r.status === 'uncertain')
  const closedCount = records.length - unresolved.length
  const lines: string[] = []
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('  Repo Audit Report')
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('')
  lines.push(`Total findings:  ${records.length}`)
  lines.push(`Open:            ${openOnly.length}`)
  lines.push(`Uncertain:       ${uncertain.length}  (revalidation could not determine)`)
  lines.push(`Closed:          ${closedCount}  (fixed / wont-fix / false-positive)`)
  if (suppressionsDisabled === true) {
    lines.push(`Suppressions:    DISABLED (--no-suppressions)`)
  }
  lines.push('')

  if (records.length === 0) {
    lines.push('No findings on disk. Run without --report-only to produce a review.')
    return lines.join('\n')
  }

  // Severity rollup for unresolved findings (open + uncertain).
  const sev = severityRollup(unresolved)
  lines.push('Unresolved by severity (open + uncertain):')
  for (const s of SEVERITIES) {
    lines.push(`  ${s.padEnd(8)} ${sev[s]}`)
  }
  lines.push('')

  // Feature × severity matrix.
  lines.push('Feature × Severity (unresolved findings):')
  lines.push(formatFeatureSeverityTable(unresolved))
  lines.push('')

  // Per-finding detail, grouped by severity then feature.
  lines.push('───────────────────────────────────────────────────────────────')
  lines.push('  Findings (unresolved, by severity → feature)')
  lines.push('───────────────────────────────────────────────────────────────')
  for (const s of SEVERITIES) {
    const inSev = unresolved.filter((r) => r.finding.severity === s)
    if (inSev.length === 0) continue
    lines.push('')
    lines.push(`[${s}]`)
    for (const r of inSev) {
      // Tag uncertain findings so readers see they're inconclusive, not new.
      const uncertainTag = r.status === 'uncertain' ? ' [UNCERTAIN]' : ''
      lines.push('')
      lines.push(`  · ${r.finding.title}${uncertainTag}`)
      lines.push(`    feature: ${r.featureId}  persona: ${r.persona}  confidence: ${r.finding.confidence}`)
      lines.push(`    file:    ${r.finding.file}:${r.finding.lineStart}${r.finding.lineEnd !== r.finding.lineStart ? `-${r.finding.lineEnd}` : ''}`)
      lines.push(`    evidence:    ${oneLine(r.finding.evidence)}`)
      lines.push(`    problem:     ${oneLine(r.finding.problem)}`)
      lines.push(`    fix:         ${oneLine(r.finding.recommendation)}`)
    }
  }
  return lines.join('\n')
}

// ── Markdown ──────────────────────────────────────────────────────────────

function renderMarkdown(records: RepoFindingRecord[], suppressionsDisabled?: boolean): string {
  const unresolved = records.filter(isUnresolved)
  const openOnly = records.filter((r) => r.status === 'open')
  const uncertain = records.filter((r) => r.status === 'uncertain')
  const closedCount = records.length - unresolved.length
  const lines: string[] = []
  lines.push('# Repo Audit Report')
  lines.push('')
  lines.push(`- **Total findings:** ${records.length}`)
  lines.push(`- **Open:** ${openOnly.length}`)
  lines.push(`- **Uncertain:** ${uncertain.length} _(revalidation could not determine)_`)
  lines.push(`- **Closed:** ${closedCount} _(fixed / wont-fix / false-positive)_`)
  if (suppressionsDisabled === true) {
    lines.push(`- **Suppressions:** DISABLED (\`--no-suppressions\`)`)
  }
  lines.push('')

  if (records.length === 0) {
    lines.push('_No findings on disk. Run without `--report-only` to produce a review._')
    return lines.join('\n')
  }

  const sev = severityRollup(unresolved)
  lines.push('## Unresolved Findings by Severity (open + uncertain)')
  lines.push('')
  lines.push('| Severity | Count |')
  lines.push('|----------|-------|')
  for (const s of SEVERITIES) lines.push(`| ${s} | ${sev[s]} |`)
  lines.push('')

  // Feature × severity matrix as a markdown table.
  lines.push('## Feature × Severity (unresolved findings)')
  lines.push('')
  lines.push(formatFeatureSeverityMarkdownTable(unresolved))
  lines.push('')

  for (const s of SEVERITIES) {
    const inSev = unresolved.filter((r) => r.finding.severity === s)
    if (inSev.length === 0) continue
    lines.push(`## ${s} Findings`)
    lines.push('')
    for (const r of inSev) {
      const uncertainTag = r.status === 'uncertain' ? ' [UNCERTAIN]' : ''
      lines.push(`### ${r.finding.title}${uncertainTag}`)
      lines.push('')
      lines.push(`- **Feature:** ${r.featureId}`)
      lines.push(`- **Persona:** ${r.persona}`)
      lines.push(`- **Status:** ${r.status}`)
      lines.push(`- **Confidence:** ${r.finding.confidence}`)
      lines.push(`- **Category:** ${r.finding.category}`)
      lines.push(`- **File:** \`${r.finding.file}:${r.finding.lineStart}${r.finding.lineEnd !== r.finding.lineStart ? `-${r.finding.lineEnd}` : ''}\``)
      lines.push('')
      lines.push(`**Evidence:**`)
      lines.push('')
      lines.push('```')
      lines.push(r.finding.evidence)
      lines.push('```')
      lines.push('')
      lines.push(`**Problem:** ${r.finding.problem}`)
      lines.push('')
      lines.push(`**Recommendation:** ${r.finding.recommendation}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────

function severityRollup(records: RepoFindingRecord[]): Record<RepoSeverity, number> {
  const counts: Record<RepoSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const r of records) {
    counts[r.finding.severity] += 1
  }
  return counts
}

function groupCounts<T, K extends string>(items: T[], key: (item: T) => K): Record<K, number> {
  const out: Record<string, number> = {}
  for (const it of items) {
    const k = key(it)
    out[k] = (out[k] ?? 0) + 1
  }
  return out as Record<K, number>
}

interface FeatureRow {
  featureId: string
  counts: Record<RepoSeverity, number>
  total: number
}

function buildFeatureRows(records: RepoFindingRecord[]): FeatureRow[] {
  const byFeature = new Map<string, FeatureRow>()
  for (const r of records) {
    let row = byFeature.get(r.featureId)
    if (!row) {
      row = { featureId: r.featureId, counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, total: 0 }
      byFeature.set(r.featureId, row)
    }
    row.counts[r.finding.severity] += 1
    row.total += 1
  }
  // Sort: most critical-laden first, then by HIGH, then total.
  return Array.from(byFeature.values()).sort((a, b) => {
    if (a.counts.CRITICAL !== b.counts.CRITICAL) return b.counts.CRITICAL - a.counts.CRITICAL
    if (a.counts.HIGH !== b.counts.HIGH) return b.counts.HIGH - a.counts.HIGH
    return b.total - a.total
  })
}

function formatFeatureSeverityTable(records: RepoFindingRecord[]): string {
  const rows = buildFeatureRows(records)
  if (rows.length === 0) return '  (none)'
  const featWidth = Math.max(7, ...rows.map((r) => r.featureId.length))
  const header =
    `  ${'feature'.padEnd(featWidth)}  ${'CRIT'.padStart(4)}  ${'HIGH'.padStart(4)}  ` +
    `${'MED'.padStart(4)}  ${'LOW'.padStart(4)}  ${'TOTAL'.padStart(5)}`
  const sep = `  ${'-'.repeat(featWidth)}  ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(5)}`
  const lines = [header, sep]
  for (const r of rows) {
    lines.push(
      `  ${r.featureId.padEnd(featWidth)}  ${String(r.counts.CRITICAL).padStart(4)}  ` +
        `${String(r.counts.HIGH).padStart(4)}  ${String(r.counts.MEDIUM).padStart(4)}  ` +
        `${String(r.counts.LOW).padStart(4)}  ${String(r.total).padStart(5)}`,
    )
  }
  return lines.join('\n')
}

function formatFeatureSeverityMarkdownTable(records: RepoFindingRecord[]): string {
  const rows = buildFeatureRows(records)
  if (rows.length === 0) return '_(no unresolved findings)_'
  const lines = [
    '| Feature | CRITICAL | HIGH | MEDIUM | LOW | Total |',
    '|---------|---------:|-----:|-------:|----:|------:|',
  ]
  for (const r of rows) {
    lines.push(
      `| \`${r.featureId}\` | ${r.counts.CRITICAL} | ${r.counts.HIGH} | ${r.counts.MEDIUM} | ${r.counts.LOW} | ${r.total} |`,
    )
  }
  return lines.join('\n')
}

function oneLine(s: string): string {
  // Collapse newlines to spaces for terse text output.
  return s.replace(/\s+/g, ' ').trim()
}
