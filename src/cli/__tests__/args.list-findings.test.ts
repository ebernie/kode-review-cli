/**
 * Tests for `--list-findings` flag and its `--severity` / `--status` filters.
 */
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../args.js'

function args(...rest: string[]): string[] {
  return ['node', 'kode-review', ...rest]
}

describe('parseArgs: --list-findings', () => {
  it('defaults to false when flag is absent', () => {
    const opts = parseArgs(args())
    expect(opts.listFindings).toBe(false)
    expect(opts.findingsSeverity).toBeUndefined()
    expect(opts.findingsStatus).toBeUndefined()
  })

  it('sets listFindings when the flag is passed', () => {
    const opts = parseArgs(args('--list-findings'))
    expect(opts.listFindings).toBe(true)
  })

  it('parses --severity into a normalized uppercase array', () => {
    const opts = parseArgs(args('--list-findings', '--severity', 'critical,High'))
    expect(opts.findingsSeverity).toEqual(['CRITICAL', 'HIGH'])
  })

  it('parses --status into a normalized lowercase array', () => {
    const opts = parseArgs(args('--list-findings', '--status', 'open,Fixed'))
    expect(opts.findingsStatus).toEqual(['open', 'fixed'])
  })

  it('rejects unknown severity values with a clear error', () => {
    expect(() => parseArgs(args('--list-findings', '--severity', 'critical,info'))).toThrow(
      /Invalid --severity value: "INFO"/,
    )
  })

  it('rejects unknown status values with a clear error', () => {
    expect(() => parseArgs(args('--list-findings', '--status', 'open,resolved'))).toThrow(
      /Invalid --status value: "resolved"/,
    )
  })

  it('accepts all documented status values', () => {
    const opts = parseArgs(
      args('--list-findings', '--status', 'open,uncertain,fixed,false-positive,wont-fix'),
    )
    expect(opts.findingsStatus).toEqual([
      'open',
      'uncertain',
      'fixed',
      'false-positive',
      'wont-fix',
    ])
  })

  it('accepts --severity/--status without --list-findings (inert filters)', () => {
    // The flags only act on --list-findings; we still parse them so users
    // can experiment without combinatorial parse errors.
    const opts = parseArgs(args('--severity', 'low', '--status', 'open'))
    expect(opts.listFindings).toBe(false)
    expect(opts.findingsSeverity).toEqual(['LOW'])
    expect(opts.findingsStatus).toEqual(['open'])
  })

  it('leaves filter fields undefined when only one filter flag is passed', () => {
    const opts = parseArgs(args('--severity', 'low'))
    expect(opts.findingsSeverity).toEqual(['LOW'])
    expect(opts.findingsStatus).toBeUndefined()
  })
})
