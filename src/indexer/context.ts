import { IndexerClient } from './client.js'
import { getIndexerApiUrl, isIndexerRunning } from './docker.js'
import { logger } from '../utils/logger.js'
import type { CodeChunk, SemanticContextOptions } from './types.js'

/**
 * Extract meaningful queries from a diff for semantic search.
 *
 * Strategy:
 * 1. Extract function/class/method names being modified
 * 2. Extract import statements to find related modules
 * 3. Take key changed code snippets (additions)
 */
export function extractQueriesFromDiff(diffContent: string): string[] {
  const queries: string[] = []
  const lines = diffContent.split('\n')

  // Patterns for extracting meaningful identifiers
  const functionPatterns = [
    // JavaScript/TypeScript
    /function\s+(\w+)\s*[<(]/, // function declarations: function foo( or function foo<
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, // arrow function assignments
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, // function expression assignments
    /class\s+(\w+)/, // class declarations
    /interface\s+(\w+)/, // interface declarations
    /type\s+(\w+)\s*=/, // type declarations
    // Python
    /def\s+(\w+)\s*\(/, // function definitions
    /class\s+(\w+)\s*[:(]/, // class definitions
    // Go
    /func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, // function declarations
    /type\s+(\w+)\s+struct/, // struct declarations
    // Rust
    /fn\s+(\w+)\s*[<(]/, // function declarations
    /struct\s+(\w+)/, // struct declarations
    /impl\s+(?:<[^>]+>\s*)?(\w+)/, // impl blocks
    // Java/C#
    /(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)/, // methods with access modifier
  ]

  // Import patterns
  const importPatterns = [
    /import\s+.*from\s+['"]([^'"]+)['"]/, // ES6 imports
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/, // CommonJS
    /from\s+(\w+)\s+import/, // Python
    /import\s+"([^"]+)"/, // Go
    /use\s+([\w:]+)/, // Rust
  ]

  for (const line of lines) {
    // Skip file headers
    if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) {
      continue
    }

    // Only look at added lines (+ prefix, but not +++ which is file header)
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue
    }

    const codeLine = line.slice(1) // Remove the + prefix

    // Extract function/class names
    for (const pattern of functionPatterns) {
      const match = codeLine.match(pattern)
      if (match && match[1]) {
        const name = match[1]
        // Skip common noise
        if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(name)) {
          queries.push(name)
        }
      }
    }

    // Extract imports - these help find related code
    for (const pattern of importPatterns) {
      const match = codeLine.match(pattern)
      if (match && match[1]) {
        // Clean up import path
        const importPath = match[1]
          .replace(/^@/, '') // Remove @ prefix
          .replace(/\//g, ' ') // Replace slashes with spaces
          .replace(/\.(js|ts|tsx|jsx|py|go|rs)$/, '') // Remove extensions

        if (importPath.length > 2) {
          queries.push(importPath)
        }
      }
    }
  }

  // Also extract significant code snippets (first 500 chars of additions)
  const addedCode: string[] = []
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedCode.push(line.slice(1))
    }
  }

  if (addedCode.length > 0) {
    const codeSnippet = addedCode.slice(0, 20).join('\n').slice(0, 500)
    if (codeSnippet.length > 50) {
      queries.push(codeSnippet)
    }
  }

  // Deduplicate and limit
  const uniqueQueries = [...new Set(queries)]
  return uniqueQueries.slice(0, 10) // Limit to 10 queries
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4)
}

/**
 * Format code chunks for inclusion in the prompt
 */
function formatContext(chunks: CodeChunk[]): string {
  if (chunks.length === 0) {
    return ''
  }

  const parts: string[] = []

  for (const chunk of chunks) {
    parts.push(`### ${chunk.filename} (lines ${chunk.startLine}-${chunk.endLine})`)
    parts.push('```')
    parts.push(chunk.code)
    parts.push('```')
    parts.push('')
  }

  return parts.join('\n')
}

/**
 * Get semantic context for a code review.
 *
 * Extracts queries from the diff, searches the index, and formats
 * the results for inclusion in the review prompt.
 */
export async function getSemanticContext(
  options: SemanticContextOptions
): Promise<string | null> {
  const { diffContent, repoUrl, branch, topK, maxTokens } = options

  // Check if indexer is running
  const running = await isIndexerRunning()
  if (!running) {
    logger.debug('Indexer not running, skipping semantic context')
    return null
  }

  const apiUrl = getIndexerApiUrl()
  const client = new IndexerClient(apiUrl)

  // Check health
  const healthy = await client.health()
  if (!healthy) {
    logger.debug('Indexer not healthy, skipping semantic context')
    return null
  }

  // Extract queries from the diff
  const queries = extractQueriesFromDiff(diffContent)

  if (queries.length === 0) {
    logger.debug('No queries extracted from diff')
    return null
  }

  logger.debug(`Extracted ${queries.length} queries from diff`)

  // Search for each query and collect results
  const allChunks: CodeChunk[] = []
  const seenIds = new Set<string>()

  for (const query of queries) {
    try {
      const results = await client.search(query, repoUrl, topK, branch)

      for (const chunk of results) {
        // Deduplicate by file + line range
        const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
        if (!seenIds.has(id)) {
          seenIds.add(id)
          allChunks.push(chunk)
        }
      }
    } catch (error) {
      logger.debug(`Search failed for query "${query.slice(0, 30)}...": ${error}`)
    }
  }

  if (allChunks.length === 0) {
    logger.debug('No relevant code chunks found')
    return null
  }

  // Sort by relevance score (descending)
  allChunks.sort((a, b) => b.score - a.score)

  // Take top chunks up to token limit
  const selectedChunks: CodeChunk[] = []
  let totalTokens = 0

  for (const chunk of allChunks) {
    const chunkTokens = estimateTokens(chunk.code) + 50 // Add overhead for formatting
    if (totalTokens + chunkTokens > maxTokens) {
      break
    }
    selectedChunks.push(chunk)
    totalTokens += chunkTokens

    // Also limit by count
    if (selectedChunks.length >= topK * 2) {
      break
    }
  }

  logger.info(`Including ${selectedChunks.length} related code chunks (${totalTokens} estimated tokens)`)

  return formatContext(selectedChunks)
}
