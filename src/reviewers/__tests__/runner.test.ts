import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const captured: CapturedRun[] = []
let runReviewImpl: (opts: CapturedOptions) => Promise<{ content: string }> = async () => ({
  content: 'default',
})

vi.mock('../../review/engine.js', () => ({
  runReview: vi.fn(async (opts: CapturedOptions) => runReviewImpl(opts)),
}))

import {
  BUILTIN_REVIEWER_NAMES,
  clearReviewerPromptCacheForTests,
  resolveReviewerNames,
  runReviewers,
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
