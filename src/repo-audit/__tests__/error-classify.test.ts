import { describe, expect, it } from 'vitest'
import { isRateLimitError, isTransientModelError } from '../error-classify.js'

describe('isRateLimitError', () => {
  it('detects ChatGPT plus-plan usage-limit messages', () => {
    const err = new Error(
      'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~261 min.',
    )
    expect(isRateLimitError(err)).toBe(true)
  })

  it('detects HTTP 429 mentions', () => {
    expect(isRateLimitError(new Error('Request failed: 429 Too Many Requests'))).toBe(true)
  })

  it('detects "rate limit" phrasing regardless of case', () => {
    expect(isRateLimitError(new Error('Rate Limit exceeded for model openai/gpt-5'))).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isRateLimitError(new Error('ENOENT: no such file'))).toBe(false)
    expect(isRateLimitError(new Error('Review response contained no text content.'))).toBe(false)
  })

  it('tolerates non-Error inputs', () => {
    expect(isRateLimitError('429 Too Many Requests')).toBe(true)
    expect(isRateLimitError(undefined)).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})

describe('isTransientModelError', () => {
  it('treats rate-limits as transient', () => {
    expect(isTransientModelError(new Error('429 Too Many Requests'))).toBe(true)
  })

  it('treats timeouts as transient', () => {
    expect(isTransientModelError(new Error('Review did not complete within 600s.'))).toBe(true)
    expect(isTransientModelError(new Error('ETIMEDOUT contacting api.openai.com'))).toBe(true)
  })

  it('returns false for code-side bugs', () => {
    expect(isTransientModelError(new TypeError('foo is not a function'))).toBe(false)
  })
})
