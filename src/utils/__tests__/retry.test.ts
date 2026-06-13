import { describe, it, expect, vi, afterEach } from 'vitest'
import { withRetry, isRetryableError, createRetryWrapper } from '../retry.js'

describe('isRetryableError', () => {
  it('returns false for null', () => {
    expect(isRetryableError(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isRetryableError(undefined)).toBe(false)
  })

  it('returns true for AbortError', () => {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for TimeoutError', () => {
    const error = new Error('The operation timed out')
    error.name = 'TimeoutError'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for ECONNRESET', () => {
    const error = new Error('Connection reset') as NodeJS.ErrnoException
    error.code = 'ECONNRESET'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for ETIMEDOUT', () => {
    const error = new Error('Connection timed out') as NodeJS.ErrnoException
    error.code = 'ETIMEDOUT'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for ECONNREFUSED', () => {
    const error = new Error('Connection refused') as NodeJS.ErrnoException
    error.code = 'ECONNREFUSED'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for ENOTFOUND', () => {
    const error = new Error('DNS lookup failed') as NodeJS.ErrnoException
    error.code = 'ENOTFOUND'
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for error with retryable cause', () => {
    const cause = new Error('Connection reset') as NodeJS.ErrnoException
    cause.code = 'ECONNRESET'
    const error = new Error('Fetch failed', { cause })
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for labeled HTTP 500 in error message', () => {
    const error = new Error('Request failed with status 500')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for labeled HTTP 502 in error message', () => {
    const error = new Error('HTTP 502 Bad Gateway from server')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for status followed by a known retryable reason phrase', () => {
    const error = new Error('502 Bad Gateway from server')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for status-code 503 in error message', () => {
    const error = new Error('Service unavailable: status code 503')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for a known retryable reason phrase followed by status', () => {
    const error = new Error('Service Unavailable: 503')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for response-status 504 in error message', () => {
    const error = new Error('Gateway timeout response status 504')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for status 429 in error message', () => {
    const error = new Error('Rate limited: status 429 Too Many Requests')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns true for rate-limit status with reason phrase', () => {
    const error = new Error('429 Too Many Requests')
    expect(isRetryableError(error)).toBe(true)
  })

  it('returns false when a retry count looks like an HTTP status code', () => {
    const error = new Error('Failed after 500 attempts')
    expect(isRetryableError(error)).toBe(false)
  })

  it('returns false for HTTP 404 in error message', () => {
    const error = new Error('HTTP 404 Not Found')
    expect(isRetryableError(error)).toBe(false)
  })

  it('returns false for HTTP 401 in error message', () => {
    const error = new Error('status 401 Unauthorized')
    expect(isRetryableError(error)).toBe(false)
  })

  it('returns false for generic errors', () => {
    const error = new Error('Something went wrong')
    expect(isRetryableError(error)).toBe(false)
  })

  it('returns true for response object with status 500', () => {
    const response = { status: 500, statusText: 'Internal Server Error' }
    expect(isRetryableError(response)).toBe(true)
  })

  it('returns false for response object with status 400', () => {
    const response = { status: 400, statusText: 'Bad Request' }
    expect(isRetryableError(response)).toBe(false)
  })
})

describe('withRetry', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns result on first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success')

    const result = await withRetry(fn)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws immediately for non-retryable errors', async () => {
    const error = new Error('Not found')
    const fn = vi.fn().mockRejectedValue(error)

    await expect(withRetry(fn)).rejects.toThrow('Not found')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws when maxAttempts is less than 1', async () => {
    await expect(withRetry(() => Promise.resolve('test'), { maxAttempts: 0 }))
      .rejects.toThrow('maxAttempts must be at least 1')
  })

  it('handles non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error')

    await expect(withRetry(fn)).rejects.toThrow('string error')
  })

  it('retries on retryable errors and succeeds on second attempt', async () => {
    const retryableError = new Error('Connection reset') as NodeJS.ErrnoException
    retryableError.code = 'ECONNRESET'

    let callCount = 0
    const fn = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        throw retryableError
      }
      return 'success after retry'
    })

    // Use minimal delay so test completes quickly with real timers
    const result = await withRetry(fn, { initialDelayMs: 1, maxAttempts: 3 })

    expect(result).toBe('success after retry')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('exhausts all retries for persistent errors', async () => {
    const retryableError = new Error('Connection timeout') as NodeJS.ErrnoException
    retryableError.code = 'ETIMEDOUT'

    const fn = vi.fn().mockRejectedValue(retryableError)

    // Use minimal delay so test completes quickly with real timers
    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 })
    ).rejects.toThrow('Connection timeout')

    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('createRetryWrapper', () => {
  it('creates a wrapper that calls the function', async () => {
    const retryFn = createRetryWrapper({ maxAttempts: 2 })
    const fn = vi.fn().mockResolvedValue('result')

    const result = await retryFn(fn)

    expect(result).toBe('result')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('merges options from wrapper and call', async () => {
    const retryFn = createRetryWrapper({ initialDelayMs: 100 })
    const fn = vi.fn().mockResolvedValue('result')

    const result = await retryFn(fn, { maxAttempts: 5 })

    expect(result).toBe('result')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
