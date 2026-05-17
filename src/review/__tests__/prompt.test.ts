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

describe('buildReviewPrompt — tests as ground truth', () => {
  it('emits the tests-as-ground-truth section when semantic context is present', () => {
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: '<context type="test" path="x" lines="1-2">x</context>' })
    expect(p).toMatch(/tests as ground truth/i)
    expect(p).toMatch(/downgrade.*confidence|skip the finding/i)
    expect(p).toContain('<test>')
  })

  it('does NOT emit the tests-as-ground-truth section without semantic context', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/tests as ground truth/i)
  })
})

describe('buildReviewPrompt — findings scope', () => {
  it('forbids findings against retrieved context', () => {
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: 'ctx' })
    expect(p).toMatch(/findings.*only.*diff|may not.*context.*findings/i)
    expect(p).toMatch(/<related_code>.*read-only|read-only.*<related_code>/i)
  })

  it('omits the scope section when there is no semantic context', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/Findings Scope/i)
  })
})
