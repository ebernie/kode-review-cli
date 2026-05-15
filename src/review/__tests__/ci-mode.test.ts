import { describe, it, expect, vi } from 'vitest'
import {
  detectCiPlatform,
  extractPrNumber,
  resolveCiExitCode,
  buildCommentPayload,
  parseReviewSummary,
  replaceStickyComment,
  STICKY_MARKER,
  type ReviewSummary,
} from '../ci-mode.js'

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

  it('returns 0 on APPROVE regardless of fail-on', () => {
    expect(resolveCiExitCode(review('APPROVE', 0, 5), 'critical')).toBe(0)
    expect(resolveCiExitCode(review('APPROVE', 3, 2), 'high')).toBe(0)
  })
  it('APPROVE with 5 CRITICAL + fail-on=critical still exits 0 (verdict trumps counts)', () => {
    // Pins the short-circuit ordering: verdict=APPROVE wins over the count
    // check. Guards against a refactor that moves the failOn check above the
    // verdict check.
    expect(resolveCiExitCode(review('APPROVE', 5, 0), 'critical')).toBe(0)
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
