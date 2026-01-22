import { describe, it, expect } from 'vitest'
import {
  diversifyResults,
  diversifyPipelineResults,
  computeChunkSimilarity,
  classifyChunkCategory,
  getDefaultDiversificationConfig,
  DEFAULT_DIVERSITY_FACTOR,
  MAX_CHUNKS_PER_FILE,
  MIN_RESULTS_PER_CATEGORY,
} from '../diversification.js'
import type { WeightedCodeChunk } from '../types.js'
import type { PipelineResult, RetrievalSource } from '../pipeline.js'

// Helper to create a test chunk
function createChunk(
  filename: string,
  startLine: number,
  endLine: number,
  code: string,
  score: number,
  options: Partial<WeightedCodeChunk> = {}
): WeightedCodeChunk {
  return {
    filename,
    startLine,
    endLine,
    code,
    score,
    originalScore: score,
    weightMultiplier: 1.0,
    isModifiedContext: false,
    isTestFile: false,
    ...options,
  }
}

// Helper to create a pipeline result
function createPipelineResult(
  filename: string,
  startLine: number,
  endLine: number,
  code: string,
  score: number,
  sources: RetrievalSource[] = ['vector']
): PipelineResult {
  return {
    chunk: {
      filename,
      startLine,
      endLine,
      code,
      score,
    },
    sources,
    baseScore: score,
    weightedScore: score,
    isExactMatch: false,
  }
}

describe('diversification config', () => {
  it('returns correct default configuration', () => {
    const config = getDefaultDiversificationConfig()

    expect(config.diversityFactor).toBe(DEFAULT_DIVERSITY_FACTOR)
    expect(config.maxChunksPerFile).toBe(MAX_CHUNKS_PER_FILE)
    expect(config.minResultsPerCategory).toBe(MIN_RESULTS_PER_CATEGORY)
    expect(config.enforceCategories).toBe(true)
  })

  it('has correct constant values', () => {
    expect(DEFAULT_DIVERSITY_FACTOR).toBe(0.3)
    expect(MAX_CHUNKS_PER_FILE).toBe(3)
    expect(MIN_RESULTS_PER_CATEGORY).toBe(2)
  })
})

describe('classifyChunkCategory', () => {
  it('classifies modified context chunks', () => {
    const chunk = createChunk('src/utils.ts', 1, 10, 'const foo = 1', 0.8, {
      isModifiedContext: true,
    })
    expect(classifyChunkCategory(chunk)).toBe('modified')
  })

  it('classifies test file chunks', () => {
    const chunk = createChunk('src/utils.test.ts', 1, 10, 'describe("test")', 0.8, {
      isTestFile: true,
    })
    expect(classifyChunkCategory(chunk)).toBe('test')
  })

  it('classifies type definition chunks from sources', () => {
    const chunk = createChunk('src/types.ts', 1, 10, 'type Foo = string', 0.8)
    const sources: RetrievalSource[] = ['definition']
    expect(classifyChunkCategory(chunk, sources)).toBe('type_definition')
  })

  it('classifies type definition chunks from content', () => {
    const chunk = createChunk('src/types.ts', 1, 10, 'interface User { name: string }', 0.8)
    expect(classifyChunkCategory(chunk)).toBe('type_definition')
  })

  it('classifies class definitions as type definitions', () => {
    const chunk = createChunk('src/models.ts', 1, 10, 'class UserService { }', 0.8)
    expect(classifyChunkCategory(chunk)).toBe('type_definition')
  })

  it('classifies regular code as similar', () => {
    const chunk = createChunk('src/utils.ts', 1, 10, 'const result = process(data)', 0.8)
    expect(classifyChunkCategory(chunk)).toBe('similar')
  })

  it('prioritizes modified over other categories', () => {
    const chunk = createChunk('src/types.test.ts', 1, 10, 'interface Test {}', 0.8, {
      isModifiedContext: true,
      isTestFile: true,
    })
    expect(classifyChunkCategory(chunk)).toBe('modified')
  })

  it('prioritizes test over type_definition', () => {
    const chunk = createChunk('src/types.test.ts', 1, 10, 'interface Test {}', 0.8, {
      isTestFile: true,
    })
    expect(classifyChunkCategory(chunk)).toBe('test')
  })
})

describe('computeChunkSimilarity', () => {
  it('returns 1.0 for identical chunks', () => {
    const chunk = createChunk('src/utils.ts', 1, 10, 'const foo = bar', 0.8)
    expect(computeChunkSimilarity(chunk, chunk)).toBeCloseTo(1.0, 1)
  })

  it('returns high similarity for same file, different lines', () => {
    const a = createChunk('src/utils.ts', 1, 10, 'function process(data) {}', 0.8)
    const b = createChunk('src/utils.ts', 20, 30, 'function process(items) {}', 0.8)
    const similarity = computeChunkSimilarity(a, b)

    // Should be somewhat similar due to same file and similar code
    expect(similarity).toBeGreaterThan(0.5)
  })

  it('returns moderate similarity for same directory, different files', () => {
    const a = createChunk('src/utils/helpers.ts', 1, 10, 'export function foo() {}', 0.8)
    const b = createChunk('src/utils/formatters.ts', 1, 10, 'export function bar() {}', 0.8)
    const similarity = computeChunkSimilarity(a, b)

    // Moderate similarity due to same directory
    expect(similarity).toBeGreaterThan(0.2)
    expect(similarity).toBeLessThan(0.8)
  })

  it('returns low similarity for different directories and different code', () => {
    const a = createChunk('src/api/routes.ts', 1, 10, 'app.get("/users")', 0.8)
    const b = createChunk('tests/utils/helpers.ts', 1, 10, 'describe("test")', 0.8)
    const similarity = computeChunkSimilarity(a, b)

    // Low similarity due to different directories and different code
    expect(similarity).toBeLessThan(0.5)
  })

  it('handles overlapping line ranges in same file', () => {
    const a = createChunk('src/utils.ts', 1, 10, 'const foo = 1', 0.8)
    const b = createChunk('src/utils.ts', 5, 15, 'const foo = 2', 0.8)
    const similarity = computeChunkSimilarity(a, b)

    // High similarity due to overlapping lines in same file
    expect(similarity).toBeGreaterThan(0.6)
  })
})

describe('diversifyResults', () => {
  it('returns empty result for empty input', () => {
    const result = diversifyResults([], 10)

    expect(result.results).toHaveLength(0)
    expect(result.metrics.inputCount).toBe(0)
    expect(result.metrics.outputCount).toBe(0)
  })

  it('limits results per file to maxChunksPerFile', () => {
    // Create 5 chunks from the same file
    const chunks = [
      createChunk('src/utils.ts', 1, 10, 'code 1', 0.9),
      createChunk('src/utils.ts', 11, 20, 'code 2', 0.85),
      createChunk('src/utils.ts', 21, 30, 'code 3', 0.8),
      createChunk('src/utils.ts', 31, 40, 'code 4', 0.75),
      createChunk('src/utils.ts', 41, 50, 'code 5', 0.7),
    ]

    const result = diversifyResults(chunks, 10, { maxChunksPerFile: 3 })

    // Should only have 3 chunks from this file
    const fileChunks = result.results.filter(c => c.filename === 'src/utils.ts')
    expect(fileChunks.length).toBeLessThanOrEqual(3)
    expect(result.metrics.removedByFileLimit).toBe(2)
  })

  it('keeps highest scoring chunks per file', () => {
    const chunks = [
      createChunk('src/utils.ts', 1, 10, 'code 1', 0.5),
      createChunk('src/utils.ts', 11, 20, 'code 2', 0.9),
      createChunk('src/utils.ts', 21, 30, 'code 3', 0.7),
      createChunk('src/utils.ts', 31, 40, 'code 4', 0.6),
      createChunk('src/utils.ts', 41, 50, 'code 5', 0.8),
    ]

    const result = diversifyResults(chunks, 10, { maxChunksPerFile: 3 })

    // Should keep the top 3 scores: 0.9, 0.8, 0.7
    const scores = result.results.map(c => c.originalScore).sort((a, b) => b - a)
    expect(scores).toContain(0.9)
    expect(scores).toContain(0.8)
    expect(scores).toContain(0.7)
  })

  it('applies MMR to increase diversity', () => {
    // Create similar chunks that should be diversified
    const chunks = [
      createChunk('src/utils.ts', 1, 10, 'function processUser(user) { return user.name }', 0.95),
      createChunk('src/utils.ts', 11, 20, 'function processUser(data) { return data.name }', 0.9),
      createChunk('src/api/routes.ts', 1, 10, 'app.get("/users", handler)', 0.85),
      createChunk('src/models/user.ts', 1, 10, 'interface User { id: string }', 0.8),
    ]

    // With pure relevance (diversity=0), would get top 3 by score
    const relevanceResult = diversifyResults(chunks, 3, { diversityFactor: 0 })

    // With high diversity, should prefer different files
    const diverseResult = diversifyResults(chunks, 3, { diversityFactor: 0.5 })

    // Both should return 3 results
    expect(relevanceResult.results).toHaveLength(3)
    expect(diverseResult.results).toHaveLength(3)

    // Diverse result should have more files represented
    const diverseFiles = new Set(diverseResult.results.map(c => c.filename))
    expect(diverseFiles.size).toBeGreaterThanOrEqual(2)
  })

  it('respects maxResults limit', () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      createChunk(`src/file${i}.ts`, 1, 10, `code ${i}`, 0.9 - i * 0.02)
    )

    const result = diversifyResults(chunks, 5)

    expect(result.results.length).toBeLessThanOrEqual(5)
  })

  it('calculates metrics correctly', () => {
    const chunks = [
      createChunk('src/utils.ts', 1, 10, 'code 1', 0.9, { isModifiedContext: true }),
      createChunk('src/utils.test.ts', 1, 10, 'test code', 0.8, { isTestFile: true }),
      createChunk('src/types.ts', 1, 10, 'interface Foo {}', 0.7),
      createChunk('src/api.ts', 1, 10, 'api code', 0.6),
    ]

    const result = diversifyResults(chunks, 10)

    expect(result.metrics.inputCount).toBe(4)
    expect(result.metrics.filesRepresented).toBe(4)
    expect(result.metrics.categoryBreakdown.modified).toBeGreaterThanOrEqual(1)
    expect(result.metrics.categoryBreakdown.test).toBeGreaterThanOrEqual(1)
    expect(result.metrics.categoryBreakdown.type_definition).toBeGreaterThanOrEqual(1)
  })

  it('maintains category representation', () => {
    // Create chunks with different categories
    const chunks = [
      // Many similar chunks (should be limited)
      createChunk('src/utils1.ts', 1, 10, 'similar code 1', 0.95),
      createChunk('src/utils2.ts', 1, 10, 'similar code 2', 0.94),
      createChunk('src/utils3.ts', 1, 10, 'similar code 3', 0.93),
      createChunk('src/utils4.ts', 1, 10, 'similar code 4', 0.92),
      createChunk('src/utils5.ts', 1, 10, 'similar code 5', 0.91),
      // One test file (lower score but should be included)
      createChunk('tests/utils.test.ts', 1, 10, 'describe("test")', 0.7, { isTestFile: true }),
      // One modified context (lower score but should be included)
      createChunk('src/modified.ts', 1, 10, 'changed code', 0.6, { isModifiedContext: true }),
    ]

    const result = diversifyResults(chunks, 7, {
      enforceCategories: true,
      minResultsPerCategory: 1,
    })

    // Should include test and modified even if they have lower scores
    // Note: With maxResults=7 and 7 chunks, all should be included
    expect(result.metrics.categoryBreakdown.test).toBeGreaterThanOrEqual(1)
    expect(result.metrics.categoryBreakdown.modified).toBeGreaterThanOrEqual(1)
  })

  it('computes average similarity metric', () => {
    const chunks = [
      createChunk('src/a.ts', 1, 10, 'unique code for a', 0.9),
      createChunk('src/b.ts', 1, 10, 'totally different b', 0.85),
      createChunk('src/c.ts', 1, 10, 'something else c', 0.8),
    ]

    const result = diversifyResults(chunks, 10)

    // Average similarity should be computed and be a reasonable value
    expect(result.metrics.averageSimilarity).toBeGreaterThanOrEqual(0)
    expect(result.metrics.averageSimilarity).toBeLessThanOrEqual(1)
  })
})

describe('diversifyPipelineResults', () => {
  it('converts pipeline results to chunks and diversifies', () => {
    const pipelineResults: PipelineResult[] = [
      createPipelineResult('src/utils.ts', 1, 10, 'code 1', 0.9),
      createPipelineResult('src/api.ts', 1, 10, 'code 2', 0.85),
      createPipelineResult('tests/utils.test.ts', 1, 10, 'test code', 0.8),
    ]

    const result = diversifyPipelineResults(pipelineResults, 10)

    expect(result.results).toHaveLength(3)
    expect(result.metrics.inputCount).toBe(3)
  })

  it('respects retrieval sources for category classification', () => {
    const pipelineResults: PipelineResult[] = [
      createPipelineResult('src/types.ts', 1, 10, 'interface User { name: string }', 0.9, ['definition']),
      createPipelineResult('src/utils.ts', 1, 10, 'function helper() {}', 0.85, ['vector']),
    ]

    const result = diversifyPipelineResults(pipelineResults, 10)

    // The definition source with type-like content should classify as type_definition
    // Note: The classifyChunkCategory checks both sources and content
    expect(result.metrics.categoryBreakdown.type_definition).toBeGreaterThanOrEqual(1)
  })

  it('handles test files correctly', () => {
    const pipelineResults: PipelineResult[] = [
      createPipelineResult('src/utils.ts', 1, 10, 'code', 0.9),
      createPipelineResult('src/__tests__/utils.test.ts', 1, 10, 'test', 0.8),
      createPipelineResult('src/utils.spec.ts', 1, 10, 'spec', 0.75),
    ]

    const result = diversifyPipelineResults(pipelineResults, 10)

    // Should recognize test files
    expect(result.metrics.categoryBreakdown.test).toBeGreaterThanOrEqual(2)
  })

  it('applies maxChunksPerFile limit', () => {
    const pipelineResults: PipelineResult[] = [
      createPipelineResult('src/utils.ts', 1, 10, 'code 1', 0.95),
      createPipelineResult('src/utils.ts', 11, 20, 'code 2', 0.9),
      createPipelineResult('src/utils.ts', 21, 30, 'code 3', 0.85),
      createPipelineResult('src/utils.ts', 31, 40, 'code 4', 0.8),
      createPipelineResult('src/utils.ts', 41, 50, 'code 5', 0.75),
    ]

    const result = diversifyPipelineResults(pipelineResults, 10, { maxChunksPerFile: 3 })

    expect(result.results.length).toBeLessThanOrEqual(3)
    expect(result.metrics.removedByFileLimit).toBe(2)
  })
})

describe('edge cases', () => {
  it('handles single chunk input', () => {
    const chunks = [createChunk('src/utils.ts', 1, 10, 'code', 0.9)]
    const result = diversifyResults(chunks, 10)

    expect(result.results).toHaveLength(1)
    expect(result.metrics.averageSimilarity).toBe(0)
  })

  it('handles maxResults greater than input', () => {
    const chunks = [
      createChunk('src/a.ts', 1, 10, 'code a', 0.9),
      createChunk('src/b.ts', 1, 10, 'code b', 0.8),
    ]

    const result = diversifyResults(chunks, 100)

    expect(result.results).toHaveLength(2)
  })

  it('handles all same category', () => {
    const chunks = [
      createChunk('src/a.ts', 1, 10, 'code a', 0.9),
      createChunk('src/b.ts', 1, 10, 'code b', 0.8),
      createChunk('src/c.ts', 1, 10, 'code c', 0.7),
    ]

    const result = diversifyResults(chunks, 10, {
      enforceCategories: true,
      minResultsPerCategory: 2,
    })

    // Should still work even if we can't meet minResultsPerCategory for all categories
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.metrics.categoryBreakdown.similar).toBe(3)
  })

  it('handles diversity factor extremes', () => {
    const chunks = [
      createChunk('src/utils.ts', 1, 10, 'function foo() {}', 0.9),
      createChunk('src/utils.ts', 11, 20, 'function bar() {}', 0.85),
      createChunk('src/api.ts', 1, 10, 'app.get("/")', 0.8),
    ]

    // Pure relevance (diversity = 0)
    const relevanceResult = diversifyResults(chunks, 2, { diversityFactor: 0 })
    expect(relevanceResult.results).toHaveLength(2)

    // Max diversity (diversity = 1)
    const diverseResult = diversifyResults(chunks, 2, { diversityFactor: 1 })
    expect(diverseResult.results).toHaveLength(2)
  })

  it('handles chunks with very long code', () => {
    const longCode = 'x'.repeat(10000)
    const chunks = [
      createChunk('src/a.ts', 1, 100, longCode, 0.9),
      createChunk('src/b.ts', 1, 100, longCode + 'y', 0.8),
    ]

    // Should not throw and should complete
    const result = diversifyResults(chunks, 10)
    expect(result.results.length).toBeGreaterThan(0)
  })
})
