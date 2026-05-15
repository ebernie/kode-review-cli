import { describe, it, expect } from 'vitest'
import { parseArgs } from '../args.js'

function args(...rest: string[]): string[] {
  return ['node', 'kode-review', ...rest]
}

describe('parseArgs short-flag aliases', () => {
  it('-a is a no-op since agentic is the default (kept for explicit-intent / backward compat)', () => {
    const opts = parseArgs(args('-a'))
    expect(opts.agentic).toBe(true)
    expect(opts.quiet).toBe(false)
    expect(opts.postToPr).toBe(false)
    expect(opts.format).toBe('text')
  })

  it('--no-agentic switches to diff-only mode', () => {
    const opts = parseArgs(args('--no-agentic'))
    expect(opts.agentic).toBe(false)
    expect(opts.ci).toBe(false)
  })

  it('-c enables CI mode and bundles agentic + markdown + quiet + post-to-pr defaults', () => {
    const opts = parseArgs(args('-c'))
    expect(opts.ci).toBe(true)
    expect(opts.agentic).toBe(true)
    expect(opts.format).toBe('markdown')
    expect(opts.quiet).toBe(true)
    expect(opts.postToPr).toBe(true)
  })

  it('-c respects an explicit -f override but keeps the other CI bundles', () => {
    const opts = parseArgs(args('-c', '-f', 'json'))
    expect(opts.ci).toBe(true)
    expect(opts.format).toBe('json')
    expect(opts.agentic).toBe(true)
    expect(opts.quiet).toBe(true)
    expect(opts.postToPr).toBe(true)
  })

  it('-c --no-suppressions disables source-marker filtering while keeping CI bundles', () => {
    const opts = parseArgs(args('-c', '--no-suppressions'))
    expect(opts.ci).toBe(true)
    expect(opts.noSuppressions).toBe(true)
    expect(opts.agentic).toBe(true)
    expect(opts.format).toBe('markdown')
  })

  it('default invocation is agentic mode against auto-detected scope with 10-min timeout', () => {
    const opts = parseArgs(args())
    expect(opts.agentic).toBe(true)
    expect(opts.ci).toBe(false)
    expect(opts.scope).toBe('auto')
    expect(opts.format).toBe('text')
    expect(opts.agenticTimeout).toBe(600)
  })

  it('-p <n> selects agentic review of a specific PR (agentic is the default)', () => {
    const opts = parseArgs(args('-p', '1234'))
    expect(opts.agentic).toBe(true)
    expect(opts.pr).toBe('1234')
  })

  it.each([
    ['--no-agentic before -c', ['--no-agentic', '-c']],
    ['-c before --no-agentic', ['-c', '--no-agentic']],
  ])('--ci overrides --no-agentic regardless of flag order (%s)', (_label, flags) => {
    const opts = parseArgs(args(...flags))
    expect(opts.ci).toBe(true)
    expect(opts.agentic).toBe(true)
  })

  it('-c -q keeps quiet=true (explicit -q is honored, not clobbered by CI default)', () => {
    const opts = parseArgs(args('-c', '-q'))
    expect(opts.ci).toBe(true)
    expect(opts.quiet).toBe(true)
  })
})
