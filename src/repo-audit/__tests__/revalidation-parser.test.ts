/**
 * Tests for revalidation-parser.ts.
 *
 * Mirrors the patterns in src/review/__tests__/finding-parser.test.ts
 * (fenced-block extraction, tolerant of absence, schema validation).
 *
 * Notes on what these tests deliberately do NOT assert:
 *   - "Unknown findingId" filtering — that is the engine wrapper's job
 *     (kode-agent-revalidate.ts), not the parser's. The parser is a pure
 *     transport adapter.
 */
import { describe, expect, it } from 'vitest'
import { parseRevalidationBlock } from '../revalidation-parser.js'
import {
  REVALIDATIONS_FENCE_TAG,
  verdictToStatus,
} from '../revalidation-schema.js'

function fenced(body: string): string {
  return '```' + REVALIDATIONS_FENCE_TAG + '\n' + body + '\n```'
}

describe('parseRevalidationBlock', () => {
  it('extracts a valid block with one verdict', () => {
    const raw = [
      'Some narrative text the agent emitted.',
      '',
      fenced(JSON.stringify({
        revalidations: [
          { findingId: 'abc', verdict: 'fixed', evidence: 'function removed' },
        ],
      })),
    ].join('\n')
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations).toHaveLength(1)
    expect(result.revalidations[0]).toEqual({
      findingId: 'abc',
      verdict: 'fixed',
      evidence: 'function removed',
    })
  })

  it('extracts every supported verdict value', () => {
    const raw = fenced(JSON.stringify({
      revalidations: [
        { findingId: 'a', verdict: 'fixed' },
        { findingId: 'b', verdict: 'still-present' },
        { findingId: 'c', verdict: 'uncertain' },
      ],
    }))
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations.map((v) => v.verdict)).toEqual([
      'fixed',
      'still-present',
      'uncertain',
    ])
  })

  it('returns error="missing" when no fenced block is present', () => {
    const result = parseRevalidationBlock('No fenced block here.')
    expect(result.error).toBe('missing')
    expect(result.revalidations).toEqual([])
  })

  it('returns error="missing" for a fenced block with a different tag', () => {
    // A `kode-findings` block must NOT be picked up by the revalidation
    // parser — wires were almost crossed and that would have caused chaos.
    const raw = '```kode-findings\n{ "findings": [] }\n```'
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBe('missing')
  })

  it('returns error="invalid-json" when the block body is not JSON', () => {
    const raw = fenced('this is not json at all')
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBe('invalid-json')
    expect(result.detail).toBeDefined()
  })

  it('returns error="schema" when JSON is well-formed but wrong shape', () => {
    const raw = fenced(JSON.stringify({ findings: [] })) // wrong top-level key
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBe('schema')
  })

  it('rejects unknown verdict values via the schema gate', () => {
    // `false-positive` is a valid RepoFindingStatus but NOT a valid
    // RevalidationVerdict — the agent must not be allowed to assign it.
    const raw = fenced(JSON.stringify({
      revalidations: [{ findingId: 'a', verdict: 'false-positive' }],
    }))
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBe('schema')
  })

  it('rejects empty findingId strings', () => {
    const raw = fenced(JSON.stringify({
      revalidations: [{ findingId: '', verdict: 'fixed' }],
    }))
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBe('schema')
  })

  it('accepts entries without an evidence field', () => {
    const raw = fenced(JSON.stringify({
      revalidations: [{ findingId: 'a', verdict: 'still-present' }],
    }))
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations[0]?.evidence).toBeUndefined()
  })

  it('uses the LAST block when multiple are present (matches findings-parser semantics)', () => {
    // If the agent retried mid-response, only the final block is canonical.
    const raw = [
      fenced(JSON.stringify({ revalidations: [{ findingId: 'a', verdict: 'fixed' }] })),
      'Some interleaved text.',
      fenced(JSON.stringify({ revalidations: [{ findingId: 'b', verdict: 'still-present' }] })),
    ].join('\n')
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations).toEqual([
      { findingId: 'b', verdict: 'still-present' },
    ])
  })

  it('accepts an empty revalidations array (parser is lenient; caller decides)', () => {
    // The caller (engine wrapper) will turn an empty block into "every
    // finding gets 'uncertain'", but the parser itself shouldn't reject a
    // structurally-valid empty payload.
    const raw = fenced(JSON.stringify({ revalidations: [] }))
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations).toEqual([])
  })

  it('tolerates CRLF line endings inside the fenced body', () => {
    // Windows-style line endings show up in pi output occasionally; the
    // regex must not require LF-only delimiters.
    const body = JSON.stringify({
      revalidations: [{ findingId: 'a', verdict: 'fixed' }],
    })
    const raw = '```' + REVALIDATIONS_FENCE_TAG + '\r\n' + body + '\r\n```'
    const result = parseRevalidationBlock(raw)
    expect(result.error).toBeUndefined()
    expect(result.revalidations).toHaveLength(1)
  })

  it('does not match an indented fence (must start at column 0)', () => {
    // Mirrors finding-parser behavior: indented fences could be model-quoted
    // examples and must not be misinterpreted as the canonical block.
    const indented =
      '    ```' + REVALIDATIONS_FENCE_TAG + '\n' +
      '    { "revalidations": [] }\n' +
      '    ```'
    const result = parseRevalidationBlock(indented)
    expect(result.error).toBe('missing')
  })
})

describe('verdictToStatus', () => {
  it('maps fixed → fixed', () => {
    expect(verdictToStatus('fixed')).toBe('fixed')
  })

  it('maps still-present → open (preserves the open lifecycle)', () => {
    expect(verdictToStatus('still-present')).toBe('open')
  })

  it('maps uncertain → uncertain', () => {
    expect(verdictToStatus('uncertain')).toBe('uncertain')
  })
})
