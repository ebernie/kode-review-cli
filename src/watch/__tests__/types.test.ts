import { describe, it, expect } from 'vitest'
import { formatReviewRequest, makeReviewRequestKey } from '../types.js'
import type { ReviewRequest } from '../types.js'

const baseRequest: ReviewRequest = {
  platform: 'github',
  id: 123,
  title: 'Refactor parser',
  url: 'https://github.com/o/r/pull/123',
  repository: 'o/r',
  updatedAt: '2026-05-01T00:00:00Z',
  state: 'open',
}

describe('makeReviewRequestKey', () => {
  it('joins platform, repository, id with colons', () => {
    expect(makeReviewRequestKey(baseRequest)).toBe('github:o/r:123')
  })

  it('uses gitlab prefix for gitlab requests', () => {
    expect(
      makeReviewRequestKey({ ...baseRequest, platform: 'gitlab' }),
    ).toBe('gitlab:o/r:123')
  })
})

describe('formatReviewRequest — terminal safety', () => {
  it('renders a clean PR title as-is', () => {
    expect(formatReviewRequest(baseRequest)).toBe(
      '[GITHUB] o/r PR #123: Refactor parser',
    )
  })

  it('strips ANSI escape sequences from a malicious title', () => {
    // \x1B[31m = red, \x1B[0m = reset. Without sanitization the cyan()
    // wrapper at the call site would print real red text in the
    // middle of a "Title:" line, spoofing the next log line.
    const malicious: ReviewRequest = {
      ...baseRequest,
      title: '\x1B[31mFAKE BUILD FAILED\x1B[0m Refactor parser',
    }
    const out = formatReviewRequest(malicious)
    expect(out).not.toContain('\x1B')
    expect(out).toBe('[GITHUB] o/r PR #123: FAKE BUILD FAILED Refactor parser')
  })

  it('strips OSC 52 (clipboard manipulation) from a title', () => {
    const malicious: ReviewRequest = {
      ...baseRequest,
      title: 'innocent\x1B]52;c;cm0gLXJmIC8=\x07 title',
    }
    const out = formatReviewRequest(malicious)
    expect(out).not.toContain('\x1B]')
    expect(out).toContain('innocent title')
  })

  it('strips carriage returns (line-rewrite spoofing)', () => {
    // A bare \r lets an attacker overwrite the current line in many
    // terminals. We strip it along with other C0 controls.
    const malicious: ReviewRequest = {
      ...baseRequest,
      title: 'visible part\r---OVERWRITTEN---',
    }
    const out = formatReviewRequest(malicious)
    expect(out).not.toContain('\r')
    expect(out).toContain('visible part---OVERWRITTEN---')
  })

  it('also sanitizes the repository field (attacker-controlled namespace)', () => {
    // A maliciously-named GitHub repo or GitLab namespace flows through
    // the same path. Both must be sanitized.
    const malicious: ReviewRequest = {
      ...baseRequest,
      repository: 'org/r\x1B[2K\x1B[A',
    }
    const out = formatReviewRequest(malicious)
    expect(out).not.toContain('\x1B')
    expect(out).toContain('org/r')
  })

  it('sanitizes title AND repository independently in the same render', () => {
    // Pins the dual-field contract: a regression that extracted
    // sanitization into a single shared call but accidentally applied
    // it to only one of the two fields would slip past the existing
    // per-field tests. Use distinct payloads so we can verify each was
    // independently neutralized.
    const malicious: ReviewRequest = {
      ...baseRequest,
      title: '\x1B[31mTITLE-ESC\x1B[0m clean title',
      repository: 'org/r\x1B[2K\x1B[A',
    }
    const out = formatReviewRequest(malicious)
    expect(out).not.toContain('\x1B')
    expect(out).toBe('[GITHUB] org/r PR #123: TITLE-ESC clean title')
  })

  it('preserves emoji and unicode in safe titles', () => {
    const utf: ReviewRequest = {
      ...baseRequest,
      title: 'Fix Café crash 🎉',
    }
    expect(formatReviewRequest(utf)).toBe(
      '[GITHUB] o/r PR #123: Fix Café crash 🎉',
    )
  })
})
