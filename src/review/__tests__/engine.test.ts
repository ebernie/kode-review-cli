import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pi SDK stub. We capture the options createAgentSession was called with,
// and let each test drive the simulated session lifecycle.
const captured: { options: any | null; subscriber: ((event: any) => void) | null; resolvePrompt: () => void; rejectPrompt: (err: unknown) => void } = {
  options: null,
  subscriber: null,
  resolvePrompt: () => {},
  rejectPrompt: () => {},
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
        getAvailable: vi.fn(async () => [
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
      const session = {
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
      return { session }
    }),
  }
})

import { runReview, runAgenticReview } from '../engine.js'

beforeEach(() => {
  captured.options = null
  captured.subscriber = null
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
  })
})
