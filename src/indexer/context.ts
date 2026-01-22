import { IndexerClient } from './client.js'
import { getIndexerApiUrl, isIndexerRunning } from './docker.js'
import { logger } from '../utils/logger.js'
import type { CodeChunk, SemanticContextOptions, ModifiedLine, ParsedDiff, WeightedCodeChunk, PrDescriptionInfo } from './types.js'
import {
  getStrategyForFile,
  extractPriorityQueries,
  extractQueriesUsingStrategy,
  generateRelatedFilePaths,
  applyStrategyOverrides,
  getFileType,
  type StrategyResult,
  type FileTypeStrategyOverrides as StrategyOverrides,
} from './file-type-strategies.js'

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
 * Weight multiplier for chunks matching PR description intent.
 * A value of 1.3 means description-referenced code is ranked higher
 * to ensure the LLM understands the intent behind changes.
 */
const DESCRIPTION_WEIGHT_MULTIPLIER = 1.3

/**
 * Maximum number of queries to extract from PR description.
 */
const MAX_DESCRIPTION_QUERIES = 8

/**
 * Maximum number of file-type strategy priority queries to extract.
 */
const MAX_FILE_TYPE_PRIORITY_QUERIES = 10

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
 * Common noise keywords that shouldn't be extracted as meaningful identifiers.
 */
const NOISE_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'try',
  'else', 'break', 'continue', 'case', 'default', 'do', 'finally', 'with',
  'this', 'super', 'null', 'undefined', 'true', 'false', 'void', 'typeof',
  'instanceof', 'delete', 'in', 'of', 'async', 'await', 'yield', 'get', 'set',
  'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'final',
  'extends', 'implements', 'import', 'export', 'from', 'as', 'default', 'const',
  'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace',
  'module', 'declare', 'require', 'package', 'struct', 'impl', 'trait', 'fn',
  'def', 'lambda', 'self', 'cls', 'pass', 'raise', 'except', 'assert', 'print',
  'main', 'init', 'test', 'setup', 'teardown', 'describe', 'it', 'expect', 'mock',
])

/**
 * Common noise words in PR descriptions that shouldn't be extracted.
 */
const DESCRIPTION_NOISE_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'also', 'just', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'we', 'our', 'they', 'their', 'i', 'my', 'you', 'your',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'some', 'any', 'no', 'none', 'one', 'two', 'three',
  'add', 'adds', 'added', 'adding', 'update', 'updates', 'updated', 'updating',
  'fix', 'fixes', 'fixed', 'fixing', 'remove', 'removes', 'removed', 'removing',
  'change', 'changes', 'changed', 'changing', 'make', 'makes', 'made', 'making',
  'now', 'new', 'old', 'more', 'less', 'most', 'least', 'very', 'too',
  'pr', 'mr', 'wip', 'draft', 'todo', 'fixme', 'note', 'see', 'ref', 'refs',
])

/**
 * Patterns for extracting file paths from PR descriptions.
 */
const FILE_PATH_PATTERNS = [
  // Explicit file paths with extensions
  /(?:^|[\s`'"(])([a-zA-Z0-9_\-./]+\.[a-z]{1,4})(?:[\s`'")\]:,]|$)/gi,
  // src/, lib/, pkg/ style paths
  /(?:^|[\s`'"(])((?:src|lib|pkg|packages|app|components|utils|services|api|tests?|spec)\/[a-zA-Z0-9_\-./]+)(?:[\s`'")\]:,]|$)/gi,
  // Markdown code references `path/to/file`
  /`([a-zA-Z0-9_\-./]+(?:\.[a-z]+)?)`/gi,
]

/**
 * Patterns for extracting technical terms from PR descriptions.
 */
const TECHNICAL_TERM_PATTERNS = [
  // PascalCase identifiers (class names, component names)
  /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g,
  // camelCase identifiers (function names, variable names)
  /\b([a-z]+(?:[A-Z][a-z]+)+)\b/g,
  // snake_case identifiers
  /\b([a-z]+(?:_[a-z]+)+)\b/g,
  // CONSTANT_CASE identifiers
  /\b([A-Z]+(?:_[A-Z]+)+)\b/g,
  // Backtick-wrapped code references
  /`([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)`/g,
  // Words ending with common suffixes (Handler, Service, Controller, etc.)
  /\b([A-Z][a-zA-Z]*(?:Handler|Service|Controller|Manager|Provider|Factory|Repository|Store|Client|Server|Middleware|Router|Validator|Parser|Builder|Resolver|Listener|Observer|Worker|Queue|Cache|Logger|Util|Helper|Config|Schema|Model|Type|Interface))\b/g,
]

/**
 * Extract information from a PR/MR description for context biasing.
 *
 * Extracts:
 * - A summary (first non-empty paragraph or first 200 chars)
 * - Key terms (technical identifiers, component names)
 * - Mentioned file paths
 * - Technical concepts
 */
export function extractPrDescriptionInfo(description: string | undefined): PrDescriptionInfo | null {
  if (!description || description.trim().length === 0) {
    return null
  }

  const keyTerms: string[] = []
  const mentionedPaths: string[] = []
  const technicalConcepts: string[] = []

  // Extract file paths
  for (const pattern of FILE_PATH_PATTERNS) {
    const matches = description.matchAll(new RegExp(pattern.source, pattern.flags))
    for (const match of matches) {
      const path = match[1]?.trim()
      if (path && path.length > 2 && !mentionedPaths.includes(path)) {
        // Clean up path - remove trailing punctuation
        const cleanPath = path.replace(/[.,;:!?]+$/, '')
        if (cleanPath.length > 2) {
          mentionedPaths.push(cleanPath)
        }
      }
    }
  }

  // Extract technical terms
  for (const pattern of TECHNICAL_TERM_PATTERNS) {
    const matches = description.matchAll(new RegExp(pattern.source, pattern.flags))
    for (const match of matches) {
      const term = match[1]?.trim()
      if (term && term.length >= 3 && !DESCRIPTION_NOISE_WORDS.has(term.toLowerCase())) {
        if (!technicalConcepts.includes(term)) {
          technicalConcepts.push(term)
        }
      }
    }
  }

  // Extract key terms (significant words from the description)
  const words = description
    .replace(/[#*`_~[\](){}|<>]/g, ' ') // Remove markdown
    .replace(/https?:\/\/[^\s]+/g, ' ') // Remove URLs
    .split(/\s+/)
    .filter(word => {
      const lower = word.toLowerCase().replace(/[^a-z0-9]/g, '')
      return (
        lower.length >= 4 &&
        !DESCRIPTION_NOISE_WORDS.has(lower) &&
        !NOISE_KEYWORDS.has(lower) &&
        !/^\d+$/.test(lower) // Not purely numeric
      )
    })

  // Collect unique key terms
  const seenTerms = new Set<string>()
  for (const word of words) {
    const cleaned = word.replace(/[^a-zA-Z0-9_-]/g, '')
    const lower = cleaned.toLowerCase()
    if (cleaned.length >= 4 && !seenTerms.has(lower)) {
      seenTerms.add(lower)
      keyTerms.push(cleaned)
    }
  }

  // Generate summary - first meaningful paragraph or first 200 chars
  const paragraphs = description.split(/\n\s*\n/)
  let summary = ''

  for (const para of paragraphs) {
    const trimmed = para.trim()
    // Skip headers, lists starting with -, empty lines
    if (trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      summary = trimmed.slice(0, 200)
      if (trimmed.length > 200) {
        summary += '...'
      }
      break
    }
  }

  // If no good paragraph found, use first 200 chars
  if (!summary) {
    const cleaned = description.replace(/[#*`_~[\]]/g, '').trim()
    summary = cleaned.slice(0, 200)
    if (cleaned.length > 200) {
      summary += '...'
    }
  }

  return {
    summary,
    keyTerms: keyTerms.slice(0, 20), // Limit to top 20 key terms
    mentionedPaths: mentionedPaths.slice(0, 10), // Limit to 10 paths
    technicalConcepts: technicalConcepts.slice(0, 15), // Limit to 15 concepts
  }
}

/**
 * Generate semantic queries from PR description information.
 *
 * Combines key terms, file paths, and technical concepts into
 * search queries that can bias the semantic context retrieval
 * toward code relevant to the PR's stated intent.
 */
export function extractQueriesFromPrDescription(descriptionInfo: PrDescriptionInfo | null): string[] {
  if (!descriptionInfo) {
    return []
  }

  const queries: string[] = []

  // Add mentioned file paths as high-priority queries
  for (const path of descriptionInfo.mentionedPaths) {
    // Extract meaningful parts from the path
    const parts = path.split('/').filter(p => p.length > 2)
    if (parts.length > 0) {
      // Add the full path
      queries.push(path)
      // Add the filename without extension
      const filename = parts[parts.length - 1]
      const baseName = filename.replace(/\.[^.]+$/, '')
      if (baseName.length > 2 && !queries.includes(baseName)) {
        queries.push(baseName)
      }
    }
  }

  // Add technical concepts
  for (const concept of descriptionInfo.technicalConcepts) {
    if (!queries.includes(concept)) {
      queries.push(concept)
    }
  }

  // Add key terms (limited to avoid noise)
  const keyTermsToAdd = descriptionInfo.keyTerms.slice(0, 5)
  for (const term of keyTermsToAdd) {
    if (!queries.includes(term)) {
      queries.push(term)
    }
  }

  // Deduplicate and limit
  const uniqueQueries = [...new Set(queries)]
    .filter(q => q.length >= 3 && q.length < 100)
    .slice(0, MAX_DESCRIPTION_QUERIES)

  return uniqueQueries
}

/**
 * Patterns for extracting function, class, and method names from various languages.
 */
const FUNCTION_PATTERNS = [
  // JavaScript/TypeScript
  /function\s+(\w+)\s*[<(]/, // function declarations: function foo( or function foo<
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/, // arrow function assignments
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, // function expression assignments
  /class\s+(\w+)/, // class declarations
  /interface\s+(\w+)/, // interface declarations
  /type\s+(\w+)\s*[=<]/, // type declarations with = or <
  /(\w+)\s*:\s*(?:async\s+)?function/, // object method shorthand
  /(\w+)\s*\([^)]*\)\s*\{/, // method definitions in classes
  // Python
  /def\s+(\w+)\s*\(/, // function definitions
  /class\s+(\w+)\s*[:(]/, // class definitions
  /async\s+def\s+(\w+)\s*\(/, // async function definitions
  // Go
  /func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, // function declarations
  /func\s+\([^)]+\)\s*(\w+)\s*\(/, // method declarations
  /type\s+(\w+)\s+(?:struct|interface)/, // struct/interface declarations
  // Rust
  /fn\s+(\w+)\s*[<(]/, // function declarations
  /struct\s+(\w+)/, // struct declarations
  /enum\s+(\w+)/, // enum declarations
  /trait\s+(\w+)/, // trait declarations
  /impl\s+(?:<[^>]+>\s*)?(\w+)/, // impl blocks
  // Java/C#/Kotlin
  /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:suspend\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)/, // methods with access modifier
  /(?:data\s+)?class\s+(\w+)/, // class declarations with optional data modifier
  /object\s+(\w+)/, // Kotlin object declarations
]

/**
 * Patterns for extracting import statements and finding related modules.
 */
const IMPORT_PATTERNS = [
  // JavaScript/TypeScript - named imports
  /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/, // import { foo, bar } from 'module'
  // JavaScript/TypeScript - default and namespace imports
  /import\s+(?:(\w+)|(\*\s+as\s+\w+))\s+from\s+['"]([^'"]+)['"]/, // import foo from 'module' or import * as foo from 'module'
  // JavaScript/TypeScript - simple path imports
  /import\s+['"]([^'"]+)['"]/, // import 'module' (side effect only)
  // CommonJS
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/, // require('module')
  // Python
  /from\s+([\w.]+)\s+import\s+(.+)/, // from module import foo, bar
  /import\s+([\w.]+)(?:\s+as\s+\w+)?/, // import module or import module as alias
  // Go
  /import\s+"([^"]+)"/, // import "module"
  /import\s+\w+\s+"([^"]+)"/, // import alias "module"
  // Rust
  /use\s+([\w:]+)(?:::\{([^}]+)\})?/, // use crate::module or use crate::module::{foo, bar}
  // Java
  /import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/, // import com.example.Class;
]

/**
 * Patterns for extracting type annotations and generic type parameters.
 */
const TYPE_ANNOTATION_PATTERNS = [
  // TypeScript type annotations - various endings
  /:\s*(\w+)(?:<[^>]+>)?(?:\s*[=;,)\]}|&])/, // : TypeName followed by =;,)]}|&
  /:\s*(\w+)(?:<[^>]+>)?\s*\{/, // : TypeName { (function return type before body)
  /:\s*(\w+)\s*$/, // : TypeName at end of line
  // Promise, Array, and other generic wrappers
  /:\s*Promise<(\w+)>/, // : Promise<Type>
  /:\s*Array<(\w+)>/, // : Array<Type>
  /:\s*Map<\w+,\s*(\w+)>/, // : Map<K, V> - extract V
  /:\s*Set<(\w+)>/, // : Set<Type>
  // Field type annotations (private/readonly etc)
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?(?:\w+\s+)?(\w+):\s*(\w+)/, // private client: Type
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+):\s*(\w+)/, // private readonly field: Type
  // Type casting/assertions
  /as\s+(\w+)(?:<[^>]+>)?/, // as Type or as Type<T>
  /<(\w+)(?:,\s*\w+)*>/, // Generic type parameters <T> or <T, U>
  // Type assertions and casts
  /\((\w+)\)\s*\w+/, // (Type)variable - Java/C# style cast
  // Implements/extends
  /implements\s+([\w,\s]+)/, // implements Interface1, Interface2
  /extends\s+(\w+)/, // extends BaseClass
  // Python type hints
  /->\s*(\w+)(?:[:\s[]|$)/, // -> ReturnType: or -> ReturnType[ or end of line
  /:\s*(\w+)(?:\[[\w,\s]+\])?\s*=/, // variable: Type = value (with optional generic)
  // Go interface implementation
  /\.\((\w+)\)/, // type assertion .(Type)
]

/**
 * Patterns for extracting string literals that look like identifiers.
 * These capture event names, config keys, route paths, etc.
 */
const STRING_IDENTIFIER_PATTERNS = [
  // Event names: 'user:created', 'onClick', 'onSubmit', 'data-loaded'
  /['"]([a-z][a-zA-Z]*:[a-z][a-zA-Z]+)['"]/, // namespaced events: 'user:created'
  /['"]on[A-Z]\w+['"]/, // React-style event handlers: 'onClick'
  /on\(['"](\w+)['"]/, // .on('event') pattern
  /emit\(['"](\w+)['"]/, // .emit('event') pattern
  /addEventListener\(['"](\w+)['"]/, // addEventListener('event')
  // Config keys and action types
  /['"]([A-Z][A-Z_]+[A-Z])['"]/, // CONSTANT_CASE strings: 'USER_LOGGED_IN'
  /action:\s*['"](\w+)['"]/, // action: 'actionName'
  /type:\s*['"](\w+)['"]/, // type: 'typeName'
  // API routes and endpoints
  /['"]\/api\/(\w+)/, // API routes: '/api/users'
  /['"]\/(\w+\/\w+)['"]/, // Path patterns: '/users/profile'
  // GraphQL and database
  /query\s+(\w+)/, // GraphQL query names
  /mutation\s+(\w+)/, // GraphQL mutation names
  /(?:table|collection):\s*['"](\w+)['"]/, // Database table/collection names
]

/**
 * Extract named imports from an import statement.
 * E.g., "{ foo, bar as baz, qux }" -> ['foo', 'baz', 'qux']
 */
function extractNamedImports(namedPart: string): string[] {
  const names: string[] = []
  const parts = namedPart.split(',').map(p => p.trim())
  for (const part of parts) {
    // Handle "foo as bar" -> extract "bar"
    const asMatch = part.match(/(\w+)\s+as\s+(\w+)/)
    if (asMatch) {
      names.push(asMatch[2])
    } else {
      const name = part.match(/^(\w+)/)
      if (name) {
        names.push(name[1])
      }
    }
  }
  return names
}

/**
 * Clean up an import path for use as a search query.
 */
function cleanImportPath(importPath: string): string {
  return importPath
    .replace(/^@/, '') // Remove @ prefix (scoped packages)
    .replace(/^\.+\//, '') // Remove relative path prefixes
    .replace(/\//g, ' ') // Replace slashes with spaces
    .replace(/\.(js|ts|tsx|jsx|py|go|rs|java|kt)$/, '') // Remove extensions
    .trim()
}

/**
 * Check if an identifier is meaningful (not a noise keyword, not too short).
 */
function isMeaningfulIdentifier(name: string): boolean {
  if (!name || name.length < 3) return false
  if (NOISE_KEYWORDS.has(name.toLowerCase())) return false
  // Skip single uppercase letters (generic type params like T, K, V)
  if (/^[A-Z]$/.test(name)) return false
  // Skip purely numeric strings
  if (/^\d+$/.test(name)) return false
  return true
}

/**
 * Represents a diff hunk with its context and extracted queries.
 */
interface DiffHunk {
  filename: string
  startLine: number
  queries: string[]
  codeSnippet: string
}

/**
 * Parse diff into hunks for contextual query extraction.
 */
function parseDiffIntoHunks(diffContent: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = diffContent.split('\n')

  let currentFile = ''
  let currentHunk: DiffHunk | null = null
  let hunkLines: string[] = []

  for (const line of lines) {
    // Match file header
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (fileMatch) {
      // Save previous hunk if exists
      if (currentHunk && hunkLines.length > 0) {
        currentHunk.codeSnippet = hunkLines.join('\n').slice(0, 500)
        hunks.push(currentHunk)
      }
      currentFile = fileMatch[2]
      currentHunk = null
      hunkLines = []
      continue
    }

    // Match hunk header
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      // Save previous hunk if exists
      if (currentHunk && hunkLines.length > 0) {
        currentHunk.codeSnippet = hunkLines.join('\n').slice(0, 500)
        hunks.push(currentHunk)
      }
      currentHunk = {
        filename: currentFile,
        startLine: parseInt(hunkMatch[1], 10),
        queries: [],
        codeSnippet: ''
      }
      hunkLines = []
      continue
    }

    // Skip file headers
    if (line.startsWith('+++') || line.startsWith('---') ||
        line.startsWith('index ') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('Binary')) {
      continue
    }

    // Collect changed lines for the hunk
    if (currentHunk && (line.startsWith('+') || line.startsWith('-'))) {
      const codeLine = line.slice(1)
      hunkLines.push(codeLine)
    }
  }

  // Don't forget the last hunk
  if (currentHunk && hunkLines.length > 0) {
    currentHunk.codeSnippet = hunkLines.join('\n').slice(0, 500)
    hunks.push(currentHunk)
  }

  return hunks
}

/**
 * Extract queries from a single line of code.
 */
function extractQueriesFromLine(codeLine: string): string[] {
  const queries: string[] = []

  // Extract function/class/method names
  for (const pattern of FUNCTION_PATTERNS) {
    const match = codeLine.match(pattern)
    if (match) {
      // Check all capture groups
      for (let i = 1; i < match.length; i++) {
        if (match[i] && isMeaningfulIdentifier(match[i])) {
          queries.push(match[i])
        }
      }
    }
  }

  // Extract type annotations
  for (const pattern of TYPE_ANNOTATION_PATTERNS) {
    const matches = codeLine.matchAll(new RegExp(pattern, 'g'))
    for (const match of matches) {
      // Handle patterns that capture multiple types (like implements)
      const captured = match[1]
      if (captured) {
        // Split by comma for patterns like "implements A, B, C"
        const types = captured.split(',').map(t => t.trim())
        for (const type of types) {
          if (isMeaningfulIdentifier(type)) {
            queries.push(type)
          }
        }
      }
    }
  }

  // Extract imports
  for (const pattern of IMPORT_PATTERNS) {
    const match = codeLine.match(pattern)
    if (match) {
      // Handle named imports (capture group with curly braces content)
      for (let i = 1; i < match.length; i++) {
        const captured = match[i]
        if (!captured) continue

        // Check if this looks like named imports
        if (captured.includes(',') || /^\w+$/.test(captured.trim())) {
          const names = extractNamedImports(captured)
          for (const name of names) {
            if (isMeaningfulIdentifier(name)) {
              queries.push(name)
            }
          }
        }

        // Also extract the module path as a query
        if (captured.includes('/') || captured.includes('.') || captured.length > 2) {
          const cleanPath = cleanImportPath(captured)
          if (cleanPath.length > 2) {
            queries.push(cleanPath)
          }
        }
      }
    }
  }

  // Extract string literal identifiers
  for (const pattern of STRING_IDENTIFIER_PATTERNS) {
    const match = codeLine.match(pattern)
    if (match && match[1] && isMeaningfulIdentifier(match[1])) {
      queries.push(match[1])
    }
  }

  return queries
}

/**
 * Generate a semantic query from a hunk's context.
 * This creates a natural language-like query based on the hunk content.
 */
function generateSemanticQueryFromHunk(hunk: DiffHunk): string | null {
  // Extract key identifiers from the hunk
  const identifiers = hunk.queries.slice(0, 5).filter(q => q.length < 50)

  if (identifiers.length === 0) {
    return null
  }

  // Create a semantic query that combines the file context with identifiers
  const fileBase = hunk.filename.split('/').pop()?.replace(/\.[^.]+$/, '') || ''

  if (fileBase && identifiers.length > 0) {
    // Combine file name with key identifiers
    return `${fileBase} ${identifiers.join(' ')}`
  }

  return identifiers.join(' ')
}

/**
 * Extract meaningful queries from a diff for semantic search.
 *
 * Enhanced strategy:
 * 1. Process both additions AND deletions (renamed/refactored code)
 * 2. Extract function/class/method names with expanded patterns
 * 3. Extract import statements and named imports
 * 4. Extract type annotations and interface names
 * 5. Extract string literals that look like identifiers (event names, config keys)
 * 6. Generate semantic queries per diff hunk for better context
 */
export function extractQueriesFromDiff(diffContent: string): string[] {
  const allQueries: string[] = []
  const lines = diffContent.split('\n')

  // Parse into hunks for contextual extraction
  const hunks = parseDiffIntoHunks(diffContent)

  // Process each line for query extraction
  for (const line of lines) {
    // Skip file headers and metadata
    if (line.startsWith('diff --git') || line.startsWith('+++') ||
        line.startsWith('---') || line.startsWith('index ') ||
        line.startsWith('@@') || line.startsWith('new file') ||
        line.startsWith('deleted file') || line.startsWith('Binary')) {
      continue
    }

    // Process both additions (+) AND deletions (-) for better context
    // Renamed/refactored code often has valuable identifiers in deletions
    if ((line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') && !line.startsWith('---')) {
      const codeLine = line.slice(1)
      const lineQueries = extractQueriesFromLine(codeLine)
      allQueries.push(...lineQueries)
    }
  }

  // Generate semantic queries from hunks
  for (const hunk of hunks) {
    // Extract queries from hunk content
    const hunkContent = hunk.codeSnippet
    for (const line of hunkContent.split('\n')) {
      const lineQueries = extractQueriesFromLine(line)
      hunk.queries.push(...lineQueries)
    }

    // Generate a semantic query combining hunk context
    const semanticQuery = generateSemanticQueryFromHunk(hunk)
    if (semanticQuery) {
      allQueries.push(semanticQuery)
    }
  }

  // Add significant code snippets from additions (for semantic similarity)
  const addedCode: string[] = []
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedCode.push(line.slice(1))
    }
  }

  if (addedCode.length > 0) {
    const codeSnippet = addedCode.slice(0, 20).join('\n').slice(0, 500)
    if (codeSnippet.length > 50) {
      allQueries.push(codeSnippet)
    }
  }

  // Deduplicate, filter, and limit
  const uniqueQueries = [...new Set(allQueries)]
    .filter(q => q.length >= 3 && q.length < 600) // Filter very short and very long queries

  // Prioritize: identifiers first, then longer queries (code snippets)
  const sortedQueries = uniqueQueries.sort((a, b) => {
    // Prefer shorter, identifier-like queries
    const aIsIdentifier = /^\w+$/.test(a)
    const bIsIdentifier = /^\w+$/.test(b)
    if (aIsIdentifier && !bIsIdentifier) return -1
    if (!aIsIdentifier && bIsIdentifier) return 1
    return a.length - b.length
  })

  return sortedQueries.slice(0, 15) // Increased limit to 15 for richer context
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
 * Weighted chunks are annotated to indicate they contain modified code, are test files,
 * or match PR description intent.
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
    if (chunk.matchesDescriptionIntent) {
      annotations.push('PR_INTENT')
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
 * Extract code content grouped by file from a diff.
 * This is used to provide code context for file-type strategy analysis.
 */
export function extractCodeByFileFromDiff(diffContent: string): Map<string, string> {
  const codeByFile = new Map<string, string>()
  const lines = diffContent.split('\n')

  let currentFile = ''
  let currentCode: string[] = []

  for (const line of lines) {
    // Match file header
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (fileMatch) {
      // Save previous file's code
      if (currentFile && currentCode.length > 0) {
        codeByFile.set(currentFile, currentCode.join('\n'))
      }
      currentFile = fileMatch[2]
      currentCode = []
      continue
    }

    // Skip file headers and metadata
    if (line.startsWith('+++') || line.startsWith('---') ||
        line.startsWith('index ') || line.startsWith('@@') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('Binary')) {
      continue
    }

    // Collect code content (both additions and context)
    if (currentFile && (line.startsWith('+') || line.startsWith(' '))) {
      currentCode.push(line.slice(1))
    }
  }

  // Don't forget the last file
  if (currentFile && currentCode.length > 0) {
    codeByFile.set(currentFile, currentCode.join('\n'))
  }

  return codeByFile
}

/**
 * Apply file-type specific strategies to enhance context retrieval.
 *
 * This function:
 * 1. Identifies the file type for each modified file
 * 2. Extracts priority queries (type definitions, imports, base classes, etc.)
 * 3. Searches for related files (e.g., __init__.py, index.ts, _variables.scss)
 * 4. Returns additional queries and priority chunk IDs
 */
async function applyFileTypeStrategies(
  parsedDiff: ParsedDiff,
  codeByFile: Map<string, string>,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<StrategyResult> {
  const additionalQueries: string[] = []
  const priorityChunkIds = new Set<string>()
  const relatedFilesSearched: string[] = []

  // Track which strategies are being used for logging
  const strategiesUsed = new Map<string, number>()

  // Process each modified file
  for (const filename of parsedDiff.fileChanges.keys()) {
    const strategy = getStrategyForFile(filename)
    const fileType = getFileType(filename)

    // Skip generic files (no special handling)
    if (fileType === 'generic') {
      continue
    }

    // Track strategy usage
    strategiesUsed.set(fileType, (strategiesUsed.get(fileType) || 0) + 1)

    const code = codeByFile.get(filename) || ''

    if (code.length === 0) {
      continue
    }

    // Extract priority queries (type definitions, base classes, etc.)
    const priorityQueries = extractPriorityQueries(code, strategy)
    for (const { query } of priorityQueries.slice(0, MAX_FILE_TYPE_PRIORITY_QUERIES)) {
      if (!additionalQueries.includes(query)) {
        additionalQueries.push(query)
      }
    }

    // Extract additional queries using strategy-specific patterns
    const strategyQueries = extractQueriesUsingStrategy(code, strategy)
    for (const query of strategyQueries.slice(0, 5)) {
      if (!additionalQueries.includes(query)) {
        additionalQueries.push(query)
      }
    }

    // Search for related files (e.g., __init__.py, types.ts, _variables.scss)
    const relatedPaths = generateRelatedFilePaths(filename, strategy)
    for (const relatedPath of relatedPaths.slice(0, 5)) {
      if (relatedFilesSearched.includes(relatedPath)) {
        continue
      }
      relatedFilesSearched.push(relatedPath)

      try {
        const results = await client.search(`file:${relatedPath}`, repoUrl, 2, branch)
        for (const chunk of results) {
          const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
          priorityChunkIds.add(id)
        }
      } catch {
        // Ignore search errors for related files
      }
    }
  }

  // Log strategy usage
  if (strategiesUsed.size > 0) {
    const strategyLog = Array.from(strategiesUsed.entries())
      .map(([type, count]) => `${type}: ${count}`)
      .join(', ')
    logger.debug(`File-type strategies applied: ${strategyLog}`)
  }

  if (additionalQueries.length > 0) {
    logger.debug(`File-type strategies generated ${additionalQueries.length} additional queries`)
  }

  if (relatedFilesSearched.length > 0) {
    logger.debug(`File-type strategies searched ${relatedFilesSearched.length} related files`)
  }

  return {
    additionalQueries,
    priorityChunkIds,
    relatedFilesSearched,
  }
}

/**
 * Apply file-type strategy weighting to chunks.
 * Chunks that match priority files (type definitions, base classes, etc.) get boosted.
 */
function applyFileTypeStrategyWeighting(
  chunks: WeightedCodeChunk[],
  strategyResult: StrategyResult
): WeightedCodeChunk[] {
  if (strategyResult.priorityChunkIds.size === 0) {
    return chunks
  }

  return chunks.map(chunk => {
    const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`

    if (strategyResult.priorityChunkIds.has(id)) {
      // Get the strategy for this chunk's file type
      const strategy = getStrategyForFile(chunk.filename)
      const priorityWeight = strategy.priorityWeight

      return {
        ...chunk,
        score: chunk.score * priorityWeight,
        weightMultiplier: chunk.weightMultiplier * priorityWeight,
      }
    }

    return chunk
  })
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
 *
 * PR/MR description is used to bias context retrieval toward relevant
 * subsystems with a 1.3x weight multiplier.
 *
 * File-type specific strategies are applied to prioritize relevant context:
 * - TypeScript/JavaScript: type definitions, imported modules
 * - Python: __init__.py, base classes, decorators
 * - Go: interface definitions, package documentation
 * - CSS/SCSS: variable definitions, mixins
 */
export async function getSemanticContext(
  options: SemanticContextOptions
): Promise<string | null> {
  const { diffContent, repoUrl, branch, topK, maxTokens, prDescription, fileTypeStrategyOverrides } = options

  // Apply any user-configured strategy overrides
  if (fileTypeStrategyOverrides) {
    // Convert the config type to the strategy type
    const overrides: StrategyOverrides = {
      priorityWeights: fileTypeStrategyOverrides.priorityWeights,
      disabledStrategies: fileTypeStrategyOverrides.disabledStrategies as StrategyOverrides['disabledStrategies'],
      extensionMappings: fileTypeStrategyOverrides.extensionMappings as StrategyOverrides['extensionMappings'],
    }
    applyStrategyOverrides(overrides)
  }

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
  const diffQueries = extractQueriesFromDiff(diffContent)

  // Extract queries from PR description for intent biasing
  const descriptionInfo = extractPrDescriptionInfo(prDescription)
  const descriptionQueries = extractQueriesFromPrDescription(descriptionInfo)

  if (descriptionQueries.length > 0) {
    logger.debug(`Extracted ${descriptionQueries.length} queries from PR description`)
  }

  // Extract code content by file for file-type strategy analysis
  const codeByFile = extractCodeByFileFromDiff(diffContent)

  // Apply file-type specific strategies to get additional queries and priority chunks
  const strategyResult = await applyFileTypeStrategies(
    parsedDiff,
    codeByFile,
    client,
    repoUrl,
    branch
  )

  // Combine diff and description queries, keeping track of which are from description
  const descriptionQuerySet = new Set(descriptionQueries.map(q => q.toLowerCase()))
  const allQueries = [...diffQueries]

  // Add description queries that aren't already in diff queries
  for (const query of descriptionQueries) {
    if (!diffQueries.some(dq => dq.toLowerCase() === query.toLowerCase())) {
      allQueries.push(query)
    }
  }

  // Add file-type strategy queries that aren't already included
  for (const query of strategyResult.additionalQueries) {
    if (!allQueries.some(q => q.toLowerCase() === query.toLowerCase())) {
      allQueries.push(query)
    }
  }

  if (allQueries.length === 0) {
    logger.debug('No queries extracted from diff, description, or file-type strategies')
    return null
  }

  const ftQueryCount = strategyResult.additionalQueries.length
  logger.debug(`Total queries: ${allQueries.length} (${diffQueries.length} from diff, ${descriptionQueries.length} from description, ${ftQueryCount} from file-type strategies)`)

  // Search for each query and collect results
  // Track which chunks came from description queries for weighting
  const allChunks: CodeChunk[] = []
  const descriptionMatchedChunkIds = new Set<string>()
  const seenIds = new Set<string>()

  for (const query of allQueries) {
    const isDescriptionQuery = descriptionQuerySet.has(query.toLowerCase())

    try {
      const results = await client.search(query, repoUrl, topK, branch)

      for (const chunk of results) {
        // Deduplicate by file + line range
        const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
        if (!seenIds.has(id)) {
          seenIds.add(id)
          allChunks.push(chunk)

          // Track if this chunk was found via description query
          if (isDescriptionQuery) {
            descriptionMatchedChunkIds.add(id)
          }
        } else if (isDescriptionQuery) {
          // Mark existing chunk as also matching description
          descriptionMatchedChunkIds.add(id)
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
  let weightedChunks = applyModifiedLineWeighting(allChunks, parsedDiff)

  // Apply additional weight for description-matched chunks
  weightedChunks = weightedChunks.map(chunk => {
    const id = `${chunk.filename}:${chunk.startLine}-${chunk.endLine}`
    if (descriptionMatchedChunkIds.has(id)) {
      return {
        ...chunk,
        score: chunk.score * DESCRIPTION_WEIGHT_MULTIPLIER,
        weightMultiplier: chunk.weightMultiplier * DESCRIPTION_WEIGHT_MULTIPLIER,
        matchesDescriptionIntent: true,
      }
    }
    return chunk
  })

  // Apply file-type strategy weighting for priority chunks (type definitions, etc.)
  weightedChunks = applyFileTypeStrategyWeighting(weightedChunks, strategyResult)

  // Count how many chunks are from modified context and description intent
  const modifiedCount = weightedChunks.filter(c => c.isModifiedContext).length
  const descriptionCount = weightedChunks.filter(c => c.matchesDescriptionIntent).length
  const priorityCount = strategyResult.priorityChunkIds.size
  logger.debug(`Found ${modifiedCount} chunks overlapping with modified lines (weighted 2x)`)
  if (descriptionCount > 0) {
    logger.debug(`Found ${descriptionCount} chunks matching PR description intent (weighted 1.3x)`)
  }
  if (priorityCount > 0) {
    logger.debug(`Found ${priorityCount} priority chunks from file-type strategies`)
  }

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
  const selectedIntentCount = selectedChunks.filter(c => c.matchesDescriptionIntent).length

  // Build informative log message
  const parts = [`${selectedChunks.length} related code chunks`]
  if (selectedModifiedCount > 0) parts.push(`${selectedModifiedCount} modified`)
  if (selectedTestCount > 0) parts.push(`${selectedTestCount} test files`)
  if (selectedIntentCount > 0) parts.push(`${selectedIntentCount} PR intent`)
  parts.push(`${totalTokens} estimated tokens`)

  logger.info(`Including ${parts.join(', ')}`)

  return formatContext(selectedChunks)
}
