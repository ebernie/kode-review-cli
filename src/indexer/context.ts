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
 * Weight multiplier for test file chunks.
 * A value of 1.5 means test files are ranked higher to ensure LLM sees test coverage.
 */
const TEST_FILE_WEIGHT_MULTIPLIER = 1.5

/**
 * Maximum number of test file chunks to include per source file.
 */
const MAX_TEST_CHUNKS_PER_SOURCE = 3

/**
 * Test file naming patterns - file must contain one of these patterns to be a test file.
 * Supports: .test., .spec., _test., test_ (prefix)
 */
const TEST_FILE_PATTERNS = [
  /\.test\./,     // foo.test.ts, foo.test.js
  /\.spec\./,     // foo.spec.ts, foo.spec.js
  /_test\./,      // foo_test.py, foo_test.go
  /^test_/,       // test_foo.py (prefix - checked against basename)
  /\.tests\./,    // foo.tests.ts (plural form)
  /\.specs\./,    // foo.specs.ts (plural form)
]

/**
 * Test directory patterns - file is a test if it's inside one of these directories.
 */
const TEST_DIRECTORY_PATTERNS = [
  /__tests__\//,    // src/foo/__tests__/bar.ts
  /\/tests\//,      // src/tests/bar.ts
  /\/test\//,       // test/bar.ts
  /\/spec\//,       // spec/bar.ts
  /^tests\//,       // tests/bar.ts (at root)
  /^test\//,        // test/bar.ts (at root)
  /^spec\//,        // spec/bar.ts (at root)
]

/**
 * Check if a file path represents a test file based on naming conventions and directory patterns.
 *
 * Supports:
 * - Naming patterns: .test., .spec., _test., test_ (prefix)
 * - Directory patterns: __tests__/, tests/, test/, spec/
 */
export function isTestFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const basename = normalizedPath.split('/').pop() || ''

  // Check test directory patterns
  for (const pattern of TEST_DIRECTORY_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return true
    }
  }

  // Check test file naming patterns
  for (const pattern of TEST_FILE_PATTERNS) {
    // For test_ prefix pattern, check against basename only
    if (pattern.source === '^test_') {
      if (pattern.test(basename)) {
        return true
      }
    } else if (pattern.test(normalizedPath)) {
      return true
    }
  }

  return false
}

/**
 * Generate possible test file paths for a given source file.
 *
 * For a source file like 'src/utils/helpers.ts', generates:
 * - src/utils/helpers.test.ts
 * - src/utils/helpers.spec.ts
 * - src/utils/__tests__/helpers.ts
 * - src/utils/__tests__/helpers.test.ts
 * - src/utils/__tests__/helpers.spec.ts
 * - test/utils/helpers.ts
 * - test/utils/helpers.test.ts
 * - tests/utils/helpers.ts
 * - tests/utils/helpers.test.ts
 * - For Python: src/utils/test_helpers.py, src/utils/helpers_test.py
 */
export function generateTestFilePaths(sourceFile: string): string[] {
  const normalizedPath = sourceFile.replace(/\\/g, '/')

  // Skip if already a test file
  if (isTestFile(normalizedPath)) {
    return []
  }

  const paths: string[] = []
  const parts = normalizedPath.split('/')
  const filename = parts.pop() || ''
  const directory = parts.join('/')

  // Extract file name without extension and the extension
  const lastDotIndex = filename.lastIndexOf('.')
  const baseName = lastDotIndex > 0 ? filename.slice(0, lastDotIndex) : filename
  const extension = lastDotIndex > 0 ? filename.slice(lastDotIndex) : ''

  // Determine if this is Python (uses different conventions)
  const isPython = extension === '.py'

  // 1. Same directory with test suffix patterns
  // Handle root-level files (no directory) vs nested files
  const dirPrefix = directory ? `${directory}/` : ''
  if (isPython) {
    paths.push(`${dirPrefix}${baseName}_test${extension}`)  // helpers_test.py
    paths.push(`${dirPrefix}test_${baseName}${extension}`)  // test_helpers.py
  } else {
    paths.push(`${dirPrefix}${baseName}.test${extension}`)  // helpers.test.ts
    paths.push(`${dirPrefix}${baseName}.spec${extension}`)  // helpers.spec.ts
  }

  // 2. __tests__ subdirectory (common in JS/TS projects)
  const testsDir = directory ? `${directory}/__tests__` : '__tests__'
  paths.push(`${testsDir}/${filename}`)                      // __tests__/helpers.ts
  paths.push(`${testsDir}/${baseName}.test${extension}`)     // __tests__/helpers.test.ts
  paths.push(`${testsDir}/${baseName}.spec${extension}`)     // __tests__/helpers.spec.ts

  // 3. Root-level test directories with mirrored structure
  // Get the relative path after common source directories (src/, lib/, pkg/, etc.)
  const srcPrefixes = ['src/', 'lib/', 'pkg/', 'packages/', 'app/']
  let relativePath = normalizedPath
  for (const prefix of srcPrefixes) {
    if (normalizedPath.startsWith(prefix)) {
      relativePath = normalizedPath.slice(prefix.length)
      break
    }
  }

  // test/ and tests/ directories
  const relativeDir = relativePath.split('/').slice(0, -1).join('/')
  const relativeBase = relativePath.split('/').pop() || filename

  for (const testDir of ['test', 'tests', 'spec']) {
    const testPath = relativeDir ? `${testDir}/${relativeDir}` : testDir
    paths.push(`${testPath}/${relativeBase}`)
    if (isPython) {
      const relBaseName = relativeBase.lastIndexOf('.') > 0
        ? relativeBase.slice(0, relativeBase.lastIndexOf('.'))
        : relativeBase
      const relExt = relativeBase.lastIndexOf('.') > 0
        ? relativeBase.slice(relativeBase.lastIndexOf('.'))
        : ''
      paths.push(`${testPath}/${relBaseName}_test${relExt}`)
      paths.push(`${testPath}/test_${relBaseName}${relExt}`)
    } else {
      const relBaseName = relativeBase.lastIndexOf('.') > 0
        ? relativeBase.slice(0, relativeBase.lastIndexOf('.'))
        : relativeBase
      const relExt = relativeBase.lastIndexOf('.') > 0
        ? relativeBase.slice(relativeBase.lastIndexOf('.'))
        : ''
      paths.push(`${testPath}/${relBaseName}.test${relExt}`)
      paths.push(`${testPath}/${relBaseName}.spec${relExt}`)
    }
  }

  // Remove duplicates and return
  return [...new Set(paths)]
}

/**
 * Extract source file paths from a parsed diff.
 * Returns only non-test source files that were modified.
 */
export function extractSourceFilesFromDiff(parsedDiff: ParsedDiff): string[] {
  const sourceFiles: string[] = []

  for (const filename of parsedDiff.fileChanges.keys()) {
    // Skip test files - we want to find tests FOR source files, not tests for tests
    if (!isTestFile(filename)) {
      sourceFiles.push(filename)
    }
  }

  return sourceFiles
}

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
 * Weighted chunks are annotated to indicate they contain modified code or are test files.
 */
function formatContext(chunks: WeightedCodeChunk[]): string {
  if (chunks.length === 0) {
    return ''
  }

  const parts: string[] = []

  for (const chunk of chunks) {
    // Build annotations array
    const annotations: string[] = []
    if (chunk.isModifiedContext) {
      annotations.push('MODIFIED')
    }
    if (chunk.isTestFile) {
      annotations.push('TEST_FILE')
    }

    const annotationStr = annotations.length > 0 ? ` [${annotations.join(', ')}]` : ''
    parts.push(`### ${chunk.filename} (lines ${chunk.startLine}-${chunk.endLine})${annotationStr}`)
    parts.push('```')
    parts.push(chunk.code)
    parts.push('```')
    parts.push('')
  }

  return parts.join('\n')
}

/**
 * Find related test files for a list of source files.
 *
 * For each source file, generates possible test file paths and searches
 * the index for matching chunks. Test file chunks are marked with
 * isTestFile=true and include the related source file reference.
 *
 * @param sourceFiles - List of source file paths to find tests for
 * @param client - IndexerClient instance
 * @param repoUrl - Repository URL to scope search
 * @param branch - Optional branch to scope search
 * @returns Array of weighted code chunks from test files
 */
export async function findRelatedTestFiles(
  sourceFiles: string[],
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<WeightedCodeChunk[]> {
  const testChunks: WeightedCodeChunk[] = []
  const seenIds = new Set<string>()
  const testFileCountPerSource = new Map<string, number>()

  for (const sourceFile of sourceFiles) {
    const testFilePaths = generateTestFilePaths(sourceFile)

    if (testFilePaths.length === 0) {
      continue
    }

    // Search for each potential test file
    for (const testPath of testFilePaths) {
      // Check if we've already found enough test chunks for this source file
      const currentCount = testFileCountPerSource.get(sourceFile) || 0
      if (currentCount >= MAX_TEST_CHUNKS_PER_SOURCE) {
        break
      }

      try {
        // Search using the test file path as a query
        // This works because the indexer stores the filename as part of the chunk
        const results = await client.search(`file:${testPath}`, repoUrl, 3, branch)

        for (const chunk of results) {
          // Only include chunks that are actually test files
          if (!isTestFile(chunk.filename)) {
            continue
          }

          // Deduplicate
          const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
          if (seenIds.has(id)) {
            continue
          }

          // Check source file limit
          const count = testFileCountPerSource.get(sourceFile) || 0
          if (count >= MAX_TEST_CHUNKS_PER_SOURCE) {
            break
          }

          seenIds.add(id)
          testFileCountPerSource.set(sourceFile, count + 1)

          // Create weighted chunk with test file metadata
          testChunks.push({
            ...chunk,
            originalScore: chunk.score,
            score: chunk.score * TEST_FILE_WEIGHT_MULTIPLIER,
            weightMultiplier: TEST_FILE_WEIGHT_MULTIPLIER,
            isModifiedContext: false,
            isTestFile: true,
            relatedSourceFile: sourceFile
          })
        }
      } catch (error) {
        logger.debug(`Search failed for test file "${testPath}": ${error}`)
      }
    }
  }

  return testChunks
}

/**
 * Find test files by searching for test file patterns directly in the index.
 * This is a fallback when path-based search doesn't find results.
 *
 * @param sourceFiles - List of source file paths to find tests for
 * @param client - IndexerClient instance
 * @param repoUrl - Repository URL to scope search
 * @param branch - Optional branch to scope search
 * @returns Array of weighted code chunks from test files
 */
async function findTestFilesBySymbolSearch(
  sourceFiles: string[],
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<WeightedCodeChunk[]> {
  const testChunks: WeightedCodeChunk[] = []
  const seenIds = new Set<string>()

  for (const sourceFile of sourceFiles) {
    // Extract the base filename without path and extension
    const parts = sourceFile.replace(/\\/g, '/').split('/')
    const filename = parts.pop() || ''
    const lastDotIndex = filename.lastIndexOf('.')
    const baseName = lastDotIndex > 0 ? filename.slice(0, lastDotIndex) : filename

    // Search for test files that mention this module name
    const searchQueries = [
      `${baseName} test`,
      `describe ${baseName}`,
      `test ${baseName}`,
    ]

    for (const query of searchQueries) {
      try {
        const results = await client.search(query, repoUrl, 5, branch)

        for (const chunk of results) {
          // Only include chunks that are actually test files
          if (!isTestFile(chunk.filename)) {
            continue
          }

          // Deduplicate
          const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
          if (seenIds.has(id)) {
            continue
          }

          seenIds.add(id)

          // Create weighted chunk with test file metadata
          testChunks.push({
            ...chunk,
            originalScore: chunk.score,
            score: chunk.score * TEST_FILE_WEIGHT_MULTIPLIER,
            weightMultiplier: TEST_FILE_WEIGHT_MULTIPLIER,
            isModifiedContext: false,
            isTestFile: true,
            relatedSourceFile: sourceFile
          })
        }
      } catch (error) {
        logger.debug(`Symbol search failed for "${query}": ${error}`)
      }
    }
  }

  return testChunks
}

/**
 * Get semantic context for a code review.
 *
 * Extracts queries from the diff, searches the index, and formats
 * the results for inclusion in the review prompt.
 *
 * Modified lines are weighted 2x higher in relevance scoring to ensure
 * the LLM sees the exact changes being reviewed first.
 *
 * Test files related to modified source files are automatically included
 * with a 1.5x weight multiplier to help the LLM verify test coverage.
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

  // Find related test files for modified source files
  const sourceFiles = extractSourceFilesFromDiff(parsedDiff)
  let testChunks: WeightedCodeChunk[] = []

  if (sourceFiles.length > 0) {
    logger.debug(`Looking for test files related to ${sourceFiles.length} modified source files`)

    // Try path-based search first
    testChunks = await findRelatedTestFiles(sourceFiles, client, repoUrl, branch)

    // If no test files found via path search, try symbol-based search
    if (testChunks.length === 0) {
      testChunks = await findTestFilesBySymbolSearch(sourceFiles, client, repoUrl, branch)
    }

    if (testChunks.length > 0) {
      logger.debug(`Found ${testChunks.length} related test file chunks (weighted 1.5x)`)
    }
  }

  // Combine regular chunks with test file chunks
  const allWeightedChunks = [...weightedChunks, ...testChunks]

  // Sort by weighted score (descending) - modified code appears first, then test files
  allWeightedChunks.sort((a, b) => b.score - a.score)

  // Take top chunks up to token limit
  const selectedChunks: WeightedCodeChunk[] = []
  let totalTokens = 0
  const seenInSelection = new Set<string>()

  for (const chunk of allWeightedChunks) {
    // Extra deduplication for combined list
    const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
    if (seenInSelection.has(id)) {
      continue
    }

    const chunkTokens = estimateTokens(chunk.code) + 50 // Add overhead for formatting
    if (totalTokens + chunkTokens > maxTokens) {
      break
    }

    seenInSelection.add(id)
    selectedChunks.push(chunk)
    totalTokens += chunkTokens

    // Also limit by count
    if (selectedChunks.length >= topK * 2) {
      break
    }
  }

  const selectedModifiedCount = selectedChunks.filter(c => c.isModifiedContext).length
  const selectedTestCount = selectedChunks.filter(c => c.isTestFile).length
  logger.info(
    `Including ${selectedChunks.length} related code chunks (${selectedModifiedCount} modified, ${selectedTestCount} test files, ${totalTokens} estimated tokens)`
  )

  return formatContext(selectedChunks)
}
