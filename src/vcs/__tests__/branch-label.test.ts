import { describe, it, expect } from 'vitest'
import { resolveBranchLabel } from '../branch-label.js'

describe('resolveBranchLabel', () => {
  it('returns the branch name when one is present', () => {
    expect(resolveBranchLabel('feature/x', { ci: false })).toBe('feature/x')
  })

  it('returns the branch name even when --ci is on', () => {
    expect(resolveBranchLabel('feature/x', { ci: true })).toBe('feature/x')
  })

  it('throws on empty branch in interactive mode without --pr', () => {
    expect(() => resolveBranchLabel(null, { ci: false })).toThrow(
      'Could not determine current branch',
    )
    expect(() => resolveBranchLabel('', { ci: false })).toThrow(
      'Could not determine current branch',
    )
  })

  it('falls back to "HEAD" in --ci mode when branch is empty', () => {
    // Detached-HEAD is the norm in CI runs that check out by commit SHA.
    // Regression guard for the bug where CI runs hard-errored with
    // "Could not determine current branch" before reaching the review.
    expect(resolveBranchLabel(null, { ci: true })).toBe('HEAD')
    expect(resolveBranchLabel('', { ci: true })).toBe('HEAD')
  })

  it('falls back to "HEAD" when --pr is explicit even outside --ci', () => {
    // selectPrMr() short-circuits on an explicit PR id, so the branch
    // name is just a log label in that path — don't block the run.
    expect(resolveBranchLabel(null, { ci: false, pr: '42' })).toBe('HEAD')
    // '' is the realistic detached-HEAD output from git branch --show-current.
    expect(resolveBranchLabel('', { ci: false, pr: '42' })).toBe('HEAD')
  })

  it('handles undefined branch the same as null/empty', () => {
    expect(resolveBranchLabel(undefined, { ci: true })).toBe('HEAD')
    expect(() => resolveBranchLabel(undefined, { ci: false })).toThrow()
  })
})
