import { describe, it, expect } from 'vitest'
import {
  buildReviewPrompt,
  FINDINGS_BLOCK_INSTRUCTIONS,
  NONAGENTIC_SYSTEM_PROMPT,
} from '../prompt.js'
import { FINDINGS_FENCE_TAG } from '../finding-parser.js'
import { CATEGORIES } from '../finding-schema.js'
import { UNTRUSTED_CONTENT_BOUNDARY } from '../untrusted-boundary.js'

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

  it('uses the shared FINDINGS_BLOCK_INSTRUCTIONS constant', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toContain(FINDINGS_BLOCK_INSTRUCTIONS)
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

describe('buildReviewPrompt — untrusted-content marker on related_code', () => {
  // Repository code chunks delivered as semantic context may carry
  // attacker-controlled comments/strings/filenames. Marking the wrapper
  // `untrusted="true"` aligns it with <prior_findings> and makes the
  // contract local + machine-checkable.
  it('wraps semanticContext in <related_code untrusted="true">', () => {
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: 'ctx-payload' })
    expect(p).toContain('<related_code untrusted="true">')
    expect(p).toContain('</related_code>')
    // Ensure the trust marker is on the WRAPPER, not embedded somewhere
    // else: pin the open-tag-then-content order. The documentation
    // prose inside this prompt mentions <related_code> as a tag name in
    // explanatory English, so a bare `not.toContain('<related_code>')`
    // would over-match. Anchor to "tag immediately precedes payload"
    // instead.
    expect(p).toMatch(/<related_code untrusted="true">\nctx-payload\n<\/related_code>/)
  })

  it('omits the related_code wrapper entirely when no semantic context is supplied', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toContain('<related_code')
    expect(p).not.toContain('</related_code>')
  })
})

describe('buildReviewPrompt — untrusted="true" markers on all external-data wrappers (D-5b)', () => {
  // The PR title/description, the diff content, and the PR/MR JSON are
  // all author-controlled — any contributor on a public repo can plant
  // instruction-shaped text inside them. UNTRUSTED_CONTENT_BOUNDARY in
  // the system prompt tells the model to treat content under these
  // wrappers as data; the per-wrapper attribute pins the contract
  // locally so the prompt is self-describing even if the system prompt
  // were swapped out.

  it('wraps the diff in <diff_content untrusted="true">', () => {
    const p = buildReviewPrompt({ ...baseOptions, diffContent: 'DIFF-PAYLOAD' })
    expect(p).toContain('<diff_content untrusted="true">')
    expect(p).toMatch(/<diff_content untrusted="true">\nDIFF-PAYLOAD\n<\/diff_content>/)
  })

  it('wraps pr_mr_info in <pr_mr_info untrusted="true"> when supplied', () => {
    const p = buildReviewPrompt({
      ...baseOptions,
      prMrInfo: '{"title":"PR title from contributor"}',
    })
    // Pin the wrapper attribute AND the open-tag-then-content-then-close
    // positional order so a regression that emitted the attribute on a
    // separate tag, or moved the wrapped content outside the tag pair,
    // would fail. The body is sanitized but still readable.
    expect(p).toMatch(
      /<pr_mr_info untrusted="true">[\s\S]*PR title from contributor[\s\S]*<\/pr_mr_info>/,
    )
  })

  it('wraps author_intent in <author_intent untrusted="true"> when supplied', () => {
    const p = buildReviewPrompt({
      ...baseOptions,
      prDescriptionSummary: 'INTENT-PAYLOAD',
    })
    expect(p).toContain('<author_intent untrusted="true">')
    expect(p).toMatch(/<author_intent untrusted="true">\nINTENT-PAYLOAD\n<\/author_intent>/)
  })

  it('does not regress the existing <related_code untrusted="true"> marker', () => {
    // Belt-and-suspenders: the related_code marker was added earlier
    // (D-3). Make sure this round's edits did not strip it.
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: 'CTX' })
    expect(p).toContain('<related_code untrusted="true">')
  })

  it('the *opening* wrapper tag carries the attribute (closing tag stays bare)', () => {
    // The XML convention is for the attribute to appear on the open
    // tag only. A bug that produced `<diff_content untrusted="true">
    // ... </diff_content untrusted="true">` would be valid markup but
    // confuses regex consumers downstream. Supply ALL three inputs so
    // every closing-tag assertion exercises a real generated section
    // (otherwise the negatives pass vacuously on sections that were
    // never emitted).
    const p = buildReviewPrompt({
      ...baseOptions,
      diffContent: 'DIFF',
      prMrInfo: '{"title":"x"}',
      prDescriptionSummary: 'INTENT',
    })
    expect(p).toContain('</diff_content>')
    expect(p).toContain('</pr_mr_info>')
    expect(p).toContain('</author_intent>')
    expect(p).not.toContain('</diff_content untrusted')
    expect(p).not.toContain('</pr_mr_info untrusted')
    expect(p).not.toContain('</author_intent untrusted')
  })
})

describe('NONAGENTIC_SYSTEM_PROMPT — carries the untrusted-content boundary (D-5b)', () => {
  it('embeds the shared UNTRUSTED_CONTENT_BOUNDARY verbatim', () => {
    expect(NONAGENTIC_SYSTEM_PROMPT).toContain(UNTRUSTED_CONTENT_BOUNDARY)
  })

  it('lists the wrapped data tags inside a single enumeration block', () => {
    // Pin that the three tags appear together in the same enumeration
    // (the UNTRUSTED_CONTENT_BOUNDARY enumeration of "treat as data"
    // tags), not just scattered through unrelated prose. A regression
    // that referenced one of these tag names in a docstring elsewhere
    // could otherwise satisfy independent toContain assertions.
    expect(NONAGENTIC_SYSTEM_PROMPT).toMatch(
      /<diff_content>[\s\S]{0,400}<pr_mr_info>[\s\S]{0,400}<author_intent>|<pr_mr_info>[\s\S]{0,400}<author_intent>[\s\S]{0,400}<diff_content>|<author_intent>[\s\S]{0,400}<diff_content>[\s\S]{0,400}<pr_mr_info>/,
    )
  })

  it('contains the load-bearing "never instructions" phrase', () => {
    // Pin the precise instruction-vs-data framing — a regression that
    // softened this language ("usually data" / "treat with care")
    // would weaken the boundary. Match the actual phrase used.
    expect(NONAGENTIC_SYSTEM_PROMPT).toMatch(/never.*instructions/i)
  })

  it('opens with a short reviewer-role statement before the boundary', () => {
    // The role hint at the top exists so pi's permissive default
    // system prompt is fully replaced. Without it, the model would
    // see only the boundary with no role context.
    expect(NONAGENTIC_SYSTEM_PROMPT.slice(0, 200)).toMatch(/code reviewer/i)
  })
})

describe('buildReviewPrompt — trust boundaries', () => {
  it('emits a Trust Boundary Signals section when provided', () => {
    const p = buildReviewPrompt({
      ...baseOptions,
      trustBoundarySummary: 'network: src/routes/users.ts\ndatabase: src/db/users.ts',
    })
    expect(p).toMatch(/Trust Boundary Signals/i)
    expect(p).toContain('network: src/routes/users.ts')
    expect(p).toContain('database: src/db/users.ts')
  })

  it('omits the section when not provided', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/Trust Boundary Signals/i)
  })
})
