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

import { extractResponseContent } from '../response.js'

describe('extractResponseContent', () => {
  it('extracts text from valid response parts', () => {
    const data = {
      info: {},
      parts: [
        { type: 'text', text: 'Summary of review' },
        { type: 'text', text: 'Detailed findings' },
      ],
    }

    expect(extractResponseContent(data)).toBe('Summary of review\nDetailed findings')
  })

  it('filters out non-text parts', () => {
    const data = {
      parts: [
        { type: 'text', text: 'Only this' },
        { type: 'tool', name: 'read_file' },
      ],
    }

    expect(extractResponseContent(data)).toBe('Only this')
  })

  it('throws with model error message when info.error is a provider auth error', () => {
    const data = {
      info: {
        error: {
          name: 'ProviderAuthError',
          data: {
            message: 'Invalid API key for google/antigravity-gemini-3.1-pro',
          },
        },
      },
      parts: undefined,
    }

    expect(() => extractResponseContent(data)).toThrow(
      'Model returned an error: Invalid API key for google/antigravity-gemini-3.1-pro'
    )
  })

  it('throws with model error message when info.error is an API error', () => {
    const data = {
      info: {
        error: {
          name: 'APIError',
          data: {
            message: 'Rate limit exceeded',
            statusCode: 429,
            isRetryable: true,
          },
        },
      },
      parts: [],
    }

    expect(() => extractResponseContent(data)).toThrow(
      'Model returned an error: Rate limit exceeded (retryable)'
    )
  })

  it('throws with model error message for aborted messages', () => {
    const data = {
      info: {
        error: {
          name: 'MessageAbortedError',
          data: { message: 'Message was aborted' },
        },
      },
    }

    expect(() => extractResponseContent(data)).toThrow(
      'Model returned an error: Message was aborted'
    )
  })

  it('falls back to error name when error data has no message', () => {
    const data = {
      info: {
        error: {
          name: 'MessageOutputLengthError',
          data: { someOtherField: true },
        },
      },
    }

    expect(() => extractResponseContent(data)).toThrow(
      'Model returned an error: MessageOutputLengthError'
    )
  })

  it('includes model/provider info when parts are missing with no error', () => {
    // Real SDK responses include modelID/providerID on info
    const data = {
      info: { modelID: 'gemini-pro', providerID: 'google', finish: 'stop' },
    } as Parameters<typeof extractResponseContent>[0]

    expect(() => extractResponseContent(data)).toThrow(
      /modelID=gemini-pro.*providerID=google.*finish=stop/
    )
  })

  it('shows unknown values when info fields are missing', () => {
    const data = { info: {} }

    expect(() => extractResponseContent(data)).toThrow(
      /modelID=unknown.*providerID=unknown.*finish=none/
    )
  })

  it('throws when parts is an empty array and no model error', () => {
    const data = { info: {}, parts: [] }

    expect(() => extractResponseContent(data)).toThrow(
      'Review response contained no content'
    )
  })

  it('includes DEBUG=1 hint in empty response error', () => {
    const data = { info: {} }

    expect(() => extractResponseContent(data)).toThrow('DEBUG=1')
  })

  it('prioritizes model error over missing parts', () => {
    const data = {
      info: {
        error: {
          name: 'APIError',
          data: { message: 'Service unavailable', statusCode: 503, isRetryable: true },
        },
      },
    }

    expect(() => extractResponseContent(data)).toThrow(
      'Model returned an error: Service unavailable (retryable)'
    )
  })
})
