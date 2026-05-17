import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../prompt.js'
import { FINDINGS_FENCE_TAG } from '../finding-parser.js'
import { CATEGORIES } from '../finding-schema.js'

const baseOptions = {
  context: 'ctx',
  diffContent: 'diff --git a/x b/x',
}

describe('buildReviewPrompt — schema-strict output', () => {
  it('demands a fenced kode-findings JSON block in the output format', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toContain('```' + FINDINGS_FENCE_TAG)
    expect(p).toMatch(/REQUIRED.*kode-findings/i)
  })

  it('lists the canonical category enum verbatim', () => {
    const p = buildReviewPrompt(baseOptions)
    for (const c of CATEGORIES) {
      expect(p).toContain(c)
    }
  })

  it('explains the two-axis severity × confidence model', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toMatch(/severity.*confidence/i)
    expect(p).toMatch(/independent|separate|two axes/i)
  })

  it('requires evidence for every finding', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toMatch(/evidence.*required/i)
  })
})
