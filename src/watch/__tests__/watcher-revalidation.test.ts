import { describe, it, expect } from 'vitest'
import { extractHeadRef, isRetryableWatchError } from '../watcher.js'

describe('extractHeadRef', () => {
  it('reads GitHub headRefOid', () => {
    expect(extractHeadRef('github', { headRefOid: 'abc123' })).toBe('abc123')
  })

  it('reads GitLab sha', () => {
    expect(extractHeadRef('gitlab', { sha: 'def456' })).toBe('def456')
  })

  it('falls back to GitLab diff_refs.head_sha', () => {
    expect(extractHeadRef('gitlab', { diff_refs: { head_sha: 'ghi789' } })).toBe('ghi789')
  })

  it('returns undefined for missing data', () => {
    expect(extractHeadRef('github', null)).toBeUndefined()
    expect(extractHeadRef('github', {})).toBeUndefined()
    expect(extractHeadRef('gitlab', { wrong: 'field' })).toBeUndefined()
  })
})

describe('isRetryableWatchError', () => {
  it('does not treat embedded status-code substrings as retryable', () => {
    expect(isRetryableWatchError('error code 15029')).toBe(false)
  })

  it('treats labeled transient HTTP statuses as retryable', () => {
    expect(isRetryableWatchError('HTTP 502 from GitHub')).toBe(true)
    expect(isRetryableWatchError('status 429 from GitLab')).toBe(true)
  })

  it('treats transient HTTP reason phrases as retryable', () => {
    expect(isRetryableWatchError('502 Bad Gateway from GitHub')).toBe(true)
    expect(isRetryableWatchError('429 Too Many Requests from GitLab')).toBe(true)
  })

  it('keeps existing text-based transient classifications', () => {
    expect(isRetryableWatchError('socket hang up while polling')).toBe(true)
    expect(isRetryableWatchError('repository not found')).toBe(false)
  })
})
