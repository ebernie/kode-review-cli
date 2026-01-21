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
