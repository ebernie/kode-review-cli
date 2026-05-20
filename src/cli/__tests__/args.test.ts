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

/**
 * D-5a: --auto-approve is the explicit opt-in gate for letting the
 * model's verdict drive an actual platform approval (GitHub APPROVE /
 * GitLab approve). The default is OFF — without this flag the bot can
 * post a comment but cannot trip a privileged approval mutation.
 *
 * These tests pin the flag's existence and default. A regression that
 * silently dropped --auto-approve from the Commander definition (or
 * inverted its default) would re-expose the original threat without
 * any other test failing.
 */
describe('parseArgs --auto-approve (D-5a opt-in gate)', () => {
  it('autoApprove defaults to false when --auto-approve is absent', () => {
    const opts = parseArgs(args())
    expect(opts.autoApprove).toBe(false)
  })

  it('--auto-approve flips autoApprove to true', () => {
    const opts = parseArgs(args('--auto-approve'))
    expect(opts.autoApprove).toBe(true)
  })

  it('autoApprove stays false in CI mode without --auto-approve (does NOT inherit from -c)', () => {
    // --ci sets postToPr + agentic + quiet defaults, but it must NOT
    // also flip auto-approve on. CI runs in shared org-level bot
    // contexts where prompt-injected approvals would be most damaging.
    const opts = parseArgs(args('-c'))
    expect(opts.ci).toBe(true)
    expect(opts.postToPr).toBe(true)
    expect(opts.autoApprove).toBe(false)
  })

  it('-c --auto-approve composes — both flags on', () => {
    const opts = parseArgs(args('-c', '--auto-approve'))
    expect(opts.ci).toBe(true)
    expect(opts.autoApprove).toBe(true)
  })
})
