import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock session-events module
vi.mock('../session-events.js', () => ({
  promptAndWaitForResponse: vi.fn(),
  countToolCalls: vi.fn(),
}))

// Mock the @opencode-ai/sdk module
vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn().mockResolvedValue({
    client: {
      session: {
        create: vi.fn(),
        messages: vi.fn(),
      },
      mcp: {
        add: vi.fn().mockResolvedValue({}),
      },
    },
    server: { close: vi.fn() },
  }),
  createOpencodeClient: vi.fn().mockReturnValue({
    session: {
      create: vi.fn(),
      messages: vi.fn(),
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

import { runAgenticReview, runAgenticReviewWithServer } from '../agentic-engine.js'
import { promptAndWaitForResponse, countToolCalls } from '../session-events.js'
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk'

// Get mock references
const mockPromptAndWait = promptAndWaitForResponse as unknown as ReturnType<typeof vi.fn>
const mockCountToolCalls = countToolCalls as unknown as ReturnType<typeof vi.fn>

const baseOptions = {
  diffContent: 'diff --git a/file.ts',
  context: 'local changes',
  repoRoot: '/tmp/repo',
  repoUrl: 'https://github.com/test/repo',
}

describe('runAgenticReview', () => {
  let mockSessionCreate: ReturnType<typeof vi.fn>
  let mockSessionMessages: ReturnType<typeof vi.fn>
  let mockServerClose: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const opencodeResult = await (createOpencode as unknown as ReturnType<typeof vi.fn>)()
    mockSessionCreate = opencodeResult.client.session.create as ReturnType<typeof vi.fn>
    mockSessionMessages = opencodeResult.client.session.messages as ReturnType<typeof vi.fn>
    mockServerClose = opencodeResult.server.close as ReturnType<typeof vi.fn>
    // Re-setup mcp.add mock after clearAllMocks
    const mockMcpAdd = opencodeResult.client.mcp.add as ReturnType<typeof vi.fn>
    mockMcpAdd.mockResolvedValue({})

    mockSessionCreate.mockResolvedValue({
      data: { id: 'session-123' },
    })
    mockSessionMessages.mockResolvedValue({
      data: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Review output' }] },
      ],
    })
  })

  it('extracts text content and counts tool calls', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [
        { type: 'tool', name: 'read_file' },
        { type: 'text', text: 'Review output' },
      ],
    })
    mockCountToolCalls.mockReturnValue(1)

    const result = await runAgenticReview(baseOptions)

    expect(result.content).toBe('Review output')
    expect(result.toolCallCount).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('surfaces model error when info.error is present', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: {
        role: 'assistant',
        error: {
          name: 'APIError',
          data: { message: 'Model not found', statusCode: 404, isRetryable: false },
        },
      },
      parts: [],
    })

    await expect(runAgenticReview(baseOptions)).rejects.toThrow(
      'Model returned an error: Model not found'
    )
  })

  it('throws when response parts are undefined with no model error', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
    })

    await expect(runAgenticReview(baseOptions)).rejects.toThrow(
      'Review response contained no content'
    )
  })

  it('detects truncation when tool calls reach maxIterations', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Final response' }],
    })
    mockCountToolCalls.mockReturnValue(10)

    const result = await runAgenticReview({
      ...baseOptions,
      maxIterations: 10,
    })

    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toContain('10')
  })

  it('throws when MCP registration fails', async () => {
    const opencodeResult = await (createOpencode as unknown as ReturnType<typeof vi.fn>)()
    const mockMcpAdd = opencodeResult.client.mcp.add as ReturnType<typeof vi.fn>
    mockMcpAdd.mockRejectedValue(new Error('spawn error'))

    await expect(runAgenticReview(baseOptions)).rejects.toThrow(
      /Failed to register MCP tools/
    )
  })

  it('closes server even when review fails', async () => {
    mockPromptAndWait.mockRejectedValue(new Error('API failure'))

    await expect(runAgenticReview(baseOptions)).rejects.toThrow('API failure')
    expect(mockServerClose).toHaveBeenCalled()
  })

  it('passes system prompt and timeout to promptAndWaitForResponse', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'OK' }],
    })
    mockCountToolCalls.mockReturnValue(0)

    await runAgenticReview({ ...baseOptions, timeout: 60 })

    expect(mockPromptAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-123',
        timeoutMs: 60_000,
        body: expect.objectContaining({
          system: expect.any(String),
        }),
      })
    )
  })
})

describe('runAgenticReviewWithServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const clientMock = (createOpencodeClient as unknown as ReturnType<typeof vi.fn>)()
    const mockCreate = clientMock.session.create as ReturnType<typeof vi.fn>
    const mockMessages = clientMock.session.messages as ReturnType<typeof vi.fn>
    mockCreate.mockResolvedValue({
      data: { id: 'session-456' },
    })
    mockMessages.mockResolvedValue({
      data: [
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }] },
      ],
    })
  })

  it('surfaces model error when info.error is present', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: {
        role: 'assistant',
        error: {
          name: 'ProviderAuthError',
          data: { message: 'Authentication failed' },
        },
      },
      parts: [],
    })

    await expect(
      runAgenticReviewWithServer('http://localhost:3000', baseOptions)
    ).rejects.toThrow('Model returned an error: Authentication failed')
  })

  it('returns content from valid response', async () => {
    mockPromptAndWait.mockResolvedValue({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: 'Agentic review complete' }],
    })
    mockCountToolCalls.mockReturnValue(0)

    const result = await runAgenticReviewWithServer(
      'http://localhost:3000',
      baseOptions
    )

    expect(result.content).toBe('Agentic review complete')
    expect(result.toolCallCount).toBe(0)
    expect(result.truncated).toBe(false)
  })
})
