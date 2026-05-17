import { describe, it, expect } from 'vitest'
import { extractHeadRef } from '../watcher.js'

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
