import { describe, it, expect } from 'vitest'
import { parseFindingsBlock, FINDINGS_FENCE_TAG } from '../finding-parser.js'

const sampleFinding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 'SQLi',
  file: 'src/db.ts',
  lineStart: 10,
  lineEnd: 12,
  evidence: 'query',
  problem: 'p',
  recommendation: 'r',
}

function wrap(body: string): string {
  return [
    '### Summary',
    'some markdown',
    '',
    '```' + FINDINGS_FENCE_TAG,
    body,
    '```',
    '',
    '### Final Verdict',
  ].join('\n')
}

describe('parseFindingsBlock', () => {
  it('extracts findings from a well-formed block', () => {
    const out = parseFindingsBlock(wrap(JSON.stringify({ findings: [sampleFinding] })))
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].title).toBe('SQLi')
    expect(out.error).toBeUndefined()
  })

  it('returns an empty list when block is missing', () => {
    const out = parseFindingsBlock('### Summary\nno block here\n')
    expect(out.findings).toEqual([])
    expect(out.error).toBe('missing')
  })

  it('reports parse failure when JSON is malformed', () => {
    const out = parseFindingsBlock(wrap('{ not json'))
    expect(out.findings).toEqual([])
    expect(out.error).toBe('invalid-json')
  })

  it('reports schema failure when findings do not validate', () => {
    const bad = { findings: [{ ...sampleFinding, severity: 'NIT' }] }
    const out = parseFindingsBlock(wrap(JSON.stringify(bad)))
    expect(out.findings).toEqual([])
    expect(out.error).toBe('schema')
    expect(out.detail).toMatch(/severity/)
  })

  it('uses the LAST findings block when several are present', () => {
    const first = { findings: [{ ...sampleFinding, title: 'first' }] }
    const second = { findings: [{ ...sampleFinding, title: 'second' }] }
    const body = [wrap(JSON.stringify(first)), wrap(JSON.stringify(second))].join('\n')
    const out = parseFindingsBlock(body)
    expect(out.findings[0].title).toBe('second')
  })

  it('does not match the fence tag when not anchored at column 0', () => {
    const body = [
      '```ts',
      '// fake: ```' + FINDINGS_FENCE_TAG,
      '```',
    ].join('\n')
    const out = parseFindingsBlock(body)
    expect(out.error).toBe('missing')
  })
})
