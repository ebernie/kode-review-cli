import { describe, it, expect } from 'vitest'
import { sanitizeXmlContent, STRUCTURAL_TAGS } from '../xml-sanitize.js'

describe('sanitizeXmlContent — canonical forms (regression)', () => {
  it('escapes a plain closing structural tag', () => {
    expect(sanitizeXmlContent('a </diff_content> b', 'diff_content'))
      .toBe('a <\\/diff_content> b')
  })

  it('escapes a plain opening structural tag', () => {
    expect(sanitizeXmlContent('a <diff_content> b', 'diff_content'))
      .toBe('a <\\diff_content> b')
  })

  it('escapes case-insensitively', () => {
    expect(sanitizeXmlContent('x </DIFF_CONTENT> y', 'diff_content'))
      .toBe('x <\\/DIFF_CONTENT> y')
    expect(sanitizeXmlContent('x <Diff_Content> y', 'diff_content'))
      .toBe('x <\\Diff_Content> y')
  })

  it('leaves unrelated tags untouched', () => {
    const input = 'see <code>foo</code> and <span>bar</span>'
    expect(sanitizeXmlContent(input, 'diff_content')).toBe(input)
  })

  it('leaves benign angle-bracket text untouched', () => {
    const input = 'if (a < b && c > d) return'
    expect(sanitizeXmlContent(input, 'diff_content')).toBe(input)
  })
})

describe('sanitizeXmlContent — whitespace breakouts', () => {
  it('escapes closing tag with trailing whitespace', () => {
    expect(sanitizeXmlContent('a </diff_content > b', 'diff_content'))
      .toBe('a <\\/diff_content > b')
  })

  it('escapes closing tag with multi-character whitespace', () => {
    expect(sanitizeXmlContent('a </diff_content\t \n> b', 'diff_content'))
      .toBe('a <\\/diff_content\t \n> b')
  })

  it('escapes opening tag with trailing whitespace before >', () => {
    expect(sanitizeXmlContent('a <diff_content > b', 'diff_content'))
      .toBe('a <\\diff_content > b')
  })
})

describe('sanitizeXmlContent — attribute breakouts', () => {
  it('escapes opening tag with single attribute', () => {
    expect(sanitizeXmlContent('a <related_code path="x"> b', 'related_code'))
      .toBe('a <\\related_code path="x"> b')
  })

  it('escapes opening tag with multiple attributes', () => {
    expect(sanitizeXmlContent(
      'a <related_code path="x" relevance="high"> b',
      'related_code',
    )).toBe('a <\\related_code path="x" relevance="high"> b')
  })

  it('escapes self-closing tag with attributes', () => {
    expect(sanitizeXmlContent(
      'a <related_code path="x" /> b',
      'related_code',
    )).toBe('a <\\related_code path="x" /> b')
  })

  it('escapes attribute value containing > (closing > still terminates)', () => {
    // Attacker tries to confuse the matcher with > inside an attribute value.
    // The leading "<" is escaped, so the model cannot reparse the line as a
    // real opening tag regardless of how the attribute value is delimited.
    const result = sanitizeXmlContent(
      'a <related_code attr="a>b"> tail',
      'related_code',
    )
    expect(result.startsWith('a <\\related_code')).toBe(true)
    expect(result).not.toMatch(/(?<!\\)<related_code/)
  })
})

describe('sanitizeXmlContent — every tag in STRUCTURAL_TAGS is covered', () => {
  it.each(STRUCTURAL_TAGS)('escapes opening + closing form of <%s>', (tag) => {
    const opening = sanitizeXmlContent(`pre <${tag}> post`, tag)
    expect(opening).toBe(`pre <\\${tag}> post`)
    const closing = sanitizeXmlContent(`pre </${tag}> post`, tag)
    expect(closing).toBe(`pre <\\/${tag}> post`)
  })

  it.each(STRUCTURAL_TAGS)('escapes attribute + whitespace variant of <%s>', (tag) => {
    const attr = sanitizeXmlContent(`pre <${tag} a="b"> post`, tag)
    expect(attr).toBe(`pre <\\${tag} a="b"> post`)
    const ws = sanitizeXmlContent(`pre </${tag} > post`, tag)
    expect(ws).toBe(`pre <\\/${tag} > post`)
  })
})

describe('sanitizeXmlContent — idempotency', () => {
  it('does not double-escape already-escaped content', () => {
    const once = sanitizeXmlContent('a </diff_content> b', 'diff_content')
    const twice = sanitizeXmlContent(once, 'diff_content')
    expect(twice).toBe(once)
  })
})
