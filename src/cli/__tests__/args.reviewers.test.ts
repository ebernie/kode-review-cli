import { describe, it, expect } from 'vitest'
import { parseArgs } from '../args.js'

/**
 * `parseArgs` takes a full argv-style array (i.e. `['node', 'kode-review',
 * ...]`). These tests focus on `--reviewer` / `--list-reviewers` parsing
 * only; other flags are exercised elsewhere.
 */
function parse(...rest: string[]) {
  return parseArgs(['node', 'kode-review', ...rest])
}

describe('parseArgs — --reviewer', () => {
  it('defaults to [\'general\'] when --reviewer is not provided', () => {
    const opts = parse()
    expect(opts.reviewers).toEqual(['general'])
    expect(opts.listReviewers).toBe(false)
  })

  it('accepts a single reviewer name', () => {
    const opts = parse('--reviewer', 'security')
    expect(opts.reviewers).toEqual(['security'])
  })

  it('accepts a comma-separated list within one flag', () => {
    const opts = parse('--reviewer', 'security,architect,doc-reviewer')
    expect(opts.reviewers).toEqual(['security', 'architect', 'doc-reviewer'])
  })

  it('accumulates multiple --reviewer occurrences', () => {
    const opts = parse('--reviewer', 'security', '--reviewer', 'architect')
    expect(opts.reviewers).toEqual(['security', 'architect'])
  })

  it('combines repeated and comma-separated forms', () => {
    const opts = parse('--reviewer', 'security,architect', '--reviewer', 'doc-reviewer')
    expect(opts.reviewers).toEqual(['security', 'architect', 'doc-reviewer'])
  })

  it('passes the literal "all" token through unchanged for the runner to expand', () => {
    const opts = parse('--reviewer', 'all')
    // Note: --reviewer is intentionally NOT validated at parse time. Unknown
    // reviewer names produce a clearer error downstream from resolveReviewer.
    expect(opts.reviewers).toEqual(['all'])
  })

  it('drops empty tokens from "a,,b"', () => {
    const opts = parse('--reviewer', 'security,,architect')
    expect(opts.reviewers).toEqual(['security', 'architect'])
  })

  it('exposes --list-reviewers as a discrete flag', () => {
    const opts = parse('--list-reviewers')
    expect(opts.listReviewers).toBe(true)
  })
})
