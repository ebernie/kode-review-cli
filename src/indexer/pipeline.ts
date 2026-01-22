/**
 * Multi-stage retrieval pipeline for semantic code context.
 *
 * This module implements a progressive context retrieval strategy:
 * - Stage 1: Fast keyword search for exact matches (100ms budget)
 * - Stage 2: Vector similarity on diff content (500ms budget)
 * - Stage 3: Structural lookup via definitions/usages/callgraph (500ms budget)
 * - Stage 4: Re-rank combined results by relevance (100ms budget)
 *
 * Early termination occurs if high-confidence matches (score > 0.9) are found,
 * reducing latency for obvious matches while still providing deep context when needed.
 */

import type { IndexerClient } from './client.js'
import type {
  CodeChunk,
  WeightedCodeChunk,
  ParsedDiff,
} from './types.js'
import { logger } from '../utils/logger.js'

// =============================================================================
// Pipeline Configuration
// =============================================================================

/**
 * Time budgets for each retrieval stage in milliseconds.
 * These are soft limits - operations complete fully but won't start new queries
 * if the budget is exceeded.
 */
export const STAGE_BUDGETS = {
  /** Stage 1: Keyword search for exact identifier matches */
  KEYWORD_SEARCH: 100,
  /** Stage 2: Vector similarity search on diff content */
  VECTOR_SEARCH: 500,
  /** Stage 3: Structural lookup (definitions, usages, call graph) */
  STRUCTURAL_LOOKUP: 500,
  /** Stage 4: Re-ranking and deduplication */
  RERANK: 100,
} as const

/**
 * Score threshold for early termination.
 * If we find matches with scores above this threshold, we can skip later stages.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.9

/**
 * Maximum results to fetch per stage before combining.
 */
export const STAGE_LIMITS = {
  KEYWORD: 15,
  VECTOR: 20,
  DEFINITIONS: 10,
  USAGES: 15,
  CALLGRAPH: 10,
} as const

/**
 * Weight multipliers for different retrieval sources.
 */
export const SOURCE_WEIGHTS = {
  /** Exact keyword match (highest precision) */
  KEYWORD_EXACT: 1.5,
  /** Keyword match with high BM25 score */
  KEYWORD_HIGH: 1.2,
  /** Vector similarity match */
  VECTOR: 1.0,
  /** Definition lookup (symbol found at definition site) */
  DEFINITION: 1.3,
  /** Usage lookup (symbol usage found) */
  USAGE: 1.1,
  /** Call graph relationship */
  CALLGRAPH: 1.2,
} as const

// =============================================================================
// Pipeline Types
// =============================================================================

/**
 * Source of a retrieved code chunk, indicating which stage found it.
 */
export type RetrievalSource =
  | 'keyword'
  | 'vector'
  | 'definition'
  | 'usage'
  | 'callgraph'

/**
 * A result from the retrieval pipeline with source tracking.
 */
export interface PipelineResult {
  /** The code chunk content */
  chunk: CodeChunk
  /** Which retrieval method(s) found this chunk */
  sources: RetrievalSource[]
  /** Base relevance score (0-1) */
  baseScore: number
  /** Score after source-based weighting */
  weightedScore: number
  /** Whether this was an exact symbol match */
  isExactMatch: boolean
  /** Symbol that was matched (if applicable) */
  matchedSymbol?: string
  /** Relationship type if from callgraph */
  relationship?: 'caller' | 'callee'
}

/**
 * Metrics from a single pipeline stage execution.
 */
export interface StageMetrics {
  /** Stage name for logging */
  name: string
  /** Time spent in this stage (ms) */
  durationMs: number
  /** Number of results found */
  resultCount: number
  /** Whether the stage was skipped due to early termination */
  skipped: boolean
  /** Reason for skipping if applicable */
  skipReason?: string
}

/**
 * Configuration for the retrieval pipeline.
 */
export interface PipelineConfig {
  /** Repository URL to scope searches */
  repoUrl: string
  /** Branch to scope searches (optional) */
  branch?: string
  /** Maximum total results to return */
  maxResults: number
  /** Enable early termination on high-confidence matches */
  enableEarlyTermination: boolean
  /** Score threshold for early termination */
  earlyTerminationThreshold: number
  /** Time budgets per stage (use defaults if not specified) */
  stageBudgets?: Partial<typeof STAGE_BUDGETS>
}

/**
 * Result from the complete pipeline execution.
 */
export interface PipelineExecutionResult {
  /** Combined and ranked results */
  results: PipelineResult[]
  /** Metrics for each stage */
  stageMetrics: StageMetrics[]
  /** Total execution time (ms) */
  totalDurationMs: number
  /** Whether early termination was triggered */
  earlyTerminated: boolean
  /** Reason for early termination if applicable */
  earlyTerminationReason?: string
}

/**
 * Input queries extracted from the diff and PR description.
 */
export interface PipelineInput {
  /** Queries extracted from diff content */
  diffQueries: string[]
  /** Queries from PR description */
  descriptionQueries: string[]
  /** Symbol names found in the diff (for structural lookups) */
  symbols: string[]
  /** File paths that were modified (for callgraph) */
  modifiedFiles: string[]
  /** Parsed diff for context weighting */
  parsedDiff: ParsedDiff
}

// =============================================================================
// Pipeline Implementation
// =============================================================================

/**
 * Create a unique identifier for a code chunk for deduplication.
 */
function getChunkId(chunk: CodeChunk): string {
  return `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
}

/**
 * Stage 1: Fast keyword search for exact identifier matches.
 *
 * Uses BM25 keyword search to find exact matches for function names,
 * class names, and other identifiers. This is the fastest stage and
 * provides highest-precision results for renamed/moved symbols.
 */
async function executeKeywordStage(
  client: IndexerClient,
  input: PipelineInput,
  config: PipelineConfig,
  budget: number
): Promise<{ results: PipelineResult[]; metrics: StageMetrics }> {
  const startTime = performance.now()
  const results: PipelineResult[] = []
  const seenIds = new Set<string>()

  // Combine symbol-like queries from diff and description
  const queries = [
    ...input.symbols.slice(0, 5), // Prioritize symbols
    ...input.diffQueries.filter(q => /^\w+$/.test(q)).slice(0, 5), // Identifier-like queries
  ]

  // Execute keyword searches until budget exhausted
  for (const query of queries) {
    if (performance.now() - startTime > budget) {
      logger.debug(`Keyword stage budget exhausted after ${queries.indexOf(query)} queries`)
      break
    }

    try {
      const searchResults = await client.keywordSearch(
        query,
        config.repoUrl,
        config.branch,
        STAGE_LIMITS.KEYWORD
      )

      for (const match of searchResults.matches) {
        const chunk: CodeChunk = {
          filename: match.filePath,
          code: match.content,
          score: match.finalScore,
          startLine: match.lineStart,
          endLine: match.lineEnd,
          repoUrl: match.repoUrl,
          branch: match.branch,
        }

        const id = getChunkId(chunk)
        if (seenIds.has(id)) continue
        seenIds.add(id)

        // Determine if this is an exact symbol match
        const isExactMatch = match.exactMatchBoost > 1.0 ||
          match.symbolNames.some(s => s.toLowerCase() === query.toLowerCase())

        // Normalize score to 0-1 range (BM25 scores can vary widely)
        const normalizedScore = Math.min(1.0, match.finalScore / 10)

        const weight = isExactMatch ? SOURCE_WEIGHTS.KEYWORD_EXACT :
          normalizedScore > 0.5 ? SOURCE_WEIGHTS.KEYWORD_HIGH : 1.0

        results.push({
          chunk,
          sources: ['keyword'],
          baseScore: normalizedScore,
          weightedScore: normalizedScore * weight,
          isExactMatch,
          matchedSymbol: isExactMatch ? query : undefined,
        })
      }
    } catch (error) {
      logger.debug(`Keyword search failed for "${query}": ${error}`)
    }
  }

  const durationMs = performance.now() - startTime
  return {
    results,
    metrics: {
      name: 'keyword',
      durationMs,
      resultCount: results.length,
      skipped: false,
    },
  }
}

/**
 * Stage 2: Vector similarity search on diff content.
 *
 * Uses semantic embeddings to find conceptually similar code,
 * catching related functionality that may not share exact identifiers.
 */
async function executeVectorStage(
  client: IndexerClient,
  input: PipelineInput,
  config: PipelineConfig,
  budget: number,
  existingIds: Set<string>
): Promise<{ results: PipelineResult[]; metrics: StageMetrics }> {
  const startTime = performance.now()
  const results: PipelineResult[] = []

  // Use a mix of short identifier queries and longer semantic queries
  const queries = [
    ...input.diffQueries.slice(0, 8),
    ...input.descriptionQueries.slice(0, 4),
  ]

  for (const query of queries) {
    if (performance.now() - startTime > budget) {
      logger.debug(`Vector stage budget exhausted after ${queries.indexOf(query)} queries`)
      break
    }

    try {
      // Use hybrid search for better recall
      const searchResults = await client.hybridSearch(
        query,
        config.repoUrl,
        config.branch,
        STAGE_LIMITS.VECTOR
      )

      for (const match of searchResults.matches) {
        const chunk: CodeChunk = {
          filename: match.filePath,
          code: match.content,
          score: match.rrfScore,
          startLine: match.lineStart,
          endLine: match.lineEnd,
          repoUrl: match.repoUrl,
          branch: match.branch,
        }

        const id = getChunkId(chunk)
        if (existingIds.has(id)) continue
        existingIds.add(id)

        // Vector score is already 0-1 range
        const baseScore = match.vectorScore

        results.push({
          chunk,
          sources: ['vector'],
          baseScore,
          weightedScore: baseScore * SOURCE_WEIGHTS.VECTOR,
          isExactMatch: false,
        })
      }
    } catch (error) {
      logger.debug(`Vector search failed for query: ${error}`)
    }
  }

  const durationMs = performance.now() - startTime
  return {
    results,
    metrics: {
      name: 'vector',
      durationMs,
      resultCount: results.length,
      skipped: false,
    },
  }
}

/**
 * Stage 3: Structural lookup via definitions, usages, and call graph.
 *
 * Provides deep code understanding by finding:
 * - Where modified symbols are defined
 * - Where modified symbols are used (potential impact)
 * - What functions call/are called by modified code (call graph)
 */
async function executeStructuralStage(
  client: IndexerClient,
  input: PipelineInput,
  config: PipelineConfig,
  budget: number,
  existingIds: Set<string>
): Promise<{ results: PipelineResult[]; metrics: StageMetrics }> {
  const startTime = performance.now()
  const results: PipelineResult[] = []

  // Process symbols for definition and usage lookups
  const symbolsToLookup = input.symbols.slice(0, 8)

  for (const symbol of symbolsToLookup) {
    const elapsed = performance.now() - startTime
    if (elapsed > budget) {
      logger.debug(`Structural stage budget exhausted after ${symbolsToLookup.indexOf(symbol)} symbols`)
      break
    }

    // Look up definitions
    try {
      const defResult = await client.lookupDefinitions(
        symbol,
        config.repoUrl,
        config.branch,
        true, // include re-exports
        STAGE_LIMITS.DEFINITIONS
      )

      for (const def of defResult.definitions) {
        const chunk: CodeChunk = {
          filename: def.filePath,
          code: def.content,
          score: 0.8, // High base score for definitions
          startLine: def.lineStart,
          endLine: def.lineEnd,
        }

        const id = getChunkId(chunk)
        if (existingIds.has(id)) continue
        existingIds.add(id)

        results.push({
          chunk,
          sources: ['definition'],
          baseScore: 0.8,
          weightedScore: 0.8 * SOURCE_WEIGHTS.DEFINITION,
          isExactMatch: true,
          matchedSymbol: symbol,
        })
      }
    } catch (error) {
      logger.debug(`Definition lookup failed for "${symbol}": ${error}`)
    }

    // Look up usages
    try {
      const usageResult = await client.lookupUsages(
        symbol,
        config.repoUrl,
        config.branch,
        STAGE_LIMITS.USAGES
      )

      for (const usage of usageResult.usages) {
        const chunk: CodeChunk = {
          filename: usage.filePath,
          code: usage.content,
          score: 0.7, // Slightly lower than definitions
          startLine: usage.lineStart,
          endLine: usage.lineEnd,
        }

        const id = getChunkId(chunk)
        if (existingIds.has(id)) continue
        existingIds.add(id)

        results.push({
          chunk,
          sources: ['usage'],
          baseScore: 0.7,
          weightedScore: 0.7 * SOURCE_WEIGHTS.USAGE,
          isExactMatch: false,
          matchedSymbol: symbol,
        })
      }
    } catch (error) {
      logger.debug(`Usage lookup failed for "${symbol}": ${error}`)
    }

    // Call graph lookup for function-like symbols
    if (isFunctionLikeSymbol(symbol)) {
      try {
        const callgraphResult = await client.getCallGraph(
          symbol,
          config.repoUrl,
          config.branch,
          'both', // Get both callers and callees
          2 // 2 levels deep
        )

        // Process callers
        for (const caller of callgraphResult.callers.slice(0, 5)) {
          // Skip nodes without content
          if (!caller.content) continue

          const chunk: CodeChunk = {
            filename: caller.filePath,
            code: caller.content,
            score: 0.75,
            startLine: caller.lineStart,
            endLine: caller.lineEnd,
          }

          const id = getChunkId(chunk)
          if (existingIds.has(id)) continue
          existingIds.add(id)

          results.push({
            chunk,
            sources: ['callgraph'],
            baseScore: 0.75,
            weightedScore: 0.75 * SOURCE_WEIGHTS.CALLGRAPH,
            isExactMatch: false,
            matchedSymbol: symbol,
            relationship: 'caller',
          })
        }

        // Process callees
        for (const callee of callgraphResult.callees.slice(0, 5)) {
          // Skip nodes without content
          if (!callee.content) continue

          const chunk: CodeChunk = {
            filename: callee.filePath,
            code: callee.content,
            score: 0.7,
            startLine: callee.lineStart,
            endLine: callee.lineEnd,
          }

          const id = getChunkId(chunk)
          if (existingIds.has(id)) continue
          existingIds.add(id)

          results.push({
            chunk,
            sources: ['callgraph'],
            baseScore: 0.7,
            weightedScore: 0.7 * SOURCE_WEIGHTS.CALLGRAPH,
            isExactMatch: false,
            matchedSymbol: symbol,
            relationship: 'callee',
          })
        }
      } catch (error) {
        logger.debug(`Call graph lookup failed for "${symbol}": ${error}`)
      }
    }
  }

  const durationMs = performance.now() - startTime
  return {
    results,
    metrics: {
      name: 'structural',
      durationMs,
      resultCount: results.length,
      skipped: false,
    },
  }
}

/**
 * Check if a symbol name looks like a function (for call graph lookups).
 */
function isFunctionLikeSymbol(symbol: string): boolean {
  // Exclude type-like names (usually PascalCase without verb)
  // Include function-like names (usually camelCase with verb or lowercase)
  const isTypeLike = /^[A-Z][a-z]*(?:[A-Z][a-z]*)*$/.test(symbol) &&
    !symbol.match(/^(Get|Set|Create|Delete|Update|Handle|Process|Validate|Parse|Build|Send|Fetch)/)

  return !isTypeLike && symbol.length > 2
}

/**
 * Stage 4: Re-rank combined results by relevance.
 *
 * Combines results from all stages, applies final weighting based on:
 * - Source type (keyword > structural > vector)
 * - Match exactness
 * - Overlap with modified lines
 * - Multiple source contribution
 */
function executeRerankStage(
  allResults: PipelineResult[],
  input: PipelineInput,
  config: PipelineConfig
): { results: PipelineResult[]; metrics: StageMetrics } {
  const startTime = performance.now()

  // Group by chunk ID to merge multi-source results
  const byId = new Map<string, PipelineResult>()

  for (const result of allResults) {
    const id = getChunkId(result.chunk)
    const existing = byId.get(id)

    if (existing) {
      // Merge sources and boost score for multi-source matches
      const mergedSources = [...new Set([...existing.sources, ...result.sources])]
      const multiSourceBoost = 1 + (mergedSources.length - 1) * 0.15 // 15% boost per additional source

      existing.sources = mergedSources
      existing.weightedScore = Math.max(existing.weightedScore, result.weightedScore) * multiSourceBoost
      existing.isExactMatch = existing.isExactMatch || result.isExactMatch

      if (result.matchedSymbol && !existing.matchedSymbol) {
        existing.matchedSymbol = result.matchedSymbol
      }
    } else {
      byId.set(id, { ...result })
    }
  }

  // Apply modified line boost
  const results = Array.from(byId.values())
  for (const result of results) {
    const fileChanges = input.parsedDiff.fileChanges.get(result.chunk.filename)
    if (fileChanges) {
      const allModifiedLines = [
        ...fileChanges.additions,
        ...fileChanges.deletions,
        ...fileChanges.modifications,
      ]

      // Check if chunk overlaps with modified lines
      const overlaps = allModifiedLines.some(
        line => line >= result.chunk.startLine && line <= result.chunk.endLine
      )

      if (overlaps) {
        result.weightedScore *= 1.5 // 50% boost for overlapping with changes
      }
    }
  }

  // Sort by weighted score descending
  results.sort((a, b) => b.weightedScore - a.weightedScore)

  // Limit to maxResults
  const finalResults = results.slice(0, config.maxResults)

  const durationMs = performance.now() - startTime
  return {
    results: finalResults,
    metrics: {
      name: 'rerank',
      durationMs,
      resultCount: finalResults.length,
      skipped: false,
    },
  }
}

/**
 * Check if results meet the early termination criteria.
 *
 * Early termination is triggered when:
 * - At least 5 results are found
 * - Top 3 results have scores > threshold
 */
function shouldTerminateEarly(
  results: PipelineResult[],
  threshold: number
): { terminate: boolean; reason?: string } {
  if (results.length < 5) {
    return { terminate: false }
  }

  // Check if top 3 results exceed threshold
  const topResults = results.slice(0, 3)
  const highConfidenceCount = topResults.filter(r => r.weightedScore > threshold).length

  if (highConfidenceCount >= 3) {
    return {
      terminate: true,
      reason: `Top 3 results exceed ${threshold} confidence threshold`,
    }
  }

  // Also check for multiple exact matches
  const exactMatchCount = results.filter(r => r.isExactMatch).length
  if (exactMatchCount >= 5) {
    return {
      terminate: true,
      reason: `Found ${exactMatchCount} exact symbol matches`,
    }
  }

  return { terminate: false }
}

/**
 * Execute the complete multi-stage retrieval pipeline.
 *
 * Runs stages in order:
 * 1. Keyword search (fast, exact matches)
 * 2. Vector similarity (semantic matches)
 * 3. Structural lookups (definitions, usages, call graph)
 * 4. Re-ranking (combine and score)
 *
 * Early termination occurs if high-confidence matches are found after stages 1-2.
 */
export async function executePipeline(
  client: IndexerClient,
  input: PipelineInput,
  config: PipelineConfig
): Promise<PipelineExecutionResult> {
  const overallStart = performance.now()
  const stageMetrics: StageMetrics[] = []
  const allResults: PipelineResult[] = []
  const seenIds = new Set<string>()
  let earlyTerminated = false
  let earlyTerminationReason: string | undefined

  // Resolve budgets with defaults
  const budgets = {
    ...STAGE_BUDGETS,
    ...config.stageBudgets,
  }

  // Stage 1: Keyword Search
  logger.debug('Pipeline Stage 1: Keyword search')
  const keywordStage = await executeKeywordStage(client, input, config, budgets.KEYWORD_SEARCH)
  stageMetrics.push(keywordStage.metrics)
  allResults.push(...keywordStage.results)
  keywordStage.results.forEach(r => seenIds.add(getChunkId(r.chunk)))

  // Check early termination after keyword stage
  if (config.enableEarlyTermination) {
    const termCheck = shouldTerminateEarly(allResults, config.earlyTerminationThreshold)
    if (termCheck.terminate) {
      earlyTerminated = true
      earlyTerminationReason = termCheck.reason
      logger.debug(`Early termination after keyword stage: ${termCheck.reason}`)

      // Still run rerank stage
      const rerankStage = executeRerankStage(allResults, input, config)
      stageMetrics.push(rerankStage.metrics)

      // Add skipped stage metrics
      stageMetrics.push({
        name: 'vector',
        durationMs: 0,
        resultCount: 0,
        skipped: true,
        skipReason: 'Early termination',
      })
      stageMetrics.push({
        name: 'structural',
        durationMs: 0,
        resultCount: 0,
        skipped: true,
        skipReason: 'Early termination',
      })

      return {
        results: rerankStage.results,
        stageMetrics,
        totalDurationMs: performance.now() - overallStart,
        earlyTerminated,
        earlyTerminationReason,
      }
    }
  }

  // Stage 2: Vector Similarity Search
  logger.debug('Pipeline Stage 2: Vector similarity search')
  const vectorStage = await executeVectorStage(client, input, config, budgets.VECTOR_SEARCH, seenIds)
  stageMetrics.push(vectorStage.metrics)
  allResults.push(...vectorStage.results)

  // Check early termination after vector stage
  if (config.enableEarlyTermination) {
    const termCheck = shouldTerminateEarly(allResults, config.earlyTerminationThreshold)
    if (termCheck.terminate) {
      earlyTerminated = true
      earlyTerminationReason = termCheck.reason
      logger.debug(`Early termination after vector stage: ${termCheck.reason}`)

      // Still run rerank stage
      const rerankStage = executeRerankStage(allResults, input, config)
      stageMetrics.push(rerankStage.metrics)

      // Add skipped stage metric
      stageMetrics.push({
        name: 'structural',
        durationMs: 0,
        resultCount: 0,
        skipped: true,
        skipReason: 'Early termination',
      })

      return {
        results: rerankStage.results,
        stageMetrics,
        totalDurationMs: performance.now() - overallStart,
        earlyTerminated,
        earlyTerminationReason,
      }
    }
  }

  // Stage 3: Structural Lookups
  logger.debug('Pipeline Stage 3: Structural lookups')
  const structuralStage = await executeStructuralStage(
    client,
    input,
    config,
    budgets.STRUCTURAL_LOOKUP,
    seenIds
  )
  stageMetrics.push(structuralStage.metrics)
  allResults.push(...structuralStage.results)

  // Stage 4: Re-rank
  logger.debug('Pipeline Stage 4: Re-ranking')
  const rerankStage = executeRerankStage(allResults, input, config)
  stageMetrics.push(rerankStage.metrics)

  return {
    results: rerankStage.results,
    stageMetrics,
    totalDurationMs: performance.now() - overallStart,
    earlyTerminated,
    earlyTerminationReason,
  }
}

/**
 * Convert pipeline results to weighted code chunks for compatibility
 * with the existing context formatting system.
 */
export function pipelineResultsToWeightedChunks(
  results: PipelineResult[]
): WeightedCodeChunk[] {
  return results.map(result => ({
    ...result.chunk,
    originalScore: result.baseScore,
    score: result.weightedScore,
    weightMultiplier: result.weightedScore / result.baseScore,
    isModifiedContext: result.sources.includes('definition') || result.sources.includes('usage'),
    isTestFile: result.chunk.filename.includes('.test.') ||
      result.chunk.filename.includes('.spec.') ||
      result.chunk.filename.includes('__tests__'),
  }))
}

/**
 * Extract symbols from diff content for structural lookups.
 *
 * Finds function names, class names, variable names, and other identifiers
 * that appear in the modified code.
 */
export function extractSymbolsFromDiff(diffContent: string): string[] {
  const symbols: string[] = []
  const lines = diffContent.split('\n')

  // Patterns to extract meaningful symbols
  const patterns = [
    // Function/method definitions
    /function\s+(\w+)/,
    /def\s+(\w+)/,
    /func\s+(\w+)/,
    /fn\s+(\w+)/,
    // Class definitions
    /class\s+(\w+)/,
    /interface\s+(\w+)/,
    /type\s+(\w+)\s*[=<]/,
    /struct\s+(\w+)/,
    // Variable assignments with type inference
    /(?:const|let|var)\s+(\w+)\s*=/,
    // Method calls on specific objects
    /\.(\w{3,})\s*\(/,
    // Import statements
    /import\s+\{\s*([^}]+)\s*\}/,
    /from\s+['"]([^'"]+)['"]/,
  ]

  for (const line of lines) {
    // Only process added/removed lines
    if (!line.startsWith('+') && !line.startsWith('-')) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue

    const codeLine = line.slice(1)

    for (const pattern of patterns) {
      const match = codeLine.match(pattern)
      if (match && match[1]) {
        // Handle comma-separated imports
        const parts = match[1].split(',').map(p => p.trim())
        for (const part of parts) {
          const cleanName = part.split(' ')[0] // Handle "foo as bar" syntax
          if (cleanName.length >= 3 && !isCommonKeyword(cleanName)) {
            if (!symbols.includes(cleanName)) {
              symbols.push(cleanName)
            }
          }
        }
      }
    }
  }

  return symbols.slice(0, 20) // Limit to prevent excessive lookups
}

/**
 * Check if a word is a common programming keyword (not a meaningful symbol).
 */
function isCommonKeyword(word: string): boolean {
  const keywords = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof',
    'instanceof', 'void', 'null', 'undefined', 'true', 'false', 'this', 'super',
    'class', 'extends', 'implements', 'interface', 'type', 'enum', 'const',
    'let', 'var', 'function', 'async', 'await', 'import', 'export', 'from',
    'default', 'static', 'public', 'private', 'protected', 'readonly',
    'abstract', 'override', 'get', 'set', 'constructor', 'with', 'in', 'of',
  ])
  return keywords.has(word.toLowerCase())
}

/**
 * Create a pipeline input from diff content and PR description.
 */
export function createPipelineInput(
  diffContent: string,
  parsedDiff: ParsedDiff,
  diffQueries: string[],
  descriptionQueries: string[]
): PipelineInput {
  const symbols = extractSymbolsFromDiff(diffContent)
  const modifiedFiles = Array.from(parsedDiff.fileChanges.keys())

  return {
    diffQueries,
    descriptionQueries,
    symbols,
    modifiedFiles,
    parsedDiff,
  }
}

/**
 * Log pipeline execution metrics for debugging.
 */
export function logPipelineMetrics(result: PipelineExecutionResult): void {
  logger.debug(`Pipeline completed in ${result.totalDurationMs.toFixed(0)}ms`)

  for (const metrics of result.stageMetrics) {
    if (metrics.skipped) {
      logger.debug(`  ${metrics.name}: skipped (${metrics.skipReason})`)
    } else {
      logger.debug(`  ${metrics.name}: ${metrics.resultCount} results in ${metrics.durationMs.toFixed(0)}ms`)
    }
  }

  if (result.earlyTerminated) {
    logger.debug(`  Early termination: ${result.earlyTerminationReason}`)
  }

  // Log source breakdown
  const sourceCounts = new Map<RetrievalSource, number>()
  for (const r of result.results) {
    for (const source of r.sources) {
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1)
    }
  }

  const sourceBreakdown = Array.from(sourceCounts.entries())
    .map(([source, count]) => `${source}: ${count}`)
    .join(', ')
  logger.debug(`  Sources: ${sourceBreakdown}`)
}
