import { describe, it, expect, vi } from 'vitest'
import {
  detectCiPlatform,
  extractPrNumber,
  resolveCiExitCode,
  buildCommentPayload,
  buildCompositeCiCommentBody,
  parseReviewSummary,
  replaceStickyComment,
  STICKY_MARKER,
  type ReviewSummary,
} from '../ci-mode.js'
import type { UsageTotals } from '../usage.js'

function usage(totalTokens: number, costTotal: number): UsageTotals {
  return {
    input: totalTokens / 2,
    output: totalTokens / 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    assistantMessages: 1,
  }
}

describe('detectCiPlatform', () => {
  it('detects GitHub Actions from GITHUB_ACTIONS=true', () => {
    expect(detectCiPlatform({ GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv)).toBe('github')
  })
  it('detects GitLab CI from GITLAB_CI=true', () => {
    expect(detectCiPlatform({ GITLAB_CI: 'true' } as NodeJS.ProcessEnv)).toBe('gitlab')
  })
  it('returns null when neither is set', () => {
    expect(detectCiPlatform({} as NodeJS.ProcessEnv)).toBe(null)
  })
  it('returns null when GITHUB_ACTIONS is "false" (case-sensitive equality on "true")', () => {
    expect(detectCiPlatform({ GITHUB_ACTIONS: 'false' } as NodeJS.ProcessEnv)).toBe(null)
  })
  it('returns null when GITLAB_CI is "false" (symmetric to the GH boundary)', () => {
    expect(detectCiPlatform({ GITLAB_CI: 'false' } as NodeJS.ProcessEnv)).toBe(null)
  })
})

describe('extractPrNumber', () => {
  it('reads GITHUB_REF for pull_request events', () => {
    expect(extractPrNumber('github', { GITHUB_REF: 'refs/pull/42/merge' } as NodeJS.ProcessEnv)).toBe(42)
  })
  it('returns null for non-PR GITHUB_REF (e.g., push to main)', () => {
    expect(extractPrNumber('github', { GITHUB_REF: 'refs/heads/main' } as NodeJS.ProcessEnv)).toBe(null)
  })
  it('reads CI_MERGE_REQUEST_IID for GitLab', () => {
    expect(extractPrNumber('gitlab', { CI_MERGE_REQUEST_IID: '17' } as NodeJS.ProcessEnv)).toBe(17)
  })
  it('returns null when the env vars are missing', () => {
    expect(extractPrNumber('github', {} as NodeJS.ProcessEnv)).toBe(null)
    expect(extractPrNumber('gitlab', {} as NodeJS.ProcessEnv)).toBe(null)
  })
  it('returns null for non-numeric GitLab IID', () => {
    expect(extractPrNumber('gitlab', { CI_MERGE_REQUEST_IID: 'abc' } as NodeJS.ProcessEnv)).toBe(null)
  })
})

describe('resolveCiExitCode', () => {
  const review = (verdict: string, critical = 0, high = 0): ReviewSummary => ({
    verdict,
    issuesByCount: { critical, high, medium: 0, low: 0 },
  })

  it('returns 0 on APPROVE when counts agree (no critical / high above threshold)', () => {
    // fail-on=critical with APPROVE + 5 HIGH: counts axis tolerates HIGH at
    // this threshold, so the verdict can ride through.
    expect(resolveCiExitCode(review('APPROVE', 0, 5), 'critical')).toBe(0)
  })
  it('fails CI on APPROVE + critical when fail-on=critical (count axis is ground truth)', () => {
    // An LLM that emits APPROVE alongside critical findings is inconsistent
    // (model error, persona drift, or prompt injection). The counts win:
    // a critical finding fails CI even if the verdict says APPROVE.
    expect(resolveCiExitCode(review('APPROVE', 5, 0), 'critical')).toBe(1)
  })
  it('fails CI on APPROVE + high when fail-on=high', () => {
    expect(resolveCiExitCode(review('APPROVE', 0, 2), 'high')).toBe(1)
    expect(resolveCiExitCode(review('APPROVE', 3, 0), 'high')).toBe(1)
  })
  it('returns 1 when fail-on=critical and there is a CRITICAL', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 1, 0), 'critical')).toBe(1)
  })
  it('returns 0 when fail-on=critical and only HIGH findings exist', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 0, 3), 'critical')).toBe(0)
  })
  it('returns 1 when fail-on=high and there is HIGH', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 0, 2), 'high')).toBe(1)
  })
  it('returns 1 when fail-on=high and there is CRITICAL but no HIGH', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 1, 0), 'high')).toBe(1)
  })
  it('returns 0 when fail-on=none even with criticals', () => {
    expect(resolveCiExitCode(review('REQUEST_CHANGES', 3, 0), 'none')).toBe(0)
  })
})

describe('buildCommentPayload', () => {
  it('wraps content with a sticky-comment marker so re-runs replace it', () => {
    const out = buildCommentPayload('## Review\n\nLGTM.')
    expect(out).toMatch(new RegExp(STICKY_MARKER))
    expect(out).toContain('LGTM.')
  })

  it('places the marker on its own line at the start', () => {
    const out = buildCommentPayload('body')
    expect(out.split('\n')[0]).toBe(STICKY_MARKER)
  })
})

describe('parseReviewSummary', () => {
  it('parses verdict and counts from a typical review', () => {
    const md = `
## Review

RECOMMENDATION: REQUEST_CHANGES
Issues Summary: 2 CRITICAL, 1 HIGH, 0 MEDIUM, 3 LOW
`
    const s = parseReviewSummary(md)
    expect(s.verdict).toBe('REQUEST_CHANGES')
    expect(s.issuesByCount).toEqual({ critical: 2, high: 1, medium: 0, low: 3 })
  })

  it('falls back to NEEDS_DISCUSSION + zero counts when verdict is absent', () => {
    expect(parseReviewSummary('totally unstructured text')).toEqual({
      verdict: 'NEEDS_DISCUSSION',
      issuesByCount: { critical: 0, high: 0, medium: 0, low: 0 },
    })
  })

  it('parses APPROVE without any issue counts', () => {
    expect(parseReviewSummary('RECOMMENDATION: APPROVE\n')).toEqual({
      verdict: 'APPROVE',
      issuesByCount: { critical: 0, high: 0, medium: 0, low: 0 },
    })
  })
})

describe('replaceStickyComment', () => {
  function makeRunner(initial: Array<{ id: number; body: string }>) {
    const log: string[] = []
    return {
      log,
      runner: {
        list: vi.fn(async () => initial),
        post: vi.fn(async (body: string) => {
          log.push(`post:${body.slice(0, 32)}`)
          return { ok: true, id: 999 }
        }),
        del: vi.fn(async (id: number) => {
          log.push(`delete:${id}`)
          return true
        }),
      },
    }
  }

  const STICKY = STICKY_MARKER

  it('posts new BEFORE deleting prior — never leaves the PR review-less', async () => {
    const { log, runner } = makeRunner([{ id: 1, body: `${STICKY}\n\nold review` }])
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
      list: vi.fn(async () => [{ id: 1, body: `${STICKY}\n\nold` }]),
      post: vi.fn(async () => ({ ok: false })),
      del: vi.fn(async (id: number) => {
        log.push(`delete:${id}`)
        return true
      }),
    }
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(ok).toBe(false)
    expect(log).toEqual([])
  })

  it('falls back to plain post when listing fails', async () => {
    const log: string[] = []
    const runner = {
      list: vi.fn(async () => {
        throw new Error('rate limited')
      }),
      post: vi.fn(async (body: string) => {
        log.push(`post:${body.slice(0, 16)}`)
        return { ok: true, id: 7 }
      }),
      del: vi.fn(async () => true),
    }
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(ok).toBe(true)
    expect(log[0]).toMatch(/^post:/)
    expect(runner.del).not.toHaveBeenCalled()
  })

  it('logs a warning but still returns true when a delete fails', async () => {
    const runner = {
      list: vi.fn(async () => [{ id: 7, body: `${STICKY}\n\nold` }]),
      post: vi.fn(async () => ({ ok: true, id: 8 })),
      del: vi.fn(async () => false),
    }
    const ok = await replaceStickyComment(runner, 42, `${STICKY}\n\nnew`)
    expect(ok).toBe(true)
    expect(runner.del).toHaveBeenCalledWith(7)
  })
})

describe('buildCompositeCiCommentBody', () => {
  it('produces one section per reviewer with the reviewer name as heading, preserving input order', () => {
    const body = buildCompositeCiCommentBody([
      { reviewer: { name: 'security' }, content: 'sec findings', usage: usage(100, 0.01) },
      { reviewer: { name: 'architect' }, content: 'arch findings', usage: usage(200, 0.02) },
    ])
    // Each reviewer's section starts with a `## <name>` heading.
    expect(body).toMatch(/## security\n\nsec findings/)
    expect(body).toMatch(/## architect\n\narch findings/)
    // Direct order check: `security` must come before `architect` in the output.
    // (Indirectly checking via `indexOf('---')` would pass under a reversed-
    // section regression because the footer also contains a `---`.)
    expect(body.indexOf('## security')).toBeLessThan(body.indexOf('## architect'))
  })

  it('aggregates token AND cost totals across reviewers in the footer', () => {
    const body = buildCompositeCiCommentBody([
      { reviewer: { name: 'security' }, content: 'a', usage: usage(100, 0.01) },
      { reviewer: { name: 'architect' }, content: 'b', usage: usage(250, 0.025) },
    ])
    // Tokens: 100 + 250 = 350
    expect(body).toMatch(/Tokens: 350 total/)
    // Cost: 0.01 + 0.025 = 0.035 (rendered to 4 decimal places by formatCost).
    // Locking in the cost path catches a sumUsage bug that drops cost.* fields
    // even when totalTokens still adds correctly.
    expect(body).toMatch(/Cost: \$0\.0350 \(est\.\)/)
    expect(body).toMatch(/across 2 reviewers/)
  })

  it('singular "reviewer" when exactly one reviewer succeeded', () => {
    const body = buildCompositeCiCommentBody([
      { reviewer: { name: 'general' }, content: 'g', usage: usage(50, 0.005) },
    ])
    expect(body).toMatch(/across 1 reviewer\)/)
    expect(body).not.toMatch(/reviewers\)/)
  })

  it('handles reviewers without usage (failure-derived undefined)', () => {
    const body = buildCompositeCiCommentBody([
      { reviewer: { name: 'security' }, content: 'a', usage: usage(100, 0.01) },
      { reviewer: { name: 'architect' }, content: 'b' }, // no usage
    ])
    // The non-usage reviewer still gets a section and is counted in "across N".
    expect(body).toMatch(/## architect/)
    expect(body).toMatch(/across 2 reviewers/)
    // Aggregated tokens reflect only the reviewer that reported usage.
    expect(body).toMatch(/Tokens: 100 total/)
  })

  it('emits an "n/a" footer with a placeholder section when no reviewers succeeded', () => {
    const body = buildCompositeCiCommentBody([])
    expect(body).toMatch(/No reviewer produced output/)
    expect(body).toMatch(/Token usage and cost: n\/a/)
  })

  it('trims trailing whitespace on per-reviewer content so sections stay tight', () => {
    const body = buildCompositeCiCommentBody([
      { reviewer: { name: 'general' }, content: 'g\n\n\n', usage: usage(50, 0.005) },
    ])
    // Positive shape: trimmed content sits exactly one blank line before the
    // separator. A regression that replaced `trim()` with a "leave one trailing
    // newline" rule would still satisfy the negative-only assertion below.
    expect(body).toMatch(/g\n\n---/)
    expect(body).not.toMatch(/g\n\n\n+---/)
  })
})
