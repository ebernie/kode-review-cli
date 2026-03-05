import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock session-events module
vi.mock('../session-events.js', () => ({
  promptAndWaitForResponse: vi.fn(),
}))

// Mock the @opencode-ai/sdk module
vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn().mockResolvedValue({
    client: {
      session: {
        create: vi.fn(),
      },
    },
    server: { close: vi.fn() },
  }),
  createOpencodeClient: vi.fn().mockReturnValue({
    session: {
      create: vi.fn(),
    },
  }),
}))

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    provider: 'test-provider',
    model: 'test-model',
    variant: undefined,
  }),
}))

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { runReview, runReviewWithServer } from '../engine.js'
import { promptAndWaitForResponse } from '../session-events.js'
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk'

// Get mock references
const mockPromptAndWait = promptAndWaitForResponse as unknown as ReturnType<typeof vi.fn>

describe('runReview', () => {
  let mockSessionCreate: ReturnType<typeof vi.fn>
  let mockServerClose: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-setup the createOpencode mock since clearAllMocks resets return values
    const opencodeResult = await (createOpencode as unknown as ReturnType<typeof vi.fn>)()
    mockSessionCreate = opencodeResult.client.session.create as ReturnType<typeof vi.fn>
    mockServerClose = opencodeResult.server.close as ReturnType<typeof vi.fn>
    mockSessionCreate.mockResolvedValue({
      data: { id: 'session-123' },
    })
  })

  it('extracts text content from response parts', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [
        { type: 'text', text: 'Review summary' },
        { type: 'text', text: 'Detailed feedback' },
      ],
    })

    const result = await runReview({
      diffContent: 'diff --git a/file.ts',
      context: 'local changes',
    })

    expect(result.content).toBe('Review summary\nDetailed feedback')
  })

  it('filters out non-text parts', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [
        { type: 'text', text: 'Only text' },
        { type: 'tool', name: 'some_tool' },
      ],
    })

    const result = await runReview({
      diffContent: 'diff --git a/file.ts',
      context: 'local changes',
    })

    expect(result.content).toBe('Only text')
  })

  it('surfaces model error when info.error is present', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: {
        role: 'assistant',
        error: {
          name: 'APIError',
          data: { message: 'Invalid API key', statusCode: 401, isRetryable: false },
        },
      },
      parts: [],
    })

    await expect(
      runReview({ diffContent: 'diff', context: 'test' })
    ).rejects.toThrow('Model returned an error: Invalid API key')
  })

  it('throws when response parts are undefined with no model error', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
    })

    await expect(
      runReview({ diffContent: 'diff', context: 'test' })
    ).rejects.toThrow('Review response contained no content')
  })

  it('closes server even when review fails', async () => {
    mockPromptAndWait.mockRejectedValue(new Error('API failure'))

    await expect(
      runReview({ diffContent: 'diff', context: 'test' })
    ).rejects.toThrow('API failure')

    expect(mockServerClose).toHaveBeenCalled()
  })

  it('throws when session creation returns no data', async () => {
    mockSessionCreate.mockResolvedValue({ data: null })

    await expect(
      runReview({ diffContent: 'diff', context: 'test' })
    ).rejects.toThrow('Failed to create session')
  })

  it('passes correct options to promptAndWaitForResponse', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'OK' }],
    })

    await runReview({
      diffContent: 'diff --git a/file.ts',
      context: 'local changes',
    })

    expect(mockPromptAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-123',
        timeoutMs: 180_000,
        body: expect.objectContaining({
          model: { providerID: 'test-provider', modelID: 'test-model' },
        }),
      })
    )
  })
})

describe('runReviewWithServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const clientMock = (createOpencodeClient as unknown as ReturnType<typeof vi.fn>)()
    const mockCreate = clientMock.session.create as ReturnType<typeof vi.fn>
    mockCreate.mockResolvedValue({
      data: { id: 'session-456' },
    })
  })

  it('surfaces model error when info.error is present', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: {
        role: 'assistant',
        error: {
          name: 'ProviderAuthError',
          data: { message: 'Token expired' },
        },
      },
      parts: [],
    })

    await expect(
      runReviewWithServer('http://localhost:3000', {
        diffContent: 'diff',
        context: 'test',
      })
    ).rejects.toThrow('Model returned an error: Token expired')
  })

  it('returns content from valid response', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'LGTM' }],
    })

    const result = await runReviewWithServer('http://localhost:3000', {
      diffContent: 'diff',
      context: 'test',
    })

    expect(result.content).toBe('LGTM')
  })
})
