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
  if (summary.verdict === 'APPROVE') return 0
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

/**
 * Parse the model's verdict block out of the review markdown.
 *
 * Parser is intentionally tiny — extracts `Issues Summary: X CRITICAL, ...`
 * counts and the `RECOMMENDATION:` verdict. If either is absent the counts
 * are zero and the verdict defaults to NEEDS_DISCUSSION (the safe default).
 */
export function parseReviewSummary(reviewMarkdown: string): ReviewSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  const summaryMatch = /Issues Summary:\s*(\d+)\s*CRITICAL,\s*(\d+)\s*HIGH,\s*(\d+)\s*MEDIUM,\s*(\d+)\s*LOW/i.exec(reviewMarkdown)
  if (summaryMatch) {
    counts.critical = Number(summaryMatch[1])
    counts.high = Number(summaryMatch[2])
    counts.medium = Number(summaryMatch[3])
    counts.low = Number(summaryMatch[4])
  }
  const verdictMatch = /RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/.exec(reviewMarkdown)
  const verdict = verdictMatch?.[1] ?? 'NEEDS_DISCUSSION'
  return { verdict, issuesByCount: counts }
}
