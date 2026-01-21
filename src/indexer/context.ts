import { IndexerClient } from './client.js'
import { getIndexerApiUrl, isIndexerRunning } from './docker.js'
import { logger } from '../utils/logger.js'
import type { CodeChunk, SemanticContextOptions, ModifiedLine, ParsedDiff, WeightedCodeChunk } from './types.js'

/**
 * Weight multiplier for chunks that overlap with modified lines.
 * A value of 2.0 means modified code is ranked as if it were twice as relevant.
 */
const MODIFIED_LINE_WEIGHT_MULTIPLIER = 2.0

/**
 * Parse a git diff to extract modified lines with their file locations and change types.
 *
 * Handles unified diff format with @@ hunk headers to track line numbers accurately.
 * Supports additions (+), deletions (-), and detects modifications (adjacent +/- pairs).
 */
export function parseDiffToModifiedLines(diffContent: string): ParsedDiff {
  const modifiedLines: ModifiedLine[] = []
  const fileChanges = new Map<string, { additions: number[]; deletions: number[]; modifications: number[] }>()

  const lines = diffContent.split('\n')
  let currentFile = ''
  let oldLineNum = 0
  let newLineNum = 0

  // Track consecutive deletions and additions to detect modifications
  const pendingDeletions: { lineNumber: number; content: string }[] = []

  const flushPendingDeletions = () => {
    // Any remaining pending deletions are pure deletions
    for (const del of pendingDeletions) {
      modifiedLines.push({
        filename: currentFile,
        lineNumber: del.lineNumber,
        content: del.content,
        changeType: 'deletion'
      })

      const fileEntry = fileChanges.get(currentFile)
      if (fileEntry) {
        fileEntry.deletions.push(del.lineNumber)
      }
    }
    pendingDeletions.length = 0
  }

  for (const line of lines) {
    // Match file header: diff --git a/path/to/file b/path/to/file
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (fileMatch) {
      flushPendingDeletions()
      currentFile = fileMatch[2] // Use the "b" side (new file path)

      // Initialize file entry if not exists
      if (!fileChanges.has(currentFile)) {
        fileChanges.set(currentFile, { additions: [], deletions: [], modifications: [] })
      }
      continue
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      flushPendingDeletions()
      oldLineNum = parseInt(hunkMatch[1], 10)
      newLineNum = parseInt(hunkMatch[2], 10)
      continue
    }

    // Skip file headers and other metadata
    if (line.startsWith('+++') || line.startsWith('---') ||
        line.startsWith('index ') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('Binary')) {
      continue
    }

    // Skip empty diff lines after hunk processing
    if (!currentFile) {
      continue
    }

    // Process diff lines
    if (line.startsWith('-')) {
      // Deletion - store as pending to detect modifications
      const content = line.slice(1)
      pendingDeletions.push({ lineNumber: oldLineNum, content })
      oldLineNum++
    } else if (line.startsWith('+')) {
      // Addition
      const content = line.slice(1)

      // Check if this addition follows a deletion (indicates modification)
      if (pendingDeletions.length > 0) {
        // Treat as modification - pair with first pending deletion
        const deletion = pendingDeletions.shift()!

        modifiedLines.push({
          filename: currentFile,
          lineNumber: newLineNum,
          content: content,
          changeType: 'modification'
        })

        // Also track the old line as part of the modification context
        modifiedLines.push({
          filename: currentFile,
          lineNumber: deletion.lineNumber,
          content: deletion.content,
          changeType: 'modification'
        })

        const fileEntry = fileChanges.get(currentFile)
        if (fileEntry) {
          fileEntry.modifications.push(newLineNum)
          fileEntry.modifications.push(deletion.lineNumber)
        }
      } else {
        // Pure addition
        modifiedLines.push({
          filename: currentFile,
          lineNumber: newLineNum,
          content: content,
          changeType: 'addition'
        })

        const fileEntry = fileChanges.get(currentFile)
        if (fileEntry) {
          fileEntry.additions.push(newLineNum)
        }
      }
      newLineNum++
    } else if (line.startsWith(' ') || (line === '' && currentFile && newLineNum > 0)) {
      // Context line (or empty line within a hunk) - flush any pending deletions
      // Empty lines within hunks are context lines and need to increment line counters
      flushPendingDeletions()
      oldLineNum++
      newLineNum++
    }
  }

  // Flush any remaining deletions at end of diff
  flushPendingDeletions()

  logger.debug(`Parsed diff: ${modifiedLines.length} modified lines across ${fileChanges.size} files`)

  return { modifiedLines, fileChanges }
}

/**
 * Check if a code chunk overlaps with any modified lines.
 *
 * A chunk overlaps if:
 * 1. The filename matches (normalized for path differences)
 * 2. The chunk's line range intersects with any modified line
 */
export function chunkOverlapsModifiedLines(
  chunk: CodeChunk,
  parsedDiff: ParsedDiff
): boolean {
  const fileEntry = parsedDiff.fileChanges.get(chunk.filename)
  if (!fileEntry) {
    // Try matching with different path normalization
    for (const [filename, entry] of parsedDiff.fileChanges) {
      if (chunk.filename.endsWith(filename) || filename.endsWith(chunk.filename)) {
        const allLines = [...entry.additions, ...entry.deletions, ...entry.modifications]
        for (const lineNum of allLines) {
          if (lineNum >= chunk.startLine && lineNum <= chunk.endLine) {
            return true
          }
        }
      }
    }
    return false
  }

  // Check if any modified line falls within the chunk's range
  const allLines = [...fileEntry.additions, ...fileEntry.deletions, ...fileEntry.modifications]
  for (const lineNum of allLines) {
    if (lineNum >= chunk.startLine && lineNum <= chunk.endLine) {
      return true
    }
  }

  return false
}

/**
 * Apply weight multiplier to chunks that overlap with modified lines.
 * Returns chunks with adjusted scores and metadata about the weighting.
 */
export function applyModifiedLineWeighting(
  chunks: CodeChunk[],
  parsedDiff: ParsedDiff
): WeightedCodeChunk[] {
  return chunks.map(chunk => {
    const isModifiedContext = chunkOverlapsModifiedLines(chunk, parsedDiff)
    const weightMultiplier = isModifiedContext ? MODIFIED_LINE_WEIGHT_MULTIPLIER : 1.0

    return {
      ...chunk,
      originalScore: chunk.score,
      score: chunk.score * weightMultiplier,
      weightMultiplier,
      isModifiedContext
    }
  })
}

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
 * Format code chunks for inclusion in the prompt.
 * Weighted chunks are annotated to indicate they contain modified code.
 */
function formatContext(chunks: WeightedCodeChunk[]): string {
  if (chunks.length === 0) {
    return ''
  }

  const parts: string[] = []

  for (const chunk of chunks) {
    // Annotate chunks that overlap with modified lines
    const annotation = chunk.isModifiedContext ? ' [MODIFIED]' : ''
    parts.push(`### ${chunk.filename} (lines ${chunk.startLine}-${chunk.endLine})${annotation}`)
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
 *
 * Modified lines are weighted 2x higher in relevance scoring to ensure
 * the LLM sees the exact changes being reviewed first.
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

  // Parse the diff to extract modified line information for weighting
  const parsedDiff = parseDiffToModifiedLines(diffContent)

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

  // Apply weight multiplier to chunks overlapping with modified lines
  const weightedChunks = applyModifiedLineWeighting(allChunks, parsedDiff)

  // Count how many chunks are from modified context
  const modifiedCount = weightedChunks.filter(c => c.isModifiedContext).length
  logger.debug(`Found ${modifiedCount} chunks overlapping with modified lines (weighted 2x)`)

  // Sort by weighted score (descending) - modified code appears first
  weightedChunks.sort((a, b) => b.score - a.score)

  // Take top chunks up to token limit
  const selectedChunks: WeightedCodeChunk[] = []
  let totalTokens = 0

  for (const chunk of weightedChunks) {
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

  const selectedModifiedCount = selectedChunks.filter(c => c.isModifiedContext).length
  logger.info(
    `Including ${selectedChunks.length} related code chunks (${selectedModifiedCount} modified, ${totalTokens} estimated tokens)`
  )

  return formatContext(selectedChunks)
}
