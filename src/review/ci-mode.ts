/**
 * CI-mode helpers.
 *
 * The orchestration (replaceStickyComment) is exposed as a pure function over
 * a `CiCommentRunner` interface so it can be unit-tested without invoking
 * gh / glab. The platform-specific runners live in this file and are the
 * only code paths that actually call gh / glab.
 */

import { exec as runProcess } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import { FINDINGS_FENCE_TAG, parseFindingsBlock } from './finding-parser.js'
import type { Finding } from './finding-schema.js'
import {
  filterSuppressedFindings,
  filterSuppressedStructuredFindings,
} from './suppressions.js'
import { formatUsageOneLiner, sumUsage, type UsageTotals } from './usage.js'

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

export const STICKY_MARKER = '<!-- kode-review:sticky -->'

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
  if (!iid) return null
  const n = Number(iid)
  return Number.isFinite(n) ? n : null
}

export function resolveCiExitCode(summary: ReviewSummary, failOn: FailOn): number {
  if (failOn === 'none') return 0
  // Evaluate severity counts FIRST and only honor an APPROVE verdict when the
  // counts agree. Callers prefer parsed `kode-findings` counts when available,
  // then fall back to the markdown `Issues Summary`; the verdict is advisory.
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
 * Order matters: post the new comment BEFORE deleting prior ones so a
 * transient failure never leaves the PR review-less. If listing fails
 * (network/rate-limit), fall back to plain post — better to leave duplicate
 * stickies than no review at all.
 */
export async function replaceStickyComment(
  runner: CiCommentRunner,
  _prNumber: number,
  payload: string,
): Promise<boolean> {
  let priors: CiComment[] = []
  let listFailed = false
  try {
    const all = await runner.list()
    priors = all.filter((c) => c.body.includes(STICKY_MARKER))
  } catch (err) {
    listFailed = true
    logger.warn(
      `Could not list prior comments — posting without sticky replacement: ${(err as Error).message}`,
    )
  }

  if (listFailed) {
    const fallback = await runner.post(payload)
    return fallback.ok
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
 * GitHub runner — uses gh api for list/delete (needed to get comment IDs)
 * and gh pr comment for post.
 */
export function githubRunner(prNumber: number, repoRoot: string): CiCommentRunner {
  return {
    async list(): Promise<CiComment[]> {
      const r = await runProcess(
        'gh',
        [
          'api',
          '--paginate',
          `repos/{owner}/{repo}/issues/${prNumber}/comments`,
          '--jq',
          '[.[] | {id, body}]',
        ],
        { cwd: repoRoot },
      )
      if (r.exitCode !== 0) throw new Error(r.stderr || 'gh api list failed')
      const raw = r.stdout.trim()
      if (!raw) return []
      const pieces = raw.split('\n').filter((line) => line.trim().startsWith('['))
      const out: CiComment[] = []
      for (const piece of pieces) {
        const parsed = JSON.parse(piece) as CiComment[]
        out.push(...parsed)
      }
      return out
    },
    async post(body: string) {
      const r = await runProcess('gh', ['pr', 'comment', String(prNumber), '--body', body], { cwd: repoRoot })
      return { ok: r.exitCode === 0 }
    },
    async del(commentId: number) {
      const r = await runProcess(
        'gh',
        ['api', '-X', 'DELETE', `repos/{owner}/{repo}/issues/comments/${commentId}`],
        { cwd: repoRoot },
      )
      return r.exitCode === 0
    },
  }
}

/**
 * GitLab runner — uses glab api for list/delete and glab mr note for post.
 */
export function gitlabRunner(prNumber: number, repoRoot: string): CiCommentRunner {
  return {
    async list(): Promise<CiComment[]> {
      const r = await runProcess(
        'glab',
        ['api', `projects/:id/merge_requests/${prNumber}/notes`],
        { cwd: repoRoot },
      )
      if (r.exitCode !== 0) throw new Error(r.stderr || 'glab api list failed')
      const raw = JSON.parse(r.stdout || '[]') as Array<{ id: number; body: string }>
      return raw.map((n) => ({ id: n.id, body: n.body }))
    },
    async post(body: string) {
      const r = await runProcess(
        'glab',
        ['mr', 'note', String(prNumber), '--message', body],
        { cwd: repoRoot },
      )
      return { ok: r.exitCode === 0 }
    },
    async del(commentId: number) {
      const r = await runProcess(
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

const ISSUES_SUMMARY_RE = /Issues Summary:\s*(\d+)\s*CRITICAL,\s*(\d+)\s*HIGH,\s*(\d+)\s*MEDIUM,\s*(\d+)\s*LOW/i
const VERDICT_RE = /RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/
const FINDINGS_BLOCK_RE = new RegExp(
  '^```' + FINDINGS_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function countFindingsBySeverity(
  findings: readonly Pick<Finding, 'severity'>[],
): ReviewSummary['issuesByCount'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of findings) {
    counts[finding.severity.toLowerCase() as keyof ReviewSummary['issuesByCount']] += 1
  }
  return counts
}

function formatCounts(counts: ReviewSummary['issuesByCount']): string {
  return `${counts.critical} CRITICAL, ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW`
}

function countsEqual(
  a: ReviewSummary['issuesByCount'],
  b: ReviewSummary['issuesByCount'],
): boolean {
  return a.critical === b.critical && a.high === b.high && a.medium === b.medium && a.low === b.low
}

function replaceLastFindingsBlock(reviewMarkdown: string, findings: readonly Finding[]): string {
  const matches: RegExpExecArray[] = []
  FINDINGS_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FINDINGS_BLOCK_RE.exec(reviewMarkdown)) !== null) {
    matches.push(match)
  }
  const last = matches[matches.length - 1]
  if (!last) return reviewMarkdown

  const replacement = [
    '```' + FINDINGS_FENCE_TAG,
    JSON.stringify({ findings }, null, 2),
    '```',
  ].join('\n')
  return reviewMarkdown.slice(0, last.index) +
    replacement +
    reviewMarkdown.slice(last.index + last[0].length)
}

export interface ParseReviewSummaryOptions {
  /**
   * Structured findings parsed from a valid `kode-findings` block after
   * suppression filtering. When present, these counts drive CI; markdown
   * counts remain a fallback for legacy/malformed outputs.
   */
  findings?: readonly Finding[]
}

export interface ApplyReviewFiltersForCiOptions {
  /** Structured findings returned by the review engine, if already parsed. */
  findings?: readonly Finding[]
  /** Whether source-code suppression markers should filter markdown and structured findings. */
  suppressionsEnabled: boolean
}

export interface ApplyReviewFiltersForCiResult {
  content: string
  suppressedCount: number
  summary: ReviewSummary
}

/**
 * Parse the model's verdict block out of the review markdown.
 *
 * CI counts come from structured `kode-findings` when the caller supplies
 * them. If the structured block is missing or invalid, this falls back to the
 * markdown `Issues Summary`. The verdict defaults to NEEDS_DISCUSSION when
 * absent, but it does not override severity counts.
 */
export function parseReviewSummary(
  reviewMarkdown: string,
  options: ParseReviewSummaryOptions = {},
): ReviewSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  const summaryMatch = ISSUES_SUMMARY_RE.exec(reviewMarkdown)
  if (summaryMatch) {
    counts.critical = Number(summaryMatch[1])
    counts.high = Number(summaryMatch[2])
    counts.medium = Number(summaryMatch[3])
    counts.low = Number(summaryMatch[4])
  }
  const structuredCounts = options.findings
    ? countFindingsBySeverity(options.findings)
    : undefined
  if (structuredCounts && summaryMatch && !countsEqual(counts, structuredCounts)) {
    logger.warn(
      `Structured kode-findings count (${formatCounts(structuredCounts)}) does not match Issues Summary (${formatCounts(counts)}); using structured findings for CI.`,
    )
  }
  const verdictMatch = VERDICT_RE.exec(reviewMarkdown)
  const verdict = verdictMatch?.[1] ?? 'NEEDS_DISCUSSION'
  return { verdict, issuesByCount: structuredCounts ?? counts }
}

/**
 * Apply post-review filtering and build the summary that CI gates evaluate.
 *
 * This is intentionally independent from sticky-comment posting so the
 * markdown/structured-finding adapter can be unit-tested without importing
 * the CLI entrypoint.
 */
export async function applyReviewFiltersForCi(
  rawContent: string,
  repoRoot: string,
  options: ApplyReviewFiltersForCiOptions,
): Promise<ApplyReviewFiltersForCiResult> {
  const parsedFindings = parseFindingsBlock(rawContent)
  let findingsForCi = parsedFindings.error
    ? undefined
    : (options.findings ?? parsedFindings.findings)

  let reviewContent = rawContent
  let suppressedCount = 0
  if (options.suppressionsEnabled) {
    const filteredMarkdown = await filterSuppressedFindings(rawContent, repoRoot)
    reviewContent = filteredMarkdown.filtered
    suppressedCount = filteredMarkdown.suppressedCount

    if (findingsForCi) {
      const structured = await filterSuppressedStructuredFindings(findingsForCi, repoRoot)
      findingsForCi = structured.kept
      reviewContent = replaceLastFindingsBlock(reviewContent, findingsForCi)
    }
  }

  return {
    content: reviewContent,
    suppressedCount,
    summary: parseReviewSummary(reviewContent, { findings: findingsForCi }),
  }
}

/**
 * Build a single composite sticky body for a multi-reviewer run: one
 * `## <reviewer-name>` section per successful reviewer, separated by `---`,
 * with a trailing usage footer summing tokens/cost across reviewers.
 *
 * Posted ONCE per run under the shared sticky marker — replaces the prior
 * per-reviewer posting pattern which raced N reviewers under one marker
 * and left only the last one's comment surviving.
 */
export function buildCompositeCiCommentBody(
  successfulResults: ReadonlyArray<{
    reviewer: { name: string }
    content: string
    usage?: UsageTotals
  }>,
): string {
  if (successfulResults.length === 0) {
    return `_No reviewer produced output._\n\n---\n_${formatUsageOneLiner(undefined)}_`
  }
  const sections = successfulResults.map(
    (r) => `## ${r.reviewer.name}\n\n${r.content.trim()}`,
  )
  const totalUsage = sumUsage(
    successfulResults
      .map((r) => r.usage)
      .filter((u): u is UsageTotals => u !== undefined),
  )
  const noun = successfulResults.length === 1 ? 'reviewer' : 'reviewers'
  const footer = `---\n_${formatUsageOneLiner(totalUsage)} (across ${successfulResults.length} ${noun})_`
  return `${sections.join('\n\n---\n\n')}\n\n${footer}`
}
