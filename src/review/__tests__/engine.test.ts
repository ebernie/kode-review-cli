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
} = {
  options: null,
  subscriber: null,
  resolvePrompt: () => {},
  rejectPrompt: () => {},
  session: null,
  modelsOverride: null,
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

beforeEach(() => {
  captured.options = null
  captured.subscriber = null
  captured.session = null
  captured.modelsOverride = null
  sessionState.messages = []
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
