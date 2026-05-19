import { describe, it, expect } from 'vitest'
import { UNTRUSTED_CONTENT_BOUNDARY } from '../untrusted-boundary.js'
import { STRUCTURAL_TAGS } from '../xml-sanitize.js'

describe('UNTRUSTED_CONTENT_BOUNDARY', () => {
  it('explicitly names every structural tag from xml-sanitize', () => {
    // Every structural tag we sanitize must appear in the boundary text so
    // the model understands that content inside that tag is untrusted data.
    // If a future tag is added to STRUCTURAL_TAGS, this test fails until the
    // boundary text is updated — keeping the two in sync by construction.
    for (const tag of STRUCTURAL_TAGS) {
      expect(UNTRUSTED_CONTENT_BOUNDARY).toContain(`<${tag}>`)
    }
  })

  it('does not promise to escape tags the sanitizer cannot enforce', () => {
    // Reverse direction: any tag named in the boundary text MUST also be
    // in STRUCTURAL_TAGS, so the sanitizer can actually escape it when
    // it appears in user content. Without this check, the model is told
    // "we treat <foo> as untrusted" while <foo> flows through verbatim —
    // a false sense of security.
    const mentioned = new Set<string>()
    const tagRe = /<([a-z_]+)>/gi
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(UNTRUSTED_CONTENT_BOUNDARY)) !== null) {
      mentioned.add(m[1].toLowerCase())
    }
    const known = new Set(STRUCTURAL_TAGS.map(t => t.toLowerCase()))
    const unenforced = [...mentioned].filter(t => !known.has(t))
    expect(unenforced).toEqual([])
  })

  it('names file-content and tool-output sources', () => {
    expect(UNTRUSTED_CONTENT_BOUNDARY).toMatch(/<file[^>]*>/)
    expect(UNTRUSTED_CONTENT_BOUNDARY).toContain('<feature_metadata>')
    expect(UNTRUSTED_CONTENT_BOUNDARY.toLowerCase()).toContain('tool')
  })

  it('tells the model not to follow embedded instructions', () => {
    const lower = UNTRUSTED_CONTENT_BOUNDARY.toLowerCase()
    expect(lower).toMatch(/do not (follow|obey|execute|act on)/i)
    expect(lower).toContain('instruction')
  })

  it('is non-empty and reasonably sized', () => {
    expect(UNTRUSTED_CONTENT_BOUNDARY.length).toBeGreaterThan(200)
    expect(UNTRUSTED_CONTENT_BOUNDARY.length).toBeLessThan(2000)
  })
})
