import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FINDINGS_BLOCK_INSTRUCTIONS } from '../../review/prompt.js'
import { UNTRUSTED_CONTENT_BOUNDARY } from '../../review/untrusted-boundary.js'
import type { UsageTotals } from '../../review/usage.js'

// Capture every invocation of the underlying engine so we can verify that
// each reviewer ran with the correct system prompt and that all reviewers
// ran in parallel rather than serially.
interface CapturedRun {
  systemPrompt?: string
  userPromptOverride?: string
  model?: string
  timeoutMs?: number
  releasedAt: number
}

// Mirror of `ReviewOptions` (the surface the runner actually uses). Kept as
// an explicit shape so the test mock isn't typed as `any`.
interface CapturedOptions {
  systemPrompt?: string
  userPromptOverride?: string
  model?: string
  timeoutMs?: number
}

// `usage` is the optional field threaded through ReviewerRunResult — when
// present in the mock's return value, the runner forwards it onto the result.
// Keeping it on the canonical mock signature means a `UsageTotals` shape
// regression is a compile error in the test file, not a silently-passing cast.
const captured: CapturedRun[] = []
let runReviewImpl: (opts: CapturedOptions) => Promise<{ content: string; usage?: UsageTotals }> = async () => ({
  content: 'default',
})

// Separate capture / impl for the agentic engine so the two paths can be
// asserted independently and never cross-contaminate.
const capturedAgentic: CapturedRun[] = []
let runAgenticImpl: (
  opts: CapturedOptions,
) => Promise<{
  content: string
  toolCallCount: number
  truncated: boolean
  truncationReason?: string
  usage?: UsageTotals
}> = async () => ({
  content: 'default-agentic',
  toolCallCount: 0,
  truncated: false,
})

vi.mock('../../review/engine.js', () => ({
  runReview: vi.fn(async (opts: CapturedOptions) => runReviewImpl(opts)),
  runAgenticReview: vi.fn(async (opts: CapturedOptions) => runAgenticImpl(opts)),
}))

import {
  BUILTIN_REVIEWER_NAMES,
  clearReviewerPromptCacheForTests,
  resolveReviewerNames,
  runReviewers,
  runAgenticReviewers,
} from '../index.js'

describe('resolveReviewerNames', () => {
  let tmp: string
  let originalEnv: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kode-review-runner-'))
    originalEnv = process.env.KODE_REVIEW_REVIEWERS_DIR
    process.env.KODE_REVIEW_REVIEWERS_DIR = tmp
    clearReviewerPromptCacheForTests()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KODE_REVIEW_REVIEWERS_DIR
    } else {
      process.env.KODE_REVIEW_REVIEWERS_DIR = originalEnv
    }
    rmSync(tmp, { recursive: true, force: true })
    clearReviewerPromptCacheForTests()
  })

  it('resolves a single built-in', () => {
    const result = resolveReviewerNames(['security'])
    expect(result.map((r) => r.name)).toEqual(['security'])
  })

  it('preserves order and deduplicates', () => {
    const result = resolveReviewerNames(['architect', 'security', 'architect'])
    expect(result.map((r) => r.name)).toEqual(['architect', 'security'])
  })

  it('expands `all` to every built-in plus user-defined reviewers', () => {
    writeFileSync(join(tmp, 'performance.md'), 'P')
    const result = resolveReviewerNames(['all'])
    // Built-ins come first in their canonical (registry) order, then any
    // user-defined reviewer names not shadowing a built-in (alphabetical).
    // Deriving the expected list from BUILTIN_REVIEWER_NAMES rather than a
    // hard-coded snapshot means adding a new built-in won't silently
    // surprise this test with a misleading diff.
    expect(result.map((r) => r.name)).toEqual([
      ...BUILTIN_REVIEWER_NAMES,
      'performance',
    ])
  })

  it('throws on empty input', () => {
    expect(() => resolveReviewerNames([])).toThrow(/At least one reviewer/)
  })

  it('throws on unknown reviewer names', () => {
    expect(() => resolveReviewerNames(['unknown-thing'])).toThrow(/Unknown reviewer/)
  })

  it('allows user-defined reviewers to be selected by name', () => {
    writeFileSync(join(tmp, 'performance.md'), 'P')
    const result = resolveReviewerNames(['performance'])
    expect(result.map((r) => r.name)).toEqual(['performance'])
    expect(result[0].builtin).toBe(false)
  })
})

describe('runReviewers — parallel orchestration', () => {
  let tmp: string
  let originalEnv: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kode-review-runner-'))
    originalEnv = process.env.KODE_REVIEW_REVIEWERS_DIR
    process.env.KODE_REVIEW_REVIEWERS_DIR = tmp
    clearReviewerPromptCacheForTests()
    captured.length = 0
    runReviewImpl = async (opts) => {
      captured.push({
        systemPrompt: opts.systemPrompt,
        userPromptOverride: opts.userPromptOverride,
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        releasedAt: Date.now(),
      })
      return { content: `REVIEW from system: ${String(opts.systemPrompt).slice(0, 40)}` }
    }
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KODE_REVIEW_REVIEWERS_DIR
    } else {
      process.env.KODE_REVIEW_REVIEWERS_DIR = originalEnv
    }
    rmSync(tmp, { recursive: true, force: true })
    clearReviewerPromptCacheForTests()
  })

  it('sends each reviewer its own system prompt and a shared user prompt', async () => {
    const reviewers = resolveReviewerNames(['security', 'architect'])
    await runReviewers({
      reviewers,
      data: { context: 'ctx', diffContent: 'd' },
    })

    expect(captured).toHaveLength(2)
    // Each reviewer gets its OWN system prompt.
    const systemPrompts = new Set(captured.map((r) => r.systemPrompt))
    expect(systemPrompts.size).toBe(2)
    // The user prompt body is identical across reviewers — that's the whole
    // point of the shared data-prompt builder.
    const userPrompts = new Set(captured.map((r) => r.userPromptOverride))
    expect(userPrompts.size).toBe(1)
    // The system prompts are the actual built-in templates (not legacy).
    expect(
      captured.find((r) => /senior application security engineer/i.test(String(r.systemPrompt))),
    ).toBeDefined()
    expect(
      captured.find((r) => /staff-level software architect/i.test(String(r.systemPrompt))),
    ).toBeDefined()
  })

  it('appends the shared untrusted-content boundary to reviewer system prompts', async () => {
    writeFileSync(join(tmp, 'performance.md'), 'PERFORMANCE REVIEWER TEMPLATE')
    const reviewers = resolveReviewerNames(['security', 'performance'])
    await runReviewers({
      reviewers,
      data: { context: 'ctx', diffContent: 'd' },
    })

    expect(captured).toHaveLength(2)
    const securityPrompt = captured.find((r) =>
      String(r.systemPrompt).includes('senior application security engineer'),
    )?.systemPrompt
    const customPrompt = captured.find((r) =>
      String(r.systemPrompt).includes('PERFORMANCE REVIEWER TEMPLATE'),
    )?.systemPrompt
    expect(securityPrompt).toContain(UNTRUSTED_CONTENT_BOUNDARY)
    expect(customPrompt).toContain(UNTRUSTED_CONTENT_BOUNDARY)
  })

  it('requires kode-findings in reviewer system prompts, including custom reviewers', async () => {
    writeFileSync(join(tmp, 'performance.md'), 'PERFORMANCE REVIEWER TEMPLATE')
    const reviewers = resolveReviewerNames(['security', 'performance'])
    await runReviewers({
      reviewers,
      data: { context: 'ctx', diffContent: 'd' },
    })

    expect(captured).toHaveLength(2)
    for (const run of captured) {
      expect(run.systemPrompt).toContain(FINDINGS_BLOCK_INSTRUCTIONS)
      expect(run.systemPrompt).toMatch(/REQUIRED.*kode-findings/i)
    }
  })

  it('runs reviewers in parallel, not serially', async () => {
    // Hold each reviewer's runReview() until the test releases it. If the
    // runner is serial, the second reviewer's start time will be later than
    // the first's release. If parallel, both are in flight concurrently and
    // their gates can be released in arbitrary order.
    const gates: Array<() => void> = []
    runReviewImpl = (_opts) => {
      return new Promise<{ content: string }>((resolve) => {
        gates.push(() => resolve({ content: 'ok' }))
      })
    }

    const reviewers = resolveReviewerNames(['security', 'architect', 'doc-reviewer'])
    const promise = runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
    })

    // Wait a tick for each runReview() invocation to register its gate.
    await new Promise((resolve) => setImmediate(resolve))
    expect(gates).toHaveLength(3)

    // Release in reverse order — only possible if all three are concurrently
    // suspended inside runReview(). A serial implementation would have only
    // ONE gate registered at this point.
    gates[2]()
    gates[1]()
    gates[0]()

    const results = await promise
    expect(results.map((r) => r.reviewer.name)).toEqual([
      'security',
      'architect',
      'doc-reviewer',
    ])
    for (const r of results) expect(r.ok).toBe(true)
  })

  it('captures per-reviewer failure without affecting other reviewers', async () => {
    runReviewImpl = async (opts) => {
      if (/application security engineer/i.test(String(opts.systemPrompt))) {
        throw new Error('upstream model exploded')
      }
      return { content: 'ok' }
    }
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
    })
    expect(results).toHaveLength(2)
    const sec = results.find((r) => r.reviewer.name === 'security')!
    const arch = results.find((r) => r.reviewer.name === 'architect')!
    expect(sec.ok).toBe(false)
    expect(sec.error).toContain('upstream model exploded')
    expect(arch.ok).toBe(true)
    expect(arch.content).toBe('ok')
  })

  it('threads usage from runReview onto each ReviewerRunResult', async () => {
    runReviewImpl = async (opts) => {
      const isSec = /application security engineer/i.test(String(opts.systemPrompt))
      return {
        content: 'ok',
        usage: {
          input: isSec ? 100 : 200,
          output: isSec ? 50 : 75,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: isSec ? 150 : 275,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: isSec ? 0.001 : 0.002 },
          assistantMessages: 1,
        },
      }
    }
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
    })
    const sec = results.find((r) => r.reviewer.name === 'security')!
    const arch = results.find((r) => r.reviewer.name === 'architect')!
    // Assert across both top-level and nested fields to confirm the runner
    // forwards the whole object rather than partially reconstructing it.
    expect(sec.usage?.input).toBe(100)
    expect(sec.usage?.output).toBe(50)
    expect(sec.usage?.totalTokens).toBe(150)
    expect(sec.usage?.cost.total).toBe(0.001)
    expect(arch.usage?.input).toBe(200)
    expect(arch.usage?.output).toBe(75)
    expect(arch.usage?.totalTokens).toBe(275)
    expect(arch.usage?.cost.total).toBe(0.002)
  })

  it('omits usage on failed reviewers', async () => {
    runReviewImpl = async () => {
      throw new Error('model error')
    }
    const reviewers = resolveReviewerNames(['security'])
    const results = await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].usage).toBeUndefined()
  })

  it('captures a failure to load the template without throwing', async () => {
    writeFileSync(join(tmp, 'broken.md'), '   \n')
    const reviewers = resolveReviewerNames(['broken'])
    const results = await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
    })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toMatch(/empty/i)
    // And — critically — we must NOT have invoked the engine when the
    // template failed to load.
    expect(captured).toHaveLength(0)
  })

  it('fires onReviewerComplete for each reviewer with the correct result', async () => {
    const seen: Array<{ name: string; ok: boolean }> = []
    const reviewers = resolveReviewerNames(['security', 'architect'])
    await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
      onReviewerComplete: (r) => seen.push({ name: r.reviewer.name, ok: r.ok }),
    })
    expect(seen.map((s) => s.name).sort()).toEqual(['architect', 'security'])
    for (const s of seen) expect(s.ok).toBe(true)
  })

  it('threads model and timeoutMs through to the engine', async () => {
    const reviewers = resolveReviewerNames(['security'])
    await runReviewers({
      reviewers,
      data: { context: 'c', diffContent: 'd' },
      model: 'anthropic/claude-sonnet-4-6',
      timeoutMs: 90_000,
    })
    expect(captured[0].model).toBe('anthropic/claude-sonnet-4-6')
    expect(captured[0].timeoutMs).toBe(90_000)
  })
})

describe('runAgenticReviewers — parallel agentic orchestration', () => {
  // The agentic base shape supplies every AgenticReviewOptions field the
  // engine needs except systemPrompt + userPromptOverride, which the runner
  // adds per reviewer. Kept minimal — agentic-specific fields like
  // indexerUrl/maxIterations aren't required for the tests below.
  const baseAgentic = {
    diffContent: 'fake-diff',
    context: 'ctx',
    repoRoot: '/tmp/repo',
    repoUrl: 'https://example.com/repo',
    branch: 'main',
  } as unknown as Parameters<typeof runAgenticReviewers>[0]['agenticBase']

  beforeEach(() => {
    clearReviewerPromptCacheForTests()
    capturedAgentic.length = 0
    runAgenticImpl = async (opts) => {
      capturedAgentic.push({
        systemPrompt: opts.systemPrompt,
        userPromptOverride: opts.userPromptOverride,
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        releasedAt: Date.now(),
      })
      return {
        content: `AGENTIC from system: ${String(opts.systemPrompt).slice(0, 40)}`,
        toolCallCount: 0,
        truncated: false,
      }
    }
  })

  afterEach(() => {
    clearReviewerPromptCacheForTests()
  })

  it('sends each reviewer its own system prompt through the agentic engine', async () => {
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })

    expect(results).toHaveLength(2)
    for (const r of results) expect(r.ok).toBe(true)

    // Each reviewer must get its OWN system prompt — that's the whole
    // point of the persona dispatch.
    const systemPrompts = new Set(capturedAgentic.map((r) => r.systemPrompt))
    expect(systemPrompts.size).toBe(2)
    // The system prompts are the actual built-in templates.
    expect(
      capturedAgentic.find((r) =>
        /senior application security engineer/i.test(String(r.systemPrompt)),
      ),
    ).toBeDefined()
    expect(
      capturedAgentic.find((r) =>
        /staff-level software architect/i.test(String(r.systemPrompt)),
      ),
    ).toBeDefined()
  })

  it('appends the shared untrusted-content boundary to agentic reviewer system prompts', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kode-review-runner-agentic-'))
    const originalEnv = process.env.KODE_REVIEW_REVIEWERS_DIR
    process.env.KODE_REVIEW_REVIEWERS_DIR = tmp
    clearReviewerPromptCacheForTests()
    try {
      writeFileSync(join(tmp, 'performance.md'), 'PERFORMANCE REVIEWER TEMPLATE')
      const reviewers = resolveReviewerNames(['security', 'performance'])
      const results = await runAgenticReviewers({
        reviewers,
        agenticBase: baseAgentic,
      })

      expect(results).toHaveLength(2)
      for (const r of results) expect(r.ok).toBe(true)
      expect(capturedAgentic).toHaveLength(2)
      const securityPrompt = capturedAgentic.find((r) =>
        String(r.systemPrompt).includes('senior application security engineer'),
      )?.systemPrompt
      const customPrompt = capturedAgentic.find((r) =>
        String(r.systemPrompt).includes('PERFORMANCE REVIEWER TEMPLATE'),
      )?.systemPrompt
      expect(securityPrompt).toContain(UNTRUSTED_CONTENT_BOUNDARY)
      expect(customPrompt).toContain(UNTRUSTED_CONTENT_BOUNDARY)
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KODE_REVIEW_REVIEWERS_DIR
      } else {
        process.env.KODE_REVIEW_REVIEWERS_DIR = originalEnv
      }
      rmSync(tmp, { recursive: true, force: true })
      clearReviewerPromptCacheForTests()
    }
  })

  it('requires kode-findings in agentic reviewer system prompts', async () => {
    const reviewers = resolveReviewerNames(['security', 'architect'])
    await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })

    expect(capturedAgentic).toHaveLength(2)
    for (const run of capturedAgentic) {
      expect(run.systemPrompt).toContain(FINDINGS_BLOCK_INSTRUCTIONS)
      expect(run.systemPrompt).toMatch(/REQUIRED.*kode-findings/i)
    }
  })

  it('runs agentic reviewers in parallel, not serially', async () => {
    const gates: Array<() => void> = []
    runAgenticImpl = () =>
      new Promise((resolve) => {
        gates.push(() =>
          resolve({ content: 'ok', toolCallCount: 0, truncated: false }),
        )
      })

    const reviewers = resolveReviewerNames(['security', 'architect', 'doc-reviewer'])
    const promise = runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(gates).toHaveLength(3)

    // Release in reverse order — only possible if all three are concurrently
    // suspended inside runAgenticReview(). A serial implementation would
    // have only ONE gate registered at this point.
    gates[2]()
    gates[1]()
    gates[0]()

    const results = await promise
    expect(results.map((r) => r.reviewer.name)).toEqual([
      'security',
      'architect',
      'doc-reviewer',
    ])
    for (const r of results) expect(r.ok).toBe(true)
  })

  it('captures per-reviewer agentic failures without throwing', async () => {
    runAgenticImpl = async (opts) => {
      if (/application security engineer/i.test(String(opts.systemPrompt))) {
        throw new Error('engine boom')
      }
      return { content: 'ok', toolCallCount: 0, truncated: false }
    }
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })
    expect(results).toHaveLength(2)
    const sec = results.find((r) => r.reviewer.name === 'security')!
    const arch = results.find((r) => r.reviewer.name === 'architect')!
    expect(sec.ok).toBe(false)
    expect(sec.error).toMatch(/engine boom/)
    expect(arch.ok).toBe(true)
    expect(arch.content).toBe('ok')
  })

  it('threads usage from runAgenticReview onto each ReviewerRunResult', async () => {
    runAgenticImpl = async (opts) => {
      const isSec = /application security engineer/i.test(String(opts.systemPrompt))
      return {
        content: 'ok',
        toolCallCount: 3,
        truncated: false,
        usage: {
          input: isSec ? 100 : 200,
          output: isSec ? 50 : 75,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: isSec ? 150 : 275,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: isSec ? 0.001 : 0.002 },
          assistantMessages: 1,
        },
      }
    }
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })
    const sec = results.find((r) => r.reviewer.name === 'security')!
    const arch = results.find((r) => r.reviewer.name === 'architect')!
    expect(sec.usage?.input).toBe(100)
    expect(sec.usage?.output).toBe(50)
    expect(sec.usage?.totalTokens).toBe(150)
    expect(sec.usage?.cost.total).toBe(0.001)
    expect(arch.usage?.input).toBe(200)
    expect(arch.usage?.output).toBe(75)
    expect(arch.usage?.totalTokens).toBe(275)
    expect(arch.usage?.cost.total).toBe(0.002)
  })

  it('captures a failure to load the agentic template without invoking the engine', async () => {
    // Use the user-reviewers tmpdir route to register a deliberately broken
    // template that loadReviewerSystemPrompt will reject.
    const tmp = mkdtempSync(join(tmpdir(), 'kode-review-runner-agentic-'))
    const originalEnv = process.env.KODE_REVIEW_REVIEWERS_DIR
    process.env.KODE_REVIEW_REVIEWERS_DIR = tmp
    clearReviewerPromptCacheForTests()
    try {
      writeFileSync(join(tmp, 'broken.md'), '   \n')
      const reviewers = resolveReviewerNames(['broken'])
      const results = await runAgenticReviewers({
        reviewers,
        agenticBase: baseAgentic,
      })
      expect(results).toHaveLength(1)
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toMatch(/empty/i)
      // The engine must NOT have been invoked when the template failed.
      expect(capturedAgentic).toHaveLength(0)
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KODE_REVIEW_REVIEWERS_DIR
      } else {
        process.env.KODE_REVIEW_REVIEWERS_DIR = originalEnv
      }
      rmSync(tmp, { recursive: true, force: true })
      clearReviewerPromptCacheForTests()
    }
  })

  it('fires onReviewerComplete for each agentic reviewer', async () => {
    const seen: Array<{ name: string; ok: boolean }> = []
    const reviewers = resolveReviewerNames(['security', 'architect'])
    await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
      onReviewerComplete: (r) => seen.push({ name: r.reviewer.name, ok: r.ok }),
    })
    expect(seen.map((s) => s.name).sort()).toEqual(['architect', 'security'])
    for (const s of seen) expect(s.ok).toBe(true)
  })

  it('threads toolCallCount / truncated / truncationReason onto each ReviewerRunResult', async () => {
    runAgenticImpl = async (opts) => {
      const isSec = /application security engineer/i.test(String(opts.systemPrompt))
      return {
        content: 'ok',
        toolCallCount: isSec ? 7 : 2,
        truncated: isSec,
        truncationReason: isSec ? 'iteration limit reached' : undefined,
      }
    }
    const reviewers = resolveReviewerNames(['security', 'architect'])
    const results = await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
    })
    const sec = results.find((r) => r.reviewer.name === 'security')!
    const arch = results.find((r) => r.reviewer.name === 'architect')!
    expect(sec.toolCallCount).toBe(7)
    expect(sec.truncated).toBe(true)
    expect(sec.truncationReason).toBe('iteration limit reached')
    expect(arch.toolCallCount).toBe(2)
    expect(arch.truncated).toBe(false)
    expect(arch.truncationReason).toBeUndefined()
  })

  it('forwards an explicit userPromptOverride to every reviewer', async () => {
    const reviewers = resolveReviewerNames(['security', 'architect'])
    await runAgenticReviewers({
      reviewers,
      agenticBase: baseAgentic,
      userPromptOverride: 'CUSTOM-AGENTIC-USER-PROMPT',
    })
    expect(capturedAgentic).toHaveLength(2)
    for (const r of capturedAgentic) {
      expect(r.userPromptOverride).toBe('CUSTOM-AGENTIC-USER-PROMPT')
    }
  })
})
