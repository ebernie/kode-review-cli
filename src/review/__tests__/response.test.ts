import { describe, it, expect, vi } from 'vitest'

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { extractReviewContent } from '../response.js'
import type { AgentMessage } from '@mariozechner/pi-agent-core'

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as unknown as AgentMessage
}

function assistantMessage(parts: { type: string; text?: string; [k: string]: unknown }[], opts: {
  stopReason?: 'end_turn' | 'error' | 'aborted' | 'tool_use' | 'max_tokens'
  errorMessage?: string
} = {}): AgentMessage {
  return {
    role: 'assistant',
    content: parts,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheTotal: 0, totalInputTokens: 0 },
    stopReason: opts.stopReason ?? 'end_turn',
    errorMessage: opts.errorMessage,
    timestamp: Date.now(),
  } as unknown as AgentMessage
}

describe('extractReviewContent', () => {
  it('joins text-content parts of the last assistant message', () => {
    const messages = [
      userMessage('Review this'),
      assistantMessage([
        { type: 'text', text: 'Summary of review' },
        { type: 'text', text: 'Detailed findings' },
      ]),
    ]
    expect(extractReviewContent(messages)).toBe('Summary of review\nDetailed findings')
  })

  it('ignores non-text parts (thinking, tool calls)', () => {
    const messages = [
      assistantMessage([
        { type: 'text', text: 'Only this' },
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'toolCall', id: '1', name: 'read_file', input: {} },
      ]),
    ]
    expect(extractReviewContent(messages)).toBe('Only this')
  })

  it('walks backwards to find the most recent assistant message', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: 'first reply' }]),
      userMessage('follow-up'),
      assistantMessage([{ type: 'text', text: 'second reply' }]),
    ]
    expect(extractReviewContent(messages)).toBe('second reply')
  })

  it('throws when the last assistant message reports an error stopReason', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: 'partial' }], {
        stopReason: 'error',
        errorMessage: 'Invalid API key for anthropic',
      }),
    ]
    expect(() => extractReviewContent(messages)).toThrow('Model returned an error: Invalid API key for anthropic')
  })

  it('throws when the last assistant message was aborted', () => {
    const messages = [
      assistantMessage([], { stopReason: 'aborted' }),
    ]
    expect(() => extractReviewContent(messages)).toThrow(/Model returned an error/)
  })

  it('throws when the assistant message has no text content', () => {
    const messages = [
      assistantMessage([{ type: 'toolCall', id: '1', name: 'read_file', input: {} }]),
    ]
    expect(() => extractReviewContent(messages)).toThrow(/no text content/i)
  })

  it('throws when no assistant message exists in the conversation', () => {
    expect(() => extractReviewContent([userMessage('hello')])).toThrow(/No assistant message/)
  })
})
