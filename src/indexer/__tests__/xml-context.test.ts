import { describe, it, expect } from 'vitest'
import {
  formatChunkAsXml,
  formatContextAsXml,
  getContextType,
  getRelevanceLevel,
  getRetrievalReason,
  formatImpactAsXml,
} from '../xml-context.js'
import type { WeightedCodeChunk, ImpactAnalysisResult } from '../types.js'

function chunk(overrides: Partial<WeightedCodeChunk> = {}): WeightedCodeChunk {
  return {
    filename: 'src/foo.ts',
    code: 'function foo() { return 42 }',
    startLine: 10,
    endLine: 12,
    score: 0.8,
    originalScore: 0.85,
    weightMultiplier: 1.0,
    isModifiedContext: false,
    isTestFile: false,
    matchesDescriptionIntent: false,
    relatedSourceFile: undefined,
    ...overrides,
  }
}

describe('getContextType', () => {
  it('returns "test" when the chunk is a test file', () => {
    expect(getContextType(chunk({ isTestFile: true }))).toBe('test')
  })
  it('returns "modified" when the chunk overlaps with modified lines', () => {
    expect(getContextType(chunk({ isModifiedContext: true }))).toBe('modified')
  })
  it('returns "similar" by default', () => {
    expect(getContextType(chunk())).toBe('similar')
  })
  it('prefers "test" over "modified" when both flags are set', () => {
    expect(getContextType(chunk({ isTestFile: true, isModifiedContext: true })))
      .toBe('test')
  })
})

describe('getRelevanceLevel', () => {
  it('returns "high" for modified-context chunks', () => {
    expect(getRelevanceLevel(chunk({ isModifiedContext: true }))).toBe('high')
  })
  it('returns "high" for test-file chunks', () => {
    expect(getRelevanceLevel(chunk({ isTestFile: true }))).toBe('high')
  })
  it('returns "high" for description-intent match with score > 0.7', () => {
    expect(getRelevanceLevel(chunk({ matchesDescriptionIntent: true, score: 0.8 })))
      .toBe('high')
  })
  it('returns "medium" for score > 0.5 without intent match', () => {
    expect(getRelevanceLevel(chunk({ score: 0.6 }))).toBe('medium')
  })
  it('returns "medium" for intent match with low score', () => {
    expect(getRelevanceLevel(chunk({ matchesDescriptionIntent: true, score: 0.3 })))
      .toBe('medium')
  })
  it('returns "low" for score <= 0.5 and no intent match', () => {
    expect(getRelevanceLevel(chunk({ score: 0.4 }))).toBe('low')
  })
})

describe('getRetrievalReason', () => {
  it('mentions modified-lines overlap', () => {
    expect(getRetrievalReason(chunk({ isModifiedContext: true })))
      .toContain('overlaps with modified lines')
  })
  it('mentions related-source for test files with relatedSourceFile', () => {
    expect(getRetrievalReason(chunk({
      isTestFile: true,
      relatedSourceFile: 'src/foo.ts',
    }))).toContain('test file for src/foo.ts')
  })
  it('falls back to "related test file" when relatedSourceFile is absent', () => {
    expect(getRetrievalReason(chunk({ isTestFile: true })))
      .toContain('related test file')
  })
  it('mentions description-intent match', () => {
    expect(getRetrievalReason(chunk({ matchesDescriptionIntent: true })))
      .toContain('PR/MR description intent')
  })
  it('falls back to "semantically similar" when no signals apply', () => {
    expect(getRetrievalReason(chunk())).toBe('semantically similar to changes')
  })
  it('joins multiple reasons with semicolons', () => {
    const r = getRetrievalReason(chunk({
      isModifiedContext: true,
      matchesDescriptionIntent: true,
    }))
    expect(r.split(';').length).toBeGreaterThanOrEqual(2)
  })
})

describe('formatChunkAsXml — escaping', () => {
  it('escapes < > & in code body', () => {
    const out = formatChunkAsXml(chunk({ code: 'a < b && c > d' }))
    expect(out).toContain('a &lt; b &amp;&amp; c &gt; d')
  })
  it('escapes a fake </context> closer inside the code body', () => {
    const out = formatChunkAsXml(chunk({ code: 'malicious </context> payload' }))
    // The escaped form ensures the model sees the closing tag as data.
    expect(out).toContain('&lt;/context&gt;')
    // And the only real </context> closer must be the one we emit.
    expect(out.match(/<\/context>/g)).toHaveLength(1)
  })
  it('escapes XML metacharacters in path attribute', () => {
    const out = formatChunkAsXml(chunk({ filename: 'src/file"with quotes.ts' }))
    expect(out).toContain('path="src/file&quot;with quotes.ts"')
  })
  it('includes score attribute formatted to 3 decimal places', () => {
    // formatChunkAsXml uses toFixed(3) internally
    const out = formatChunkAsXml(chunk({ originalScore: 0.876 }))
    expect(out).toContain('score="0.876"')
  })
  it('omits score attribute when originalScore is undefined', () => {
    const out = formatChunkAsXml(chunk({ originalScore: undefined as unknown as number }))
    expect(out).not.toContain('score=')
  })
})

describe('formatContextAsXml — section ordering and sort', () => {
  it('returns empty string for empty chunk list', () => {
    expect(formatContextAsXml([])).toBe('')
  })
  it('emits sections in priority order (modified, test, definition, similar, config, import)', () => {
    const out = formatContextAsXml([
      chunk({ isTestFile: false, score: 0.4 }),                      // similar
      chunk({ isModifiedContext: true, score: 0.5 }),                // modified
      chunk({ isTestFile: true, score: 0.6 }),                       // test
    ])
    const modIdx = out.indexOf('<modified>')
    const testIdx = out.indexOf('<test>')
    const similarIdx = out.indexOf('<similar>')
    expect(modIdx).toBeLessThan(testIdx)
    expect(testIdx).toBeLessThan(similarIdx)
  })
  it('sorts chunks within a section by descending score', () => {
    const out = formatContextAsXml([
      chunk({ filename: 'low.ts',  score: 0.3 }),
      chunk({ filename: 'high.ts', score: 0.9 }),
      chunk({ filename: 'mid.ts',  score: 0.6 }),
    ])
    const highIdx = out.indexOf('path="high.ts"')
    const midIdx  = out.indexOf('path="mid.ts"')
    const lowIdx  = out.indexOf('path="low.ts"')
    expect(highIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(lowIdx)
  })
})

describe('formatImpactAsXml', () => {
  function impactResult(overrides: Partial<ImpactAnalysisResult> = {}): ImpactAnalysisResult {
    return {
      warnings: [],
      importTrees: new Map(),
      hubFiles: [],
      circularDependencies: [],
      ...overrides,
    }
  }

  it('returns empty string when no warnings and no meaningful trees', () => {
    expect(formatImpactAsXml(impactResult())).toBe('')
  })
  it('emits an <impact> section when a warning is present', () => {
    const out = formatImpactAsXml(impactResult({
      warnings: [{
        type: 'hub_file',
        severity: 'high',
        filePath: 'src/utils/helpers.ts',
        message: 'Imported by many files',
        details: { affectedFiles: ['a.ts', 'b.ts'] },
      }],
    }))
    expect(out).toMatch(/^<impact>/)
    expect(out).toMatch(/<\/impact>$/)
    expect(out).toContain('type="hub_file"')
    expect(out).toContain('<file>a.ts</file>')
  })
  it('escapes XML metacharacters in cycle paths', () => {
    const out = formatImpactAsXml(impactResult({
      warnings: [{
        type: 'circular_dependency',
        severity: 'medium',
        filePath: 'src/a.ts',
        message: 'cycle',
        details: { cycle: ['src/a<x>.ts', 'src/b.ts'] },
      }],
    }))
    expect(out).toContain('src/a&lt;x&gt;.ts')
  })
})
