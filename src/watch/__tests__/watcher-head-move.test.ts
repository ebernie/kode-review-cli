import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Finding } from '../../review/finding-schema.js'
import type { ReviewRequest } from '../types.js'

/**
 * Test strategy:
 *
 * The watcher's internal `reviewRequest` calls `revalidateRequest` via a
 * lexical reference, so we can't intercept that with `vi.spyOn` on the
 * exported binding. Instead we mock the two dependencies the real
 * `revalidateRequest` calls into (`runReview` from review/engine and
 * `parseRevalidationBlock` from review/revalidate-prompt) — that lets each
 * test drive both the revalidation outcome and the fresh-review outcome
 * end-to-end without needing the pi SDK.
 *
 * `runReview` is invoked twice in the head-move-with-priors path:
 *   1. by `revalidateRequest` (carries `userPromptOverride`)
 *   2. by the fresh-review block (no `userPromptOverride`)
 * We discriminate the two calls by inspecting `userPromptOverride` and
 * return different shaped results for each.
 */

const captured: {
  runReviewCalls: any[]
  markReviewedCalls: any[]
  priorOutcome: any | undefined
  headRef: string | undefined
  // Per-test outputs from runReview
  revalidationContent: string
  freshFindings: Finding[]
  freshContent: string
  // Per-test parser result for revalidation block
  parserResult: { outcomes?: any[]; error?: string; detail?: string }
  // If set, runReview throws on the revalidation call to simulate transient failure.
  revalidationThrows: Error | null
} = {
  runReviewCalls: [],
  markReviewedCalls: [],
  priorOutcome: undefined,
  headRef: undefined,
  revalidationContent: '',
  freshFindings: [],
  freshContent: 'fresh review',
  parserResult: { outcomes: [] },
  revalidationThrows: null,
}

vi.mock('../../vcs/github.js', () => ({
  getGitHubPRDiff: vi.fn(async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n'),
  getGitHubPRInfo: vi.fn(async () => ({ headRefOid: captured.headRef ?? 'unknown-head' })),
}))

vi.mock('../../vcs/gitlab.js', () => ({
  getGitLabMRDiff: vi.fn(async () => 'diff'),
  getGitLabMRInfo: vi.fn(async () => ({ sha: captured.headRef ?? 'unknown-head' })),
}))

vi.mock('../../review/engine.js', () => ({
  runReview: vi.fn(async (opts: any) => {
    captured.runReviewCalls.push(opts)
    const isRevalidation = typeof opts.userPromptOverride === 'string'
    if (isRevalidation) {
      if (captured.revalidationThrows) throw captured.revalidationThrows
      return { content: captured.revalidationContent, findings: [] }
    }
    return { content: captured.freshContent, findings: captured.freshFindings }
  }),
}))

vi.mock('../../review/revalidate-prompt.js', () => ({
  // Return the new BuiltRevalidatePrompt shape: { systemPrompt, userPrompt }.
  // The watch flow destructures both halves and passes systemPrompt to
  // runReview so the UNTRUSTED_CONTENT_BOUNDARY makes it into the model
  // context.
  buildRevalidatePrompt: vi.fn(() => ({
    systemPrompt: 'revalidate system',
    userPrompt: 'revalidate prompt',
  })),
  parseRevalidationBlock: vi.fn(() => captured.parserResult),
}))

vi.mock('@inquirer/prompts', () => ({ select: vi.fn(async () => null) }))

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn(() => ({ stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() })),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
}))

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../state.js', () => {
  class FakeWatchStateManager {
    getPath() {
      return '/tmp/fake-state.json'
    }
    getReviewedCount() {
      return 0
    }
    getOutcome() {
      return captured.priorOutcome
    }
    hasBeenReviewed() {
      return captured.priorOutcome !== undefined
    }
    markReviewed(outcome: any) {
      captured.markReviewedCalls.push(outcome)
    }
    updateLastPollTime() {}
  }
  return { WatchStateManager: FakeWatchStateManager }
})

const watcherModule = await import('../watcher.js')
const { reviewRequest } = watcherModule
const { WatchStateManager } = await import('../state.js')

const baseRequest: ReviewRequest = {
  platform: 'github',
  id: 42,
  title: 'A test PR',
  url: 'https://github.com/o/r/pull/42',
  repository: 'o/r',
  updatedAt: '2026-05-19T00:00:00Z',
  state: 'open',
}

function makeFinding(title: string, severity: Finding['severity'] = 'HIGH'): Finding {
  return {
    title,
    severity,
    category: 'correctness',
    confidence: 'HIGH',
    file: 'src/x.ts',
    lineStart: 1,
    lineEnd: 1,
    evidence: 'line',
    problem: 'p',
    recommendation: 'r',
  }
}

const cliOptions: any = { model: undefined }
const ctx: any = { quiet: true }

const OLD_HEAD = 'oldhead0000000000000000000000000000000000'
const NEW_HEAD = 'newhead0000000000000000000000000000000000'

beforeEach(() => {
  captured.runReviewCalls = []
  captured.markReviewedCalls = []
  captured.priorOutcome = undefined
  captured.headRef = NEW_HEAD
  captured.revalidationContent = ''
  captured.freshFindings = []
  captured.freshContent = 'fresh review'
  captured.parserResult = { outcomes: [] }
  captured.revalidationThrows = null
})

describe('reviewRequest head-move flow', () => {
  it('skips entirely when head is unchanged (no revalidation, no fresh review, no state write)', async () => {
    captured.headRef = OLD_HEAD
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: [makeFinding('Old finding')],
    }

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    expect(captured.runReviewCalls).toHaveLength(0)
    expect(captured.markReviewedCalls).toHaveLength(0)
  })

  it('runs fresh review only when head moved but there are no prior findings', async () => {
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: [],
    }
    captured.freshFindings = [makeFinding('Fresh issue', 'CRITICAL')]

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    // Exactly one runReview call, and it's the fresh-review one (no override).
    expect(captured.runReviewCalls).toHaveLength(1)
    expect(captured.runReviewCalls[0].userPromptOverride).toBeUndefined()

    expect(captured.markReviewedCalls).toHaveLength(1)
    const persisted = captured.markReviewedCalls[0]
    expect(persisted.headRef).toBe(NEW_HEAD)
    expect(persisted.findings).toHaveLength(1)
    expect(persisted.findings[0].title).toBe('Fresh issue')
  })

  it('runs BOTH revalidation and fresh review when head moved with prior findings, merging results into a single write', async () => {
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: [makeFinding('Old issue', 'HIGH')],
    }
    // Revalidation marks the prior as still-present.
    captured.parserResult = {
      outcomes: [
        { findingTitle: 'Old issue', status: 'still-present', rationale: 'still there' },
      ],
    }
    captured.freshFindings = [makeFinding('New issue', 'CRITICAL')]

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    // Two runReview calls: revalidation (has override) + fresh review.
    expect(captured.runReviewCalls).toHaveLength(2)
    const revalCall = captured.runReviewCalls.find((c) => c.userPromptOverride)
    const freshCall = captured.runReviewCalls.find((c) => !c.userPromptOverride)
    expect(revalCall).toBeDefined()
    expect(freshCall).toBeDefined()

    // Single markReviewed write under the new head, carrying both findings.
    expect(captured.markReviewedCalls).toHaveLength(1)
    const persisted = captured.markReviewedCalls[0]
    expect(persisted.headRef).toBe(NEW_HEAD)
    expect(persisted.findings).toHaveLength(2)
    const titles = persisted.findings.map((f: Finding) => f.title).sort()
    expect(titles).toEqual(['New issue', 'Old issue'])
  })

  it('dedups by title with the fresh review winning on collision', async () => {
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: [makeFinding('Same title', 'LOW')],
    }
    captured.parserResult = {
      outcomes: [
        { findingTitle: 'Same title', status: 'still-present', rationale: 'still' },
      ],
    }
    captured.freshFindings = [makeFinding('Same title', 'CRITICAL')]

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    expect(captured.markReviewedCalls).toHaveLength(1)
    const persisted = captured.markReviewedCalls[0]
    expect(persisted.findings).toHaveLength(1)
    // Fresh wins on title collision.
    expect(persisted.findings[0].severity).toBe('CRITICAL')
  })

  it('still runs fresh review and persists priors+fresh when revalidation throws (ok:false)', async () => {
    const priorFindings = [makeFinding('Prior issue', 'HIGH')]
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: priorFindings,
    }
    // Make the revalidation runReview throw — the function now catches that
    // and returns ok:false with priorFindings as survivors.
    captured.revalidationThrows = new Error('parse failure')
    captured.freshFindings = [makeFinding('Fresh issue', 'CRITICAL')]

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    // Two runReview calls: revalidation (threw) + fresh review.
    expect(captured.runReviewCalls).toHaveLength(2)

    expect(captured.markReviewedCalls).toHaveLength(1)
    const persisted = captured.markReviewedCalls[0]
    expect(persisted.success).toBe(true)
    expect(persisted.headRef).toBe(NEW_HEAD)
    const titles = persisted.findings.map((f: Finding) => f.title).sort()
    expect(titles).toEqual(['Fresh issue', 'Prior issue'])
  })

  it('still runs fresh review when revalidation parser returns an error (ok:true with priors retained)', async () => {
    const priorFindings = [makeFinding('Prior issue', 'HIGH')]
    captured.priorOutcome = {
      key: 'github:o/r:42',
      success: true,
      reviewedAt: '2026-05-18T00:00:00Z',
      headRef: OLD_HEAD,
      findings: priorFindings,
    }
    // Parser returns an error — revalidate keeps priors as-is and returns ok:true.
    captured.parserResult = { error: 'malformed', detail: 'nope', outcomes: [] }
    captured.freshFindings = [makeFinding('Fresh issue', 'CRITICAL')]

    const stateManager = new (WatchStateManager as any)()
    await reviewRequest(baseRequest, cliOptions, ctx, stateManager)

    expect(captured.runReviewCalls).toHaveLength(2)
    expect(captured.markReviewedCalls).toHaveLength(1)
    const persisted = captured.markReviewedCalls[0]
    const titles = persisted.findings.map((f: Finding) => f.title).sort()
    expect(titles).toEqual(['Fresh issue', 'Prior issue'])
  })
})

describe('mergeFindingsByTitle', () => {
  it('returns empty when both inputs are empty', () => {
    expect(watcherModule.mergeFindingsByTitle([], [])).toEqual([])
  })

  it('returns the other list verbatim when one side is empty', () => {
    const a = [makeFinding('A')]
    expect(watcherModule.mergeFindingsByTitle(a, [])).toEqual(a)
    expect(watcherModule.mergeFindingsByTitle([], a)).toEqual(a)
  })

  it('lets later findings override earlier on title collision', () => {
    const earlier = [makeFinding('Same', 'LOW')]
    const later = [makeFinding('Same', 'CRITICAL')]
    const merged = watcherModule.mergeFindingsByTitle(earlier, later)
    expect(merged).toHaveLength(1)
    expect(merged[0].severity).toBe('CRITICAL')
  })

  it('preserves distinct titles from both sides', () => {
    const merged = watcherModule.mergeFindingsByTitle(
      [makeFinding('A')],
      [makeFinding('B')],
    )
    expect(merged.map((f) => f.title).sort()).toEqual(['A', 'B'])
  })
})
