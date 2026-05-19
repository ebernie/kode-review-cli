/**
 * Tests for --scope repo CLI parsing and the associated flag set.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../args.js'

function args(...rest: string[]): string[] {
  return ['node', 'kode-review', ...rest]
}

describe('parseArgs: --scope repo', () => {
  it('accepts repo as a scope value', () => {
    const opts = parseArgs(args('--scope', 'repo'))
    expect(opts.scope).toBe('repo')
  })

  it('defaults to kode-agent engine', () => {
    const opts = parseArgs(args('--scope', 'repo'))
    expect(opts.engine).toBe('kode-agent')
  })

  it('accepts --engine clawpatch', () => {
    const opts = parseArgs(args('--scope', 'repo', '--engine', 'clawpatch'))
    expect(opts.engine).toBe('clawpatch')
  })

  it('rejects an unknown engine name', () => {
    expect(() => parseArgs(args('--scope', 'repo', '--engine', 'gpt-fast'))).toThrow(/Invalid --engine/)
  })

  it('--jobs defaults to 4', () => {
    const opts = parseArgs(args('--scope', 'repo'))
    expect(opts.jobs).toBe(4)
  })

  it('--jobs accepts an explicit integer in range', () => {
    const opts = parseArgs(args('--scope', 'repo', '--jobs', '12'))
    expect(opts.jobs).toBe(12)
  })

  it('--jobs rejects values out of [1, 32]', () => {
    expect(() => parseArgs(args('--scope', 'repo', '--jobs', '0'))).toThrow(/Invalid --jobs/)
    expect(() => parseArgs(args('--scope', 'repo', '--jobs', '33'))).toThrow(/Invalid --jobs/)
    expect(() => parseArgs(args('--scope', 'repo', '--jobs', 'abc'))).toThrow(/Invalid --jobs/)
  })

  it('--since is stored verbatim for downstream git use', () => {
    const opts = parseArgs(args('--scope', 'repo', '--since', 'origin/main'))
    expect(opts.since).toBe('origin/main')
  })

  it('--report-only sets the report-only flag', () => {
    const opts = parseArgs(args('--scope', 'repo', '--report-only'))
    expect(opts.reportOnly).toBe(true)
    expect(opts.revalidate).toBe(false)
  })

  it('--revalidate sets the revalidate flag', () => {
    const opts = parseArgs(args('--scope', 'repo', '--revalidate'))
    expect(opts.revalidate).toBe(true)
    expect(opts.reportOnly).toBe(false)
  })

  it('--remap and --clawpatch-compat are off by default', () => {
    const opts = parseArgs(args('--scope', 'repo'))
    expect(opts.remap).toBe(false)
    expect(opts.clawpatchCompat).toBe(false)
  })

  it('--remap and --clawpatch-compat toggle on', () => {
    const opts = parseArgs(args('--scope', 'repo', '--remap', '--clawpatch-compat'))
    expect(opts.remap).toBe(true)
    expect(opts.clawpatchCompat).toBe(true)
  })

  it('refuses --scope repo combined with --pr', () => {
    expect(() => parseArgs(args('--scope', 'repo', '--pr', '42'))).toThrow(/--scope repo cannot be combined with --pr/)
  })

  it('refuses --report-only combined with --revalidate (contradictory intent)', () => {
    expect(() => parseArgs(args('--scope', 'repo', '--report-only', '--revalidate'))).toThrow(/contradictory intent|cannot be combined/)
  })

  it('rejects --scope repo + --watch at parse time (periodic repo-audit not yet supported)', () => {
    expect(() => parseArgs(args('--scope', 'repo', '--watch'))).toThrow(
      /--watch with --scope repo is not yet supported/,
    )
  })
})

describe('parseArgs: --scope validation', () => {
  it.each(['local', 'pr', 'both', 'auto', 'repo'])(
    'accepts the documented scope value: %s',
    (scope) => {
      expect(() => parseArgs(args('--scope', scope))).not.toThrow()
    },
  )

  it('rejects an unknown scope value with a clear error', () => {
    expect(() => parseArgs(args('--scope', 'pull'))).toThrow(/Invalid --scope/)
  })

  it('rejects an empty-string scope value', () => {
    expect(() => parseArgs(args('--scope', ''))).toThrow(/Invalid --scope/)
  })

  it('lists the allowed values in the error message', () => {
    expect(() => parseArgs(args('--scope', 'nonsense'))).toThrow(
      /local.*pr.*both.*auto.*repo/,
    )
  })
})
