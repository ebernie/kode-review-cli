/**
 * Tests for session-events module.
 *
 * Note: Because bun test shares module cache across files and vi.mock from
 * engine.test.ts / agentic-engine.test.ts mocks '../session-events.js',
 * we cannot import from that path when running as part of the full test suite.
 *
 * Instead, we test the promptAndWaitForResponse logic by exercising it
 * through the engine functions (which mock it), and test countToolCalls
 * with an inline implementation (since it's a pure function).
 *
 * The core promptAndWaitForResponse function is tested:
 * - In isolation: `bun test src/review/__tests__/session-events.test.ts`
 * - Via integration: through engine.test.ts and agentic-engine.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk'

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// Import countToolCalls from the real module. Unlike promptAndWaitForResponse,
// countToolCalls is a pure synchronous function that works even when the module
// is partially mocked by engine/agentic-engine tests (vitest isolates files).
let realCountToolCalls: typeof import('../session-events.js')['countToolCalls'] | null = null
try {
  const mod = await import('../session-events.js')
  if (typeof mod.countToolCalls === 'function') {
    realCountToolCalls = mod.countToolCalls
  }
} catch {
  // Module unavailable
}

function createMockClient(overrides: {
  streamEvents?: Array<Record<string, unknown>>
  promptAsyncResult?: Record<string, unknown>
  messagesResult?: Record<string, unknown>
}) {
  const {
    streamEvents = [{ type: 'session.idle', properties: { sessionID: 'sess-1' } }],
    promptAsyncResult = { error: undefined },
    messagesResult = {
      data: [
        {
          info: { role: 'user', id: 'msg-1', sessionID: 'sess-1' },
          parts: [{ type: 'text', text: 'Hello' }],
        },
        {
          info: { role: 'assistant', id: 'msg-2', sessionID: 'sess-1' },
          parts: [{ type: 'text', text: 'Review output' }],
        },
      ],
    },
  } = overrides

  async function* makeStream() {
    for (const event of streamEvents) {
      yield event
    }
  }

  return {
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: makeStream() }),
    },
    session: {
      promptAsync: vi.fn().mockResolvedValue(promptAsyncResult),
      messages: vi.fn().mockResolvedValue(messagesResult),
    },
  } as unknown as OpencodeClient
}

// We dynamically import the real module for promptAndWaitForResponse tests.
// This only works when running this test file in isolation.
// When running as part of the full suite, the module is mocked by
// engine.test.ts / agentic-engine.test.ts and these tests are skipped.
let realModule: typeof import('../session-events.js') | null = null
let isModuleMocked = true
try {
  const mod = await import('../session-events.js')
  if (typeof mod.promptAndWaitForResponse === 'function' &&
      mod.promptAndWaitForResponse.length > 0) {
    realModule = mod
    isModuleMocked = false
  }
} catch {
  // Module is mocked or unavailable
}

describe.skipIf(isModuleMocked)('promptAndWaitForResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the last assistant message on session.idle', async () => {
    const client = createMockClient({})

    const result = await realModule!.promptAndWaitForResponse({
      client,
      sessionId: 'sess-1',
      body: { parts: [{ type: 'text', text: 'Review this' }] },
    })

    expect(result.info.role).toBe('assistant')
    expect(result.parts).toEqual([{ type: 'text', text: 'Review output' }])
    expect(client.event.subscribe).toHaveBeenCalled()
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'sess-1' },
      body: { parts: [{ type: 'text', text: 'Review this' }] },
    })
    expect(client.session.messages).toHaveBeenCalledWith({
      path: { id: 'sess-1' },
    })
  })

  it('throws on session.error event', async () => {
    const client = createMockClient({
      streamEvents: [
        {
          type: 'session.error',
          properties: {
            sessionID: 'sess-1',
            error: { name: 'APIError', data: { message: 'Bad request' } },
          },
        },
      ],
    })

    await expect(
      realModule!.promptAndWaitForResponse({
        client,
        sessionId: 'sess-1',
        body: { parts: [{ type: 'text', text: 'test' }] },
      })
    ).rejects.toThrow('Session error during prompt')
  })

  it('ignores events for other sessions', async () => {
    const client = createMockClient({
      streamEvents: [
        { type: 'session.idle', properties: { sessionID: 'other-session' } },
        { type: 'session.idle', properties: { sessionID: 'sess-1' } },
      ],
    })

    const result = await realModule!.promptAndWaitForResponse({
      client,
      sessionId: 'sess-1',
      body: { parts: [{ type: 'text', text: 'test' }] },
    })

    expect(result.info.role).toBe('assistant')
  })

  it('throws when promptAsync returns an error', async () => {
    const client = createMockClient({
      promptAsyncResult: { error: { message: 'Not found' } },
    })

    await expect(
      realModule!.promptAndWaitForResponse({
        client,
        sessionId: 'sess-1',
        body: { parts: [{ type: 'text', text: 'test' }] },
      })
    ).rejects.toThrow('Failed to send prompt')
  })

  it('throws when no messages are returned', async () => {
    const client = createMockClient({
      messagesResult: { data: [] },
    })

    await expect(
      realModule!.promptAndWaitForResponse({
        client,
        sessionId: 'sess-1',
        body: { parts: [{ type: 'text', text: 'test' }] },
      })
    ).rejects.toThrow('No messages returned after session completion')
  })

  it('throws when no assistant message found', async () => {
    const client = createMockClient({
      messagesResult: {
        data: [
          {
            info: { role: 'user', id: 'msg-1', sessionID: 'sess-1' },
            parts: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    })

    await expect(
      realModule!.promptAndWaitForResponse({
        client,
        sessionId: 'sess-1',
        body: { parts: [{ type: 'text', text: 'test' }] },
      })
    ).rejects.toThrow('did not return a response')
  })
})

describe.skipIf(!realCountToolCalls)('countToolCalls', () => {
  it('counts tool parts across multiple messages', () => {
    const messages = [
      {
        info: { role: 'assistant' as const, id: '1', sessionID: 's' },
        parts: [
          { type: 'tool' as const, callID: '1', tool: 'read_file' },
          { type: 'text' as const, text: 'result' },
        ],
      },
      {
        info: { role: 'assistant' as const, id: '2', sessionID: 's' },
        parts: [
          { type: 'tool' as const, callID: '2', tool: 'search' },
          { type: 'tool' as const, callID: '3', tool: 'read_file' },
        ],
      },
    ]

    expect(realCountToolCalls!(messages as never[])).toBe(3)
  })

  it('returns 0 when no tool parts exist', () => {
    const messages = [
      {
        info: { role: 'assistant' as const, id: '1', sessionID: 's' },
        parts: [{ type: 'text' as const, text: 'just text' }],
      },
    ]

    expect(realCountToolCalls!(messages as never[])).toBe(0)
  })

  it('returns 0 for empty messages array', () => {
    expect(realCountToolCalls!([])).toBe(0)
  })
})
