/**
 * Indexer configuration stored in config
 */
export interface IndexerConfig {
  /** Whether the indexer feature is enabled */
  enabled: boolean

  /** Docker Compose project name */
  composeProject: string

  /** Port for the indexer API */
  apiPort: number

  /** Port for the PostgreSQL database */
  dbPort: number

  /** Embedding model to use */
  embeddingModel: string

  /** Chunk size for code splitting */
  chunkSize: number

  /** Overlap between chunks */
  chunkOverlap: number

  /** Number of results to return from search */
  topK: number

  /** Maximum tokens for context */
  maxContextTokens: number

  /** File patterns to include */
  includedPatterns: string[]

  /** File patterns to exclude */
  excludedPatterns: string[]
}

/**
 * A chunk of code returned from the index
 */
export interface CodeChunk {
  /** Repository URL (for cross-repo results) */
  repoUrl?: string

  /** Branch this chunk is from */
  branch?: string

  /** File path relative to repo root */
  filename: string

  /** The code content */
  code: string

  /** Similarity score (0-1) */
  score: number

  /** Starting line number */
  startLine: number

  /** Ending line number */
  endLine: number
}

/**
 * Database schema types for the enhanced indexer
 */

/**
 * Represents a file tracked in the index
 */
export interface IndexedFile {
  /** File path relative to repo root (primary key) */
  filePath: string

  /** Last modification timestamp */
  lastModified: Date

  /** File size in bytes */
  size: number

  /** Programming language (e.g., 'typescript', 'python') */
  language: string | null

  /** Complexity score (optional metric) */
  complexityScore: number | null

  /** Repository identifier */
  repoId: string

  /** Repository URL */
  repoUrl: string

  /** Branch name */
  branch: string

  /** When the file was first indexed */
  createdAt: Date

  /** When the file was last updated in the index */
  updatedAt: Date
}

/**
 * Chunk type classification
 */
export type ChunkType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'constant'
  | 'import'
  | 'export'
  | 'comment'
  | 'config'
  | 'other'

/**
 * Configuration file type
 */
export type ConfigFileType =
  | 'typescript'   // tsconfig.json
  | 'eslint'       // eslint.config.*, .eslintrc.*
  | 'prettier'     // .prettierrc, prettier.config.*
  | 'package'      // package.json (partial)
  | 'python'       // pyproject.toml, setup.py, setup.cfg
  | 'go'           // go.mod, go.sum
  | 'rust'         // Cargo.toml
  | 'editor'       // .editorconfig
  | 'docker'       // Dockerfile, docker-compose.*
  | 'ci'           // .github/workflows/*, .gitlab-ci.yml
  | 'generic'      // Other config files

/**
 * Metadata extracted from configuration files
 */
export interface ConfigMetadata {
  /** Type of configuration file */
  configType: ConfigFileType

  /** Whether strict mode is enabled (TypeScript, ESLint) */
  strictMode?: boolean

  /** Key lint rules enabled */
  lintRules?: string[]

  /** Key dependencies (from package.json) */
  dependencies?: string[]

  /** Dev dependencies (from package.json) */
  devDependencies?: string[]

  /** Target version (TypeScript, Go, Python) */
  targetVersion?: string

  /** Module type (ESM, CommonJS) */
  moduleType?: string

  /** Compiler/interpreter options */
  compilerOptions?: Record<string, unknown>
}

/**
 * Represents a code chunk stored in the database with full metadata
 */
export interface IndexedChunk {
  /** UUID primary key */
  id: string

  /** File path this chunk belongs to */
  filePath: string

  /** The actual code content */
  content: string

  /** Vector embedding (1536 dimensions) - null if not yet computed */
  embedding: number[] | null

  /** Programming language */
  language: string | null

  /** Type of code construct */
  chunkType: ChunkType | null

  /** Symbol names defined in this chunk (functions, classes, variables) */
  symbolNames: string[]

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** Modules/packages imported by this chunk */
  imports: string[]

  /** Symbols exported by this chunk */
  exports: string[]

  /** Repository identifier */
  repoId: string

  /** Repository URL */
  repoUrl: string

  /** Branch name */
  branch: string

  /** When this chunk was indexed */
  createdAt: Date
}

/**
 * Relationship types between code chunks
 */
export type RelationshipType =
  | 'imports'      // Source imports from target
  | 'calls'        // Source calls function in target
  | 'extends'      // Source extends/inherits target
  | 'implements'   // Source implements interface from target
  | 'references'   // Source references symbol from target
  | 'contains'     // Source contains target (e.g., class contains method)

/**
 * Represents a relationship between two code chunks
 */
export interface ChunkRelationship {
  /** UUID of the source chunk */
  sourceChunkId: string

  /** UUID of the target chunk */
  targetChunkId: string

  /** Type of relationship */
  relationshipType: RelationshipType

  /** Additional metadata about the relationship */
  metadata?: Record<string, unknown>

  /** When this relationship was created */
  createdAt: Date
}

/**
 * Input for creating a new file record
 */
export interface CreateFileInput {
  filePath: string
  size: number
  language?: string
  complexityScore?: number
  repoId: string
  repoUrl: string
  branch: string
}

/**
 * Input for creating a new chunk record
 */
export interface CreateChunkInput {
  filePath: string
  content: string
  embedding?: number[]
  language?: string
  chunkType?: ChunkType
  symbolNames?: string[]
  lineStart: number
  lineEnd: number
  imports?: string[]
  exports?: string[]
  repoId: string
  repoUrl: string
  branch: string
}

/**
 * Input for creating a relationship between chunks
 */
export interface CreateRelationshipInput {
  sourceChunkId: string
  targetChunkId: string
  relationshipType: RelationshipType
  metadata?: Record<string, unknown>
}

/**
 * Search result from the indexer
 */
export interface SearchResult {
  /** Query that was searched */
  query: string

  /** Matching code chunks */
  chunks: CodeChunk[]
}

/**
 * Statistics about an indexed repository
 */
export interface IndexStats {
  /** Repository URL/identifier */
  repoUrl: string

  /** Short hash identifier for the repository */
  repoId: string

  /** Branch name */
  branch: string

  /** Number of indexed chunks */
  chunkCount: number

  /** Number of indexed files */
  fileCount: number

  /** Last indexed timestamp */
  lastIndexed: string | null

  /** Index status */
  status: 'indexed' | 'indexing' | 'error' | 'not_indexed'
}

/**
 * Indexer service status
 */
export interface IndexerStatus {
  /** Whether the indexer is running */
  running: boolean

  /** API URL if running */
  apiUrl: string | null

  /** Health check status */
  healthy: boolean

  /** Docker container status */
  containerStatus: 'running' | 'stopped' | 'not_found'

  /** Database container status */
  dbStatus: 'running' | 'stopped' | 'not_found'
}

/**
 * Options for incremental indexing
 */
export interface IncrementalIndexOptions {
  /** Git reference to diff against (default: HEAD~1) */
  baseRef?: string

  /** Explicit list of changed files (alternative to git diff) */
  changedFiles?: string[]
}

/**
 * File-type strategy overrides from configuration
 */
export interface FileTypeStrategyOverrides {
  /** Override priority weight for specific file types */
  priorityWeights?: Record<string, number>

  /** Disable specific strategies */
  disabledStrategies?: string[]

  /** Custom extension mappings (e.g., { '.mts': 'typescript' }) */
  extensionMappings?: Record<string, string>
}

/**
 * Options for retrieving semantic context
 */
export interface SemanticContextOptions {
  /** Diff content to extract queries from */
  diffContent: string

  /** Repository URL for scoping search */
  repoUrl: string

  /** Branch to scope search (optional) */
  branch?: string

  /** Number of similar chunks to retrieve */
  topK: number

  /** Maximum tokens for context */
  maxTokens: number

  /** PR/MR description to extract intent and bias context retrieval */
  prDescription?: string

  /** File-type strategy overrides from configuration */
  fileTypeStrategyOverrides?: FileTypeStrategyOverrides
}

/**
 * Extracted information from a PR/MR description
 */
export interface PrDescriptionInfo {
  /** Summary of what the PR is trying to accomplish */
  summary: string

  /** Key terms extracted from the description */
  keyTerms: string[]

  /** File paths or module names mentioned */
  mentionedPaths: string[]

  /** Technical concepts and components referenced */
  technicalConcepts: string[]
}

/**
 * Information about an indexed repository
 */
export interface RepoInfo {
  /** Repository URL */
  repoUrl: string

  /** Short hash identifier */
  repoId: string

  /** Branches indexed for this repo */
  branches: string[]

  /** Total chunks across all branches */
  totalChunks: number

  /** Total files across all branches */
  totalFiles: number
}

/**
 * A location where a symbol is defined
 */
export interface DefinitionLocation {
  /** File path relative to repo root */
  filePath: string

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** The code content containing the definition */
  content: string

  /** Type of code construct (function, class, etc.) */
  chunkType: ChunkType | null

  /** Whether this is a re-export rather than the original definition */
  isReexport: boolean

  /** If this is a re-export, the source file it's re-exported from */
  reexportSource: string | null
}

/**
 * Response from a symbol definition lookup
 */
export interface DefinitionLookupResult {
  /** The symbol that was looked up */
  symbol: string

  /** All locations where the symbol is defined or re-exported */
  definitions: DefinitionLocation[]

  /** Total number of definitions found */
  totalCount: number
}

/**
 * A location where a symbol is used (called, imported, or referenced)
 */
export interface UsageLocation {
  /** File path relative to repo root */
  filePath: string

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** The code content containing the usage */
  content: string

  /** Type of code construct (function, class, etc.) */
  chunkType: ChunkType | null

  /** How the symbol is used: 'calls', 'imports', or 'references' */
  usageType: 'calls' | 'imports' | 'references'

  /** Whether this is a dynamic import or lazy-loaded reference (flagged as uncertain) */
  isDynamic: boolean
}

/**
 * Response from a symbol usage lookup
 */
export interface UsageLookupResult {
  /** The symbol that was looked up */
  symbol: string

  /** All locations where the symbol is used */
  usages: UsageLocation[]

  /** Total number of usages found */
  totalCount: number
}

/**
 * Type of change for a modified line
 */
export type ChangeType = 'addition' | 'deletion' | 'modification'

/**
 * Represents a modified line extracted from a git diff
 */
export interface ModifiedLine {
  /** File path (relative to repo root) */
  filename: string

  /** Line number in the new file (for additions/modifications) or old file (for deletions) */
  lineNumber: number

  /** The actual line content (without the +/- prefix) */
  content: string

  /** Type of change */
  changeType: ChangeType
}

/**
 * Parsed diff information containing all modified lines grouped by file
 */
export interface ParsedDiff {
  /** All modified lines across all files */
  modifiedLines: ModifiedLine[]

  /** Files that have changes, mapped to their line ranges */
  fileChanges: Map<string, { additions: number[]; deletions: number[]; modifications: number[] }>
}

/**
 * Code chunk with weighted score for prioritization
 */
export interface WeightedCodeChunk extends CodeChunk {
  /** Original similarity score before weighting */
  originalScore: number

  /** Weight multiplier applied (1.0 for no boost, 2.0 for modified lines) */
  weightMultiplier: number

  /** Whether this chunk overlaps with modified lines */
  isModifiedContext: boolean

  /** Whether this chunk is from a test file */
  isTestFile?: boolean

  /** The source file this test file is related to (if isTestFile is true) */
  relatedSourceFile?: string

  /** Whether this chunk matches PR description intent */
  matchesDescriptionIntent?: boolean
}

// ============================================================================
// Import Chain Tracking Types
// ============================================================================

/**
 * 2-level import tree for a file showing its dependencies and dependents
 */
export interface ImportTree {
  /** The file this tree is for */
  targetFile: string

  /** Files this file directly imports (level 1) */
  directImports: string[]

  /** Files that directly import this file (level 1) */
  directImporters: string[]

  /** Files that direct imports import (level 2) */
  indirectImports: string[]

  /** Files that import the direct importers (level 2) */
  indirectImporters: string[]
}

/**
 * Information about a circular dependency in the codebase
 */
export interface CircularDependency {
  /** Files in the cycle, in order (last element repeats first to show the cycle) */
  cycle: string[]

  /** Type of cycle: 'direct' (A->B->A) or 'indirect' (A->B->C->A) */
  cycleType: 'direct' | 'indirect'
}

/**
 * Response from circular dependencies detection
 */
export interface CircularDependenciesResult {
  /** Repository URL */
  repoUrl: string

  /** Branch analyzed */
  branch: string

  /** List of circular dependencies found */
  circularDependencies: CircularDependency[]

  /** Total count of circular dependencies */
  totalCount: number
}

/**
 * Information about a hub file (imported by many other files)
 */
export interface HubFile {
  /** File path */
  filePath: string

  /** Number of files that import this file */
  importCount: number

  /** Sample of files that import this hub file (up to 10) */
  importers: string[]
}

/**
 * Response from hub file detection
 */
export interface HubFilesResult {
  /** Repository URL */
  repoUrl: string

  /** Branch analyzed */
  branch: string

  /** List of hub files found */
  hubFiles: HubFile[]

  /** Total count of hub files */
  totalCount: number

  /** The threshold used for hub detection */
  threshold: number
}

// ============================================================================
// Keyword Search Types (BM25)
// ============================================================================

/**
 * A code chunk matched by BM25 keyword search
 */
export interface KeywordMatch {
  /** File path relative to repo root */
  filePath: string

  /** The code content */
  content: string

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** Type of code construct (function, class, etc.) */
  chunkType: ChunkType | null

  /** Symbol names defined in this chunk */
  symbolNames: string[]

  /** Raw BM25 score from PostgreSQL full-text search */
  bm25Score: number

  /** Boost multiplier applied for exact symbol matches (1.0 = no boost, 3.0 = exact match) */
  exactMatchBoost: number

  /** Final score (bm25Score * exactMatchBoost) */
  finalScore: number

  /** Repository URL */
  repoUrl?: string

  /** Branch name */
  branch?: string
}

/**
 * Response from keyword search
 */
export interface KeywordSearchResult {
  /** The original search query */
  query: string

  /** How the query was normalized for full-text search */
  normalizedQuery: string

  /** Matching code chunks */
  matches: KeywordMatch[]

  /** Total count of matches */
  totalCount: number
}

/**
 * Options for keyword search
 */
export interface KeywordSearchOptions {
  /** Search query (identifier or keywords) */
  query: string

  /** Optional repository URL to scope the search */
  repoUrl?: string

  /** Optional branch to scope the search */
  branch?: string

  /** Maximum number of results (default: 10) */
  limit?: number

  /** Multiplier for exact function/class name matches (default: 3.0) */
  exactMatchBoost?: number
}

// ============================================================================
// Hybrid Search Types (Vector + BM25 with RRF)
// ============================================================================

/**
 * A code chunk from hybrid search with combined scoring
 */
export interface HybridMatch {
  /** File path relative to repo root */
  filePath: string

  /** The code content */
  content: string

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** Type of code construct (function, class, etc.) */
  chunkType: ChunkType | null

  /** Symbol names defined in this chunk */
  symbolNames: string[]

  /** Repository URL */
  repoUrl?: string

  /** Branch name */
  branch?: string

  /** Vector similarity score (0-1) from embedding search */
  vectorScore: number

  /** Rank in vector search results (1-indexed, undefined if not in vector results) */
  vectorRank?: number

  /** BM25 keyword score with exact match boost */
  keywordScore: number

  /** Rank in keyword search results (1-indexed, undefined if not in keyword results) */
  keywordRank?: number

  /** Combined RRF (Reciprocal Rank Fusion) score */
  rrfScore: number

  /** Which search methods contributed to this result: ['vector'], ['keyword'], or ['vector', 'keyword'] */
  sources: Array<'vector' | 'keyword'>
}

/**
 * Response from hybrid search
 */
export interface HybridSearchResult {
  /** The original search query */
  query: string

  /** Quoted phrases extracted for exact matching */
  quotedPhrases: string[]

  /** Matching code chunks with combined scoring */
  matches: HybridMatch[]

  /** Total count of matches */
  totalCount: number

  /** Actual vector weight used (normalized) */
  vectorWeight: number

  /** Actual keyword weight used (normalized) */
  keywordWeight: number

  /** Whether fallback to pure vector search was used (keyword returned no results) */
  fallbackUsed: boolean
}

/**
 * Options for hybrid search
 */
export interface HybridSearchOptions {
  /** Search query (may contain quoted phrases for exact matching) */
  query: string

  /** Optional repository URL to scope the search */
  repoUrl?: string

  /** Optional branch to scope the search */
  branch?: string

  /** Maximum number of results (default: 10) */
  limit?: number

  /** Weight for vector similarity search (default: 0.6) */
  vectorWeight?: number

  /** Weight for keyword search (default: 0.4) */
  keywordWeight?: number

  /** Multiplier for exact symbol matches in keyword search (default: 3.0) */
  exactMatchBoost?: number
}

// ============================================================================
// Call Graph Types
// ============================================================================

/**
 * A node in the call graph representing a function/method
 */
export interface CallGraphNode {
  /** Chunk ID */
  id: string

  /** Function/method name */
  name: string

  /** File path relative to repo root */
  filePath: string

  /** Starting line number (1-indexed) */
  lineStart: number

  /** Ending line number (1-indexed) */
  lineEnd: number

  /** Distance from the queried function (0 = the function itself) */
  depth: number

  /** The code content (optional, populated when available) */
  content?: string
}

/**
 * An edge in the call graph representing a call relationship
 */
export interface CallGraphEdge {
  /** Caller chunk ID */
  sourceId: string

  /** Callee chunk ID */
  targetId: string

  /** Name of the called function */
  calleeName: string

  /** Line where the call occurs (if available) */
  lineNumber?: number

  /** Object receiver for method calls (e.g., 'this', 'myObject') */
  receiver?: string
}

/**
 * Direction for call graph queries
 */
export type CallGraphDirection = 'callers' | 'callees' | 'both'

/**
 * Response from a call graph query
 */
export interface CallGraphResult {
  /** The function that was queried */
  function: string

  /** Direction of the query */
  direction: CallGraphDirection

  /** Depth of traversal */
  depth: number

  /** All nodes in the call graph */
  nodes: CallGraphNode[]

  /** All edges representing call relationships */
  edges: CallGraphEdge[]

  /** Total number of nodes found */
  totalNodes: number

  /** Total number of edges found */
  totalEdges: number

  /** Flattened list of callers (nodes that call the function) */
  callers: CallGraphNode[]

  /** Flattened list of callees (nodes that the function calls) */
  callees: CallGraphNode[]
}

/**
 * Options for call graph queries
 */
export interface CallGraphOptions {
  /** The function name to query */
  function: string

  /** Direction: 'callers', 'callees', or 'both' (default: 'both') */
  direction?: CallGraphDirection

  /** How many levels deep to traverse (default: 2, max: 5) */
  depth?: number

  /** Repository URL to scope the search */
  repoUrl?: string

  /** Branch to scope the search (defaults to 'main') */
  branch?: string

  /** Maximum number of nodes to return (default: 100) */
  limit?: number
}
