import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pi SDK stub. We capture the options createAgentSession was called with,
// the live session reference (so tests can inspect abort/dispose), and let
// each test drive the simulated session lifecycle by hand.
interface CapturedSession {
  state: { messages: unknown[] }
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const captured: {
  options: any | null
  subscriber: ((event: any) => void) | null
  resolvePrompt: () => void
  rejectPrompt: (err: unknown) => void
  session: CapturedSession | null
  modelsOverride: any[] | null
  piGlobalSettings: Record<string, unknown> | null
  piProjectSettings: Record<string, unknown> | null
} = {
  options: null,
  subscriber: null,
  resolvePrompt: () => {},
  rejectPrompt: () => {},
  session: null,
  modelsOverride: null,
  piGlobalSettings: null,
  piProjectSettings: null,
}

const sessionState = { messages: [] as any[] }

vi.mock('@mariozechner/pi-coding-agent', () => {
  class FakeDefaultResourceLoader {
    options: unknown
    constructor(opts: unknown) { this.options = opts }
    async reload() {}
  }
  return {
    AuthStorage: { create: vi.fn(() => ({})) },
    ModelRegistry: {
      create: vi.fn(() => ({
        getAvailable: vi.fn(async () => captured.modelsOverride ?? [
          { provider: 'anthropic', id: 'claude-sonnet-4-6', api: 'anthropic-messages' },
          { provider: 'google', id: 'gemini-3-pro', api: 'google-gen-ai' },
        ]),
      })),
    },
    SettingsManager: {
      create: vi.fn(() => ({
        getGlobalSettings: vi.fn(() => captured.piGlobalSettings ?? {}),
        getProjectSettings: vi.fn(() => captured.piProjectSettings ?? {}),
      })),
    },
    DefaultResourceLoader: FakeDefaultResourceLoader,
    SessionManager: { inMemory: vi.fn(() => ({})) },
    getAgentDir: vi.fn(() => '/tmp/agent'),
    createAgentSession: vi.fn(async (opts: any) => {
      captured.options = opts
      const session: CapturedSession & {
        subscribe: (listener: (event: any) => void) => () => void
        prompt: ReturnType<typeof vi.fn>
      } = {
        state: sessionState,
        subscribe(listener: (event: any) => void) {
          captured.subscriber = listener
          return () => { captured.subscriber = null }
        },
        prompt: vi.fn(async () => {
          await new Promise<void>((resolve, reject) => {
            captured.resolvePrompt = () => {
              if (captured.subscriber) captured.subscriber({ type: 'agent_end', messages: sessionState.messages })
              resolve()
            }
            captured.rejectPrompt = reject
          })
        }),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      }
      captured.session = session
      return { session }
    }),
  }
})

import { runReview, runAgenticReview } from '../engine.js'
import { FINDINGS_FENCE_TAG } from '../finding-parser.js'

beforeEach(() => {
  captured.options = null
  captured.subscriber = null
  captured.session = null
  captured.modelsOverride = null
  captured.piGlobalSettings = null
  captured.piProjectSettings = null
  sessionState.messages = []
  delete process.env.KODE_REVIEW_MODEL
})

function pushAssistantText(text: string) {
  sessionState.messages.push({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
  })
}

function pushTool() {
  if (captured.subscriber) {
    captured.subscriber({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read_file', args: { path: 'a.ts' } })
    captured.subscriber({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read_file', result: 'ok', isError: false })
  }
}

describe('runReview', () => {
  it('returns the assistant text after a basic review completes', async () => {
    const promise = runReview({
      diffContent: 'diff',
      context: 'review',
    })

    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('Looks good, no critical issues.')
    captured.resolvePrompt()

    const result = await promise
    expect(result.content).toBe('Looks good, no critical issues.')
  })

  it('disables built-in pi tools entirely for basic review (noTools = "all")', async () => {
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.noTools).toBe('all')
  })

  it('passes the provided model pattern when it matches an available model', async () => {
    const promise = runReview({ diffContent: 'd', context: 'c', model: 'google/gemini-3-pro' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('google')
    expect(captured.options.model.id).toBe('gemini-3-pro')
  })

  it('falls back to the first available model when no --model is set', async () => {
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('anthropic')
  })

  it('throws a clear error when --model does not match any available model', async () => {
    await expect(runReview({ diffContent: 'd', context: 'c', model: 'foo/nope' })).rejects.toThrow(/not available in pi/)
  })

  it('honors pi defaultProvider/defaultModel when no --model is set', async () => {
    captured.piGlobalSettings = { defaultProvider: 'google', defaultModel: 'gemini-3-pro' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('google')
    expect(captured.options.model.id).toBe('gemini-3-pro')
  })

  it('lets project-scoped pi settings override global pi settings', async () => {
    captured.piGlobalSettings = { defaultProvider: 'google', defaultModel: 'gemini-3-pro' }
    captured.piProjectSettings = { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('anthropic')
    expect(captured.options.model.id).toBe('claude-sonnet-4-6')
  })

  it('honors KODE_REVIEW_MODEL above pi defaults', async () => {
    process.env.KODE_REVIEW_MODEL = 'google/gemini-3-pro'
    captured.piGlobalSettings = { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('google')
    expect(captured.options.model.id).toBe('gemini-3-pro')
  })

  it('--model wins over KODE_REVIEW_MODEL and pi defaults', async () => {
    process.env.KODE_REVIEW_MODEL = 'google/gemini-3-pro'
    captured.piGlobalSettings = { defaultProvider: 'google', defaultModel: 'gemini-3-pro' }
    const promise = runReview({ diffContent: 'd', context: 'c', model: 'anthropic/claude-sonnet-4-6' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('anthropic')
    expect(captured.options.model.id).toBe('claude-sonnet-4-6')
  })

  it('warns and falls back when KODE_REVIEW_MODEL points at an unavailable model', async () => {
    process.env.KODE_REVIEW_MODEL = 'foo/bar'
    captured.piGlobalSettings = { defaultProvider: 'google', defaultModel: 'gemini-3-pro' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    // KODE_REVIEW_MODEL miss → falls through to pi default, which is available.
    expect(captured.options.model.provider).toBe('google')
    expect(captured.options.model.id).toBe('gemini-3-pro')
  })

  it('does not cross-pair global defaultProvider with project defaultModel', async () => {
    // Global says anthropic; project only overrides the model id. We must
    // NOT synthesize "anthropic/gemini-3-pro" — instead, project sets only
    // the bare id, so we look that up by id (which matches gemini-3-pro).
    captured.piGlobalSettings = { defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' }
    captured.piProjectSettings = { defaultModel: 'gemini-3-pro' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.model.provider).toBe('google')
    expect(captured.options.model.id).toBe('gemini-3-pro')
  })

  it('warns and falls back when pi defaultModel points at an unavailable model', async () => {
    captured.piGlobalSettings = { defaultProvider: 'minimax', defaultModel: 'MiniMax-M2.7' }
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    // pi default miss → first-available wins.
    expect(captured.options.model.provider).toBe('anthropic')
  })

  it('forwards onProgress through runWithPi even in basic (no-tools) mode', async () => {
    const seen: Array<{ toolCallCount: number; lastToolName?: string }> = []
    const promise = runReview({
      diffContent: 'd',
      context: 'c',
      onProgress: (p) => seen.push({ ...p }),
    })

    await new Promise((resolve) => setImmediate(resolve))
    // Pi normally would not emit tool events with noTools='all', but we
    // simulate one to prove the wiring forwards events all the way through —
    // a future refactor that drops `onProgress` from `runWithPi`'s `runReview`
    // call site would make this test fail.
    pushTool()
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(seen).toEqual([
      { toolCallCount: 0, lastToolName: 'read_file' },
      { toolCallCount: 1, lastToolName: 'read_file' },
    ])
  })

  it('returns parsed findings when output contains a kode-findings block', async () => {
    const fenced = [
      '### Summary',
      'sum',
      '',
      '```' + FINDINGS_FENCE_TAG,
      JSON.stringify({
        findings: [{
          severity: 'HIGH',
          category: 'security',
          confidence: 'HIGH',
          title: 't',
          file: 'a.ts',
          lineStart: 1,
          lineEnd: 2,
          evidence: 'e',
          problem: 'p',
          recommendation: 'r',
        }],
      }),
      '```',
    ].join('\n')

    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText(fenced)
    captured.resolvePrompt()

    const result = await promise
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].category).toBe('security')
    expect(result.findings[0].severity).toBe('HIGH')
  })

  it('returns empty findings when no kode-findings block is present', async () => {
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('### Summary\nno block')
    captured.resolvePrompt()

    const result = await promise
    expect(result.findings).toEqual([])
  })
})

describe('runAgenticReview', () => {
  it('counts tool executions across the session and surfaces the final text', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
      maxIterations: 5,
    })

    // Wait a tick for createAgentSession to be invoked and listener attached.
    await new Promise((resolve) => setImmediate(resolve))
    pushTool()
    pushTool()
    pushAssistantText('Final review.')
    captured.resolvePrompt()

    const result = await promise
    expect(result.content).toBe('Final review.')
    expect(result.toolCallCount).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('marks truncated=true when tool calls hit maxIterations', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
      maxIterations: 2,
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushTool()
    pushTool()
    pushAssistantText('Truncated final.')
    captured.resolvePrompt()

    const result = await promise
    expect(result.toolCallCount).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toContain('Maximum iteration limit')
  })

  it('threads onProgress through to the listener — observer sees a snapshot per tool start and per tool end', async () => {
    const seen: Array<{ toolCallCount: number; lastToolName?: string }> = []
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
      onProgress: (p) => seen.push({ ...p }),
    })

    await new Promise((resolve) => setImmediate(resolve))
    pushTool()
    pushAssistantText('Final.')
    captured.resolvePrompt()
    await promise

    // Two emissions for the single tool: start + end.
    expect(seen).toEqual([
      { toolCallCount: 0, lastToolName: 'read_file' },
      { toolCallCount: 1, lastToolName: 'read_file' },
    ])
  })

  it('keeps built-in tools off but enables custom (extension) tools (noTools = "builtin")', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captured.options.noTools).toBe('builtin')
    // Defensive: explicitly assert it is NOT 'all' — the security distinction
    // matters (extension tools must remain enabled in agentic mode).
    expect(captured.options.noTools).not.toBe('all')
  })
})

describe('runWithPi failure paths', () => {
  it('rejects with NO_PI_AUTH-style error when ModelRegistry has no usable models', async () => {
    captured.modelsOverride = []
    await expect(runReview({ diffContent: 'd', context: 'c' })).rejects.toThrow(/No pi provider has usable credentials/)
  })

  it('honors the timeout, calls session.abort(), and disposes the session', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
      timeout: 0.05, // 50ms — short enough to fire reliably in a unit test
    })

    await new Promise((resolve) => setImmediate(resolve))
    // Deliberately do NOT call resolvePrompt — let the timeout win the race.

    await expect(promise).rejects.toThrow(/did not complete within/)
    expect(captured.session).not.toBeNull()
    expect(captured.session!.abort).toHaveBeenCalledTimes(1)
    expect(captured.session!.dispose).toHaveBeenCalledTimes(1)
  })

  it('still propagates the timeout error and disposes the session even when abort() rejects', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/repo',
      repoUrl: 'https://github.com/x/y',
      timeout: 0.05,
    })

    await new Promise((resolve) => setImmediate(resolve))
    captured.session!.abort.mockRejectedValueOnce(new Error('abort failed'))

    await expect(promise).rejects.toThrow(/did not complete within/)
    expect(captured.session!.dispose).toHaveBeenCalledTimes(1)
  })

  it('surfaces session.prompt() errors and still disposes the session', async () => {
    const promise = runReview({ diffContent: 'd', context: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    captured.rejectPrompt(new Error('upstream provider exploded'))

    await expect(promise).rejects.toThrow(/upstream provider exploded/)
    expect(captured.session!.dispose).toHaveBeenCalledTimes(1)
  })
})

// -----------------------------------------------------------------------------
// Engine override contracts (Task 3, addresses HIGH test-auditor finding
// 7c8d17fa…). Persona dispatch and repo-scope feature review pass
// `systemPrompt` and `userPromptOverride` into runReview / runAgenticReview;
// if either contract regresses we'd silently fall back to the default
// reviewer prompts. These tests pin the contract down.
// -----------------------------------------------------------------------------

/**
 * Install a one-shot createAgentSession implementation that captures every
 * argument passed to `session.prompt(...)` into the supplied `captures` array.
 *
 * We use mockImplementationOnce so each test installs its own capturing
 * session without disturbing the shared module-level mock used by the other
 * tests in this file. The signature mirrors the default mock so that the
 * resolvePrompt / subscriber wiring continues to work.
 */
async function installPromptCapturingSession(captures: unknown[]): Promise<void> {
  const { createAgentSession } = await import('@mariozechner/pi-coding-agent')
  const cas = createAgentSession as unknown as ReturnType<typeof vi.fn>
  cas.mockImplementationOnce(async (opts: any) => {
    captured.options = opts
    const session: CapturedSession & {
      subscribe: (listener: (event: any) => void) => () => void
      prompt: ReturnType<typeof vi.fn>
    } = {
      state: sessionState,
      subscribe(listener: (event: any) => void) {
        captured.subscriber = listener
        return () => { captured.subscriber = null }
      },
      prompt: vi.fn(async (input: unknown) => {
        captures.push(input)
        await new Promise<void>((resolve, reject) => {
          captured.resolvePrompt = () => {
            if (captured.subscriber) captured.subscriber({ type: 'agent_end', messages: sessionState.messages })
            resolve()
          }
          captured.rejectPrompt = reject
        })
      }),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    }
    captured.session = session
    return { session }
  })
}

/**
 * The real pi session.prompt is called with either a string or a structured
 * UserMessage-like object. Both forms must surface the override verbatim;
 * this helper hides the shape so the test asserts the contract not the wire.
 */
function captureContains(captures: unknown[], needle: string): boolean {
  return captures.some((c) => {
    if (typeof c === 'string') return c === needle
    if (c && typeof c === 'object' && 'content' in c) {
      const content = (c as { content: unknown }).content
      return typeof content === 'string' && content === needle
    }
    return false
  })
}

function captureJoined(captures: unknown[]): string {
  return captures.map((c) => typeof c === 'string' ? c : JSON.stringify(c)).join('\n')
}

describe('engine option overrides', () => {
  const SYSTEM_OVERRIDE_BASIC = 'CUSTOM_SYSTEM_PROMPT_FOR_PERSONA_BASIC'
  const SYSTEM_OVERRIDE_AGENTIC = 'AGENTIC_OVERRIDE_FOR_FEATURE_REVIEW'
  const USER_OVERRIDE_BASIC = 'EXPLICIT_USER_PROMPT_OVERRIDE_FOR_TASK_3'
  const USER_OVERRIDE_AGENTIC = 'AGENTIC_USER_OVERRIDE_PAYLOAD'

  it('runReview: userPromptOverride is forwarded to session.prompt verbatim, bypassing buildReviewPrompt', async () => {
    const captures: unknown[] = []
    await installPromptCapturingSession(captures)

    const promise = runReview({
      diffContent: 'diff --git a/x b/x\n+y',
      context: 'c',
      userPromptOverride: USER_OVERRIDE_BASIC,
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captureContains(captures, USER_OVERRIDE_BASIC)).toBe(true)

    // The default builder's distinctive opening must NOT appear — proves
    // buildReviewPrompt was truly bypassed.
    const joined = captureJoined(captures)
    expect(joined).not.toContain('You are an expert code reviewer')
  })

  it('runReview: systemPrompt override is forwarded as systemPromptOverride to createAgentSession', async () => {
    const promise = runReview({
      diffContent: 'd',
      context: 'c',
      systemPrompt: SYSTEM_OVERRIDE_BASIC,
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    // The engine threads systemPromptOverride through DefaultResourceLoader.
    // Our FakeDefaultResourceLoader captures its constructor opts, exposed
    // indirectly via captured.options.resourceLoader.
    const loader = captured.options.resourceLoader as {
      options: { systemPromptOverride?: () => string }
    }
    expect(loader.options.systemPromptOverride).toBeDefined()
    expect(loader.options.systemPromptOverride!()).toBe(SYSTEM_OVERRIDE_BASIC)
  })

  it('runAgenticReview: systemPrompt override REPLACES the default AGENTIC_SYSTEM_PROMPT', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/tmp/r',
      repoUrl: 'u',
      systemPrompt: SYSTEM_OVERRIDE_AGENTIC,
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    const loader = captured.options.resourceLoader as {
      options: { systemPromptOverride?: () => string }
    }
    expect(loader.options.systemPromptOverride).toBeDefined()
    expect(loader.options.systemPromptOverride!()).toBe(SYSTEM_OVERRIDE_AGENTIC)
  })

  it('runAgenticReview: when systemPrompt is undefined, the default AGENTIC_SYSTEM_PROMPT is used', async () => {
    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/tmp/r',
      repoUrl: 'u',
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    const loader = captured.options.resourceLoader as {
      options: { systemPromptOverride?: () => string }
    }
    expect(loader.options.systemPromptOverride).toBeDefined()
    const defaultPrompt = loader.options.systemPromptOverride!()
    expect(typeof defaultPrompt).toBe('string')
    expect(defaultPrompt.length).toBeGreaterThan(0)
    // Must NOT be the persona override sentinel from the previous test —
    // proves a different (default) value flows through when override is absent.
    expect(defaultPrompt).not.toBe(SYSTEM_OVERRIDE_AGENTIC)
  })

  it('runAgenticReview: userPromptOverride is forwarded to session.prompt verbatim, bypassing buildAgenticPrompt', async () => {
    const captures: unknown[] = []
    await installPromptCapturingSession(captures)

    const promise = runAgenticReview({
      diffContent: 'd',
      context: 'c',
      repoRoot: '/tmp/r',
      repoUrl: 'u',
      userPromptOverride: USER_OVERRIDE_AGENTIC,
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    expect(captureContains(captures, USER_OVERRIDE_AGENTIC)).toBe(true)

    // buildAgenticPrompt's distinctive section header must NOT appear.
    const joined = captureJoined(captures)
    expect(joined).not.toContain('## Review Criteria')
  })

  it('runReview (counter-test): without userPromptOverride, the default buildReviewPrompt output is sent', async () => {
    // Sanity check so the bypass assertion above cannot pass vacuously:
    // when no override is supplied, the default builder's distinctive
    // opening MUST appear on the wire.
    const captures: unknown[] = []
    await installPromptCapturingSession(captures)

    const promise = runReview({
      diffContent: 'diff --git a/x b/x\n+y',
      context: 'c',
    })
    await new Promise((resolve) => setImmediate(resolve))
    pushAssistantText('OK')
    captured.resolvePrompt()
    await promise

    const joined = captureJoined(captures)
    expect(joined.length).toBeGreaterThan(0)
    // Stable marker from REVIEW_PROMPT_BASE in src/review/prompt.ts.
    expect(joined).toContain('You are an expert code reviewer')
  })
})
