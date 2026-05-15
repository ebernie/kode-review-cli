import { describe, it, expect } from 'vitest'
import { parseRipgrepJsonOutput } from '../ripgrep.js'

describe('parseRipgrepJsonOutput', () => {
  it('extracts matches from rg --json line-delimited output', () => {
    const raw = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'export function foo() {\n' },
          line_number: 12,
          submatches: [{ match: { text: 'foo' }, start: 16, end: 19 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
    ].join('\n')

    const matches = parseRipgrepJsonOutput(raw)

    expect(matches).toEqual([
      {
        path: 'src/a.ts',
        line: 12,
        text: 'export function foo() {',
        matchText: 'foo',
        column: 17,
      },
    ])
  })

  it('returns an empty array for no-match output', () => {
    expect(parseRipgrepJsonOutput('')).toEqual([])
  })

  it('ignores non-match event types', () => {
    const raw = JSON.stringify({ type: 'summary', data: {} })
    expect(parseRipgrepJsonOutput(raw)).toEqual([])
  })

  it('throws on malformed JSON lines', () => {
    expect(() => parseRipgrepJsonOutput('{not json')).toThrow(/parse/i)
  })

  it('fails fast when a malformed line follows a valid match line', () => {
    const valid = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'x.ts' },
        lines: { text: 'foo\n' },
        line_number: 1,
        submatches: [{ match: { text: 'foo' }, start: 0, end: 3 }],
      },
    })
    const raw = `${valid}\n{garbage`
    expect(() => parseRipgrepJsonOutput(raw)).toThrow(/parse/i)
  })

  it('reports column=1 when the match starts at column 0', () => {
    const raw = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'x.ts' },
        lines: { text: 'foo\n' },
        line_number: 1,
        submatches: [{ match: { text: 'foo' }, start: 0, end: 3 }],
      },
    })
    expect(parseRipgrepJsonOutput(raw)[0].column).toBe(1)
  })

  it('falls back to safe defaults when optional fields are missing', () => {
    const raw = JSON.stringify({ type: 'match', data: {} })
    expect(parseRipgrepJsonOutput(raw)).toEqual([
      { path: '', line: 0, text: '', matchText: '', column: 1 },
    ])
  })
})
