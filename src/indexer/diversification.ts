/**
 * Result diversification module for semantic code context retrieval.
 *
 * Implements Maximal Marginal Relevance (MMR) to balance relevance and diversity
 * in search results. This ensures the LLM sees different aspects of the codebase
 * rather than redundant similar chunks.
 *
 * Key features:
 * - MMR algorithm for diversity-aware re-ranking
 * - Per-file chunk limiting (max 3 per file)
 * - Category representation guarantees (modified, test, types, similar)
 * - Configurable diversity factor (0 = pure relevance, 1 = max diversity)
 */

import type { WeightedCodeChunk } from './types.js'
import type { PipelineResult, RetrievalSource } from './pipeline.js'
import { logger } from '../utils/logger.js'

// =============================================================================
// Configuration Constants
// =============================================================================

/**
 * Maximum number of chunks to include per file.
 * Prevents any single file from dominating the context.
 */
export const MAX_CHUNKS_PER_FILE = 3

/**
 * Default diversity factor for MMR.
 * 0 = pure relevance ranking (no diversity)
 * 1 = maximum diversity (may sacrifice relevance)
 * 0.3 = balanced (30% diversity, 70% relevance)
 */
export const DEFAULT_DIVERSITY_FACTOR = 0.3

/**
 * Minimum number of results to guarantee per category.
 * Ensures representation from each context type.
 */
export const MIN_RESULTS_PER_CATEGORY = 2

/**
 * Categories of context for representation guarantees.
 */
export type ContextCategory = 'modified' | 'test' | 'type_definition' | 'similar'

// =============================================================================
// Diversification Types
// =============================================================================

/**
 * Configuration for result diversification.
 */
export interface DiversificationConfig {
  /**
   * Diversity factor (lambda) for MMR algorithm.
   * 0 = pure relevance, 1 = max diversity, default 0.3
   */
  diversityFactor: number

  /**
   * Maximum chunks to include per file.
   * Default: 3
   */
  maxChunksPerFile: number

  /**
   * Minimum results to guarantee per category.
   * Default: 2
   */
  minResultsPerCategory: number

  /**
   * Whether to enforce category representation.
   * When true, ensures minimum results from each category.
   * Default: true
   */
  enforceCategories: boolean
}

/**
 * Result of diversification including metrics.
 */
export interface DiversificationResult {
  /** Diversified results */
  results: WeightedCodeChunk[]

  /** Metrics about the diversification process */
  metrics: DiversificationMetrics
}

/**
 * Metrics from the diversification process.
 */
export interface DiversificationMetrics {
  /** Number of results before diversification */
  inputCount: number

  /** Number of results after diversification */
  outputCount: number

  /** Number of results removed due to per-file limit */
  removedByFileLimit: number

  /** Number of results removed by MMR */
  removedByMmr: number

  /** Results by category */
  categoryBreakdown: Record<ContextCategory, number>

  /** Files represented in results */
  filesRepresented: number

  /** Average similarity between consecutive results (lower = more diverse) */
  averageSimilarity: number
}

/**
 * Internal structure for tracking chunk with category info.
 */
interface CategorizedChunk {
  chunk: WeightedCodeChunk
  category: ContextCategory
  embedding?: number[]  // Cached for similarity computation
}

// =============================================================================
// Category Classification
// =============================================================================

/**
 * Classify a chunk into a context category.
 */
export function classifyChunkCategory(
  chunk: WeightedCodeChunk,
  sources?: RetrievalSource[]
): ContextCategory {
  // Modified context takes highest priority
  if (chunk.isModifiedContext) {
    return 'modified'
  }

  // Test files
  if (chunk.isTestFile) {
    return 'test'
  }

  // Type definitions (from definition lookups or containing type keywords)
  if (sources?.includes('definition')) {
    return 'type_definition'
  }

  // Check content for type-like patterns
  const code = chunk.code.toLowerCase()
  const isTypeLike =
    code.includes('interface ') ||
    code.includes('type ') ||
    code.includes('class ') ||
    code.includes('struct ') ||
    code.includes('enum ') ||
    code.includes('typedef ')

  if (isTypeLike && !chunk.isModifiedContext && !chunk.isTestFile) {
    return 'type_definition'
  }

  // Everything else is similar code
  return 'similar'
}

// =============================================================================
// Similarity Computation
// =============================================================================

/**
 * Compute text-based similarity between two code chunks.
 * Uses Jaccard similarity on normalized tokens.
 */
function computeTextSimilarity(a: string, b: string): number {
  // Normalize and tokenize
  const normalize = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
    return new Set(tokens)
  }

  const tokensA = normalize(a)
  const tokensB = normalize(b)

  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0
  }

  // Jaccard similarity
  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++
    }
  }

  const union = tokensA.size + tokensB.size - intersection
  return intersection / union
}

/**
 * Compute file-path similarity between two chunks.
 * Chunks in the same directory or with similar names are more similar.
 */
function computePathSimilarity(a: string, b: string): number {
  // Same file = maximum similarity
  if (a === b) {
    return 1.0
  }

  const partsA = a.split('/')
  const partsB = b.split('/')

  // Same directory = high similarity
  const dirA = partsA.slice(0, -1).join('/')
  const dirB = partsB.slice(0, -1).join('/')

  if (dirA === dirB && dirA.length > 0) {
    return 0.7
  }

  // Count common path segments
  let commonPrefixLength = 0
  for (let i = 0; i < Math.min(partsA.length, partsB.length) - 1; i++) {
    if (partsA[i] === partsB[i]) {
      commonPrefixLength++
    } else {
      break
    }
  }

  if (commonPrefixLength > 0) {
    return 0.3 + (commonPrefixLength / Math.max(partsA.length, partsB.length)) * 0.3
  }

  return 0
}

/**
 * Compute combined similarity between two chunks.
 * Combines text similarity, path similarity, and line overlap.
 */
export function computeChunkSimilarity(
  a: WeightedCodeChunk,
  b: WeightedCodeChunk
): number {
  // Text similarity (40% weight)
  const textSim = computeTextSimilarity(a.code, b.code)

  // Path similarity (40% weight)
  const pathSim = computePathSimilarity(a.filename, b.filename)

  // Line overlap similarity for same file (20% weight)
  let lineOverlapSim = 0
  if (a.filename === b.filename) {
    const overlapStart = Math.max(a.startLine, b.startLine)
    const overlapEnd = Math.min(a.endLine, b.endLine)
    const overlap = Math.max(0, overlapEnd - overlapStart + 1)
    const totalLines = Math.max(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1)
    lineOverlapSim = overlap / totalLines
  }

  return textSim * 0.4 + pathSim * 0.4 + lineOverlapSim * 0.2
}

/**
 * Compute maximum similarity between a candidate and a set of selected chunks.
 */
function maxSimilarityToSelected(
  candidate: WeightedCodeChunk,
  selected: WeightedCodeChunk[]
): number {
  if (selected.length === 0) {
    return 0
  }

  let maxSim = 0
  for (const s of selected) {
    const sim = computeChunkSimilarity(candidate, s)
    if (sim > maxSim) {
      maxSim = sim
    }
  }
  return maxSim
}

// =============================================================================
// MMR Algorithm
// =============================================================================

/**
 * Compute MMR score for a candidate chunk.
 *
 * MMR score = λ * relevance - (1 - λ) * maxSim(candidate, selected)
 *
 * Where:
 * - λ (lambda) is the diversity factor (0 = pure diversity, 1 = pure relevance)
 * - relevance is the chunk's weighted score
 * - maxSim is the maximum similarity to any already-selected chunk
 */
function computeMmrScore(
  candidate: WeightedCodeChunk,
  selected: WeightedCodeChunk[],
  lambda: number
): number {
  const relevance = candidate.score
  const maxSim = maxSimilarityToSelected(candidate, selected)

  // Note: lambda = 1 means pure relevance, lambda = 0 means pure diversity
  // We use (1 - lambda) for diversity factor so higher lambda = more relevance
  return lambda * relevance - (1 - lambda) * maxSim
}

/**
 * Select top-k diverse results using MMR algorithm.
 */
function selectByMmr(
  candidates: WeightedCodeChunk[],
  maxResults: number,
  lambda: number
): WeightedCodeChunk[] {
  if (candidates.length === 0) {
    return []
  }

  const selected: WeightedCodeChunk[] = []
  const remaining = [...candidates]

  // First selection: highest relevance score
  remaining.sort((a, b) => b.score - a.score)
  selected.push(remaining.shift()!)

  // Iteratively select using MMR
  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = 0
    let bestMmrScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const mmrScore = computeMmrScore(remaining[i], selected, lambda)
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
  }

  return selected
}

// =============================================================================
// Per-File Limiting
// =============================================================================

/**
 * Apply per-file chunk limit to results.
 * Keeps the highest-scoring chunks per file.
 */
function applyPerFileLimit(
  chunks: WeightedCodeChunk[],
  maxPerFile: number
): { limited: WeightedCodeChunk[]; removedCount: number } {
  const byFile = new Map<string, WeightedCodeChunk[]>()

  // Group by file
  for (const chunk of chunks) {
    const existing = byFile.get(chunk.filename) || []
    existing.push(chunk)
    byFile.set(chunk.filename, existing)
  }

  // Keep top N per file
  const limited: WeightedCodeChunk[] = []
  let removedCount = 0

  for (const [filename, fileChunks] of byFile) {
    // Sort by score descending
    fileChunks.sort((a, b) => b.score - a.score)

    // Take top N
    const kept = fileChunks.slice(0, maxPerFile)
    limited.push(...kept)

    const removed = fileChunks.length - kept.length
    if (removed > 0) {
      logger.debug(`File limit: removed ${removed} chunks from ${filename}`)
      removedCount += removed
    }
  }

  return { limited, removedCount }
}

// =============================================================================
// Category Representation
// =============================================================================

/**
 * Ensure minimum representation from each category.
 * Adds chunks from under-represented categories.
 */
function ensureCategoryRepresentation(
  selected: CategorizedChunk[],
  allCandidates: CategorizedChunk[],
  minPerCategory: number,
  maxTotal: number
): CategorizedChunk[] {
  const result = [...selected]
  const selectedIds = new Set(result.map(c => getChunkId(c.chunk)))

  // Count current category representation
  const categoryCounts = new Map<ContextCategory, number>()
  for (const cat of ['modified', 'test', 'type_definition', 'similar'] as ContextCategory[]) {
    categoryCounts.set(cat, 0)
  }
  for (const c of result) {
    categoryCounts.set(c.category, (categoryCounts.get(c.category) || 0) + 1)
  }

  // Group candidates by category
  const byCategory = new Map<ContextCategory, CategorizedChunk[]>()
  for (const c of allCandidates) {
    const existing = byCategory.get(c.category) || []
    existing.push(c)
    byCategory.set(c.category, existing)
  }

  // Add missing representation
  for (const [category, count] of categoryCounts) {
    if (count < minPerCategory && result.length < maxTotal) {
      const available = (byCategory.get(category) || [])
        .filter(c => !selectedIds.has(getChunkId(c.chunk)))
        .sort((a, b) => b.chunk.score - a.chunk.score)

      const needed = Math.min(
        minPerCategory - count,
        maxTotal - result.length,
        available.length
      )

      for (let i = 0; i < needed; i++) {
        result.push(available[i])
        selectedIds.add(getChunkId(available[i].chunk))
        logger.debug(`Category representation: added ${category} chunk`)
      }
    }
  }

  return result
}

/**
 * Generate unique ID for a chunk.
 */
function getChunkId(chunk: WeightedCodeChunk): string {
  return `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
}

// =============================================================================
// Main Diversification Function
// =============================================================================

/**
 * Default diversification configuration.
 */
export function getDefaultDiversificationConfig(): DiversificationConfig {
  return {
    diversityFactor: DEFAULT_DIVERSITY_FACTOR,
    maxChunksPerFile: MAX_CHUNKS_PER_FILE,
    minResultsPerCategory: MIN_RESULTS_PER_CATEGORY,
    enforceCategories: true,
  }
}

/**
 * Diversify search results to ensure variety in the context.
 *
 * This function:
 * 1. Applies per-file chunk limiting (max 3 per file)
 * 2. Uses MMR to select diverse results
 * 3. Ensures representation from each category
 *
 * @param chunks - Input chunks to diversify
 * @param maxResults - Maximum number of results to return
 * @param config - Diversification configuration
 * @param sources - Optional retrieval sources for category classification
 * @returns Diversified results with metrics
 */
export function diversifyResults(
  chunks: WeightedCodeChunk[],
  maxResults: number,
  config: Partial<DiversificationConfig> = {},
  sourcesByChunkId?: Map<string, RetrievalSource[]>
): DiversificationResult {
  const fullConfig: DiversificationConfig = {
    ...getDefaultDiversificationConfig(),
    ...config,
  }

  const inputCount = chunks.length

  if (chunks.length === 0) {
    return {
      results: [],
      metrics: {
        inputCount: 0,
        outputCount: 0,
        removedByFileLimit: 0,
        removedByMmr: 0,
        categoryBreakdown: { modified: 0, test: 0, type_definition: 0, similar: 0 },
        filesRepresented: 0,
        averageSimilarity: 0,
      },
    }
  }

  // Step 1: Apply per-file limit
  const { limited, removedCount: removedByFileLimit } = applyPerFileLimit(
    chunks,
    fullConfig.maxChunksPerFile
  )

  // Step 2: Categorize chunks
  const categorized: CategorizedChunk[] = limited.map(chunk => {
    const id = getChunkId(chunk)
    const sources = sourcesByChunkId?.get(id)
    return {
      chunk,
      category: classifyChunkCategory(chunk, sources),
    }
  })

  // Step 3: Apply MMR for diversity
  const mmrSelected = selectByMmr(
    categorized.map(c => c.chunk),
    maxResults,
    1 - fullConfig.diversityFactor  // Convert diversity factor to lambda
  )

  // Step 4: Map MMR results back to categorized chunks
  const selectedIds = new Set(mmrSelected.map(getChunkId))
  let selected = categorized.filter(c => selectedIds.has(getChunkId(c.chunk)))

  // Step 5: Ensure category representation (if enabled)
  if (fullConfig.enforceCategories) {
    selected = ensureCategoryRepresentation(
      selected,
      categorized,
      fullConfig.minResultsPerCategory,
      maxResults
    )
  }

  // Extract final results and compute metrics
  const results = selected.map(c => c.chunk)

  // Compute category breakdown
  const categoryBreakdown: Record<ContextCategory, number> = {
    modified: 0,
    test: 0,
    type_definition: 0,
    similar: 0,
  }
  for (const c of selected) {
    categoryBreakdown[c.category]++
  }

  // Compute files represented
  const filesRepresented = new Set(results.map(c => c.filename)).size

  // Compute average similarity between consecutive results
  let totalSimilarity = 0
  let comparisons = 0
  for (let i = 1; i < results.length; i++) {
    totalSimilarity += computeChunkSimilarity(results[i - 1], results[i])
    comparisons++
  }
  const averageSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 0

  // Calculate removed by MMR
  const removedByMmr = limited.length - results.length

  // Sort final results by score (descending) for consistent output
  results.sort((a, b) => b.score - a.score)

  logger.debug(
    `Diversification: ${inputCount} -> ${results.length} results ` +
    `(${removedByFileLimit} by file limit, ${removedByMmr} by MMR, ` +
    `${filesRepresented} files, avgSim=${averageSimilarity.toFixed(3)})`
  )

  return {
    results,
    metrics: {
      inputCount,
      outputCount: results.length,
      removedByFileLimit,
      removedByMmr,
      categoryBreakdown,
      filesRepresented,
      averageSimilarity,
    },
  }
}

/**
 * Diversify pipeline results directly.
 *
 * Convenience function that handles conversion from PipelineResult to WeightedCodeChunk.
 */
export function diversifyPipelineResults(
  pipelineResults: PipelineResult[],
  maxResults: number,
  config: Partial<DiversificationConfig> = {}
): DiversificationResult {
  // Build sources map
  const sourcesByChunkId = new Map<string, RetrievalSource[]>()

  // Convert to weighted chunks
  const chunks: WeightedCodeChunk[] = pipelineResults.map(pr => {
    const id = `${pr.chunk.filename}:${pr.chunk.startLine}-${pr.chunk.endLine}`
    sourcesByChunkId.set(id, pr.sources)

    // Check if this is a test file based on filename patterns
    const isTestFile =
      pr.chunk.filename.includes('.test.') ||
      pr.chunk.filename.includes('.spec.') ||
      pr.chunk.filename.includes('__tests__')

    // isModifiedContext is set for chunks that came from usage lookups
    // (not definition - definitions are type definitions, usages indicate modified context)
    const isModifiedContext = pr.sources.includes('usage')

    return {
      ...pr.chunk,
      originalScore: pr.baseScore,
      score: pr.weightedScore,
      weightMultiplier: pr.weightedScore / pr.baseScore,
      isModifiedContext,
      isTestFile,
    }
  })

  return diversifyResults(chunks, maxResults, config, sourcesByChunkId)
}
