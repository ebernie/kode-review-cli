import { describe, it, expect } from 'vitest'
import {
  buildRevalidatePrompt,
  RevalidationOutcomeSchema,
  parseRevalidationBlock,
  REVALIDATION_FENCE_TAG,
} from '../revalidate-prompt.js'
import type { Finding } from '../finding-schema.js'

const f: Finding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 'SQLi',
  file: 'src/db.ts',
  lineStart: 10,
  lineEnd: 12,
  evidence: 'q',
  problem: 'p',
  recommendation: 'r',
}

describe('buildRevalidatePrompt', () => {
  it('includes prior findings and the new diff', () => {
    const p = buildRevalidatePrompt({ priorFindings: [f], newDiff: 'diff --git a/x b/x' })
    expect(p).toContain('SQLi')
    expect(p).toContain('diff --git')
    expect(p).toMatch(/still present|resolved|unverifiable/i)
    expect(p).toContain('```' + REVALIDATION_FENCE_TAG)
  })

  it('explains how to classify each prior finding', () => {
    const p = buildRevalidatePrompt({ priorFindings: [f], newDiff: 'd' })
    expect(p).toMatch(/still-present/)
    expect(p).toMatch(/resolved/)
    expect(p).toMatch(/unverifiable/)
  })
})

describe('parseRevalidationBlock', () => {
  it('parses a well-formed revalidation block', () => {
    const body = JSON.stringify({
      outcomes: [
        { findingTitle: 'SQLi', status: 'resolved', rationale: 'parameterised now' },
      ],
    })
    const out = parseRevalidationBlock([
      '```' + REVALIDATION_FENCE_TAG,
      body,
      '```',
    ].join('\n'))
    expect(out.outcomes).toHaveLength(1)
    expect(out.outcomes[0].status).toBe('resolved')
  })

  it('returns missing when the block is absent', () => {
    expect(parseRevalidationBlock('nothing').error).toBe('missing')
  })

  it('rejects unknown statuses', () => {
    const body = JSON.stringify({
      outcomes: [{ findingTitle: 't', status: 'maybe', rationale: 'r' }],
    })
    const out = parseRevalidationBlock([
      '```' + REVALIDATION_FENCE_TAG,
      body,
      '```',
    ].join('\n'))
    expect(out.error).toBe('schema')
  })
})

describe('RevalidationOutcomeSchema', () => {
  it('accepts the three canonical statuses', () => {
    for (const s of ['still-present', 'resolved', 'unverifiable'] as const) {
      RevalidationOutcomeSchema.parse({ findingTitle: 't', status: s, rationale: 'r' })
    }
  })
})
