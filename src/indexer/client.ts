import type {
  CodeChunk,
  IndexStats,
  RepoInfo,
  DefinitionLookupResult,
  UsageLookupResult,
  ChunkType,
  ImportTree,
  CircularDependenciesResult,
  HubFilesResult,
  KeywordSearchResult,
  KeywordMatch,
  HybridSearchResult,
  HybridMatch,
} from './types.js'

export interface IndexRequest {
  repoUrl: string
  repoPath: string
  branch?: string
  includePatterns: string[]
  excludePatterns: string[]
}

export interface SearchRequest {
  query: string
  repoUrl?: string  // Optional for cross-repo search
  branch?: string   // Optional branch filter
  limit?: number
}

// Response types for API calls
interface HealthResponse {
  status: string
  database: string
  embedding_model: string
}

interface IndexResponse {
  message: string
  status: string
}

interface SearchResponse {
  query: string
  chunks: Array<{
    repo_url?: string
    branch?: string
    filename: string
    code: string
    score: number
    start_line: number
    end_line: number
  }>
}

interface StatsResponse {
  repo_url: string
  repo_id: string
  branch: string
  chunk_count: number
  file_count: number
  last_indexed: string | null
  status: string
}

interface RepoInfoResponse {
  repo_url: string
  repo_id: string
  branches: string[]
  total_chunks: number
  total_files: number
}

interface ReposResponse {
  repos: RepoInfoResponse[]
}

interface DefinitionLocationResponse {
  file_path: string
  line_start: number
  line_end: number
  content: string
  chunk_type: string | null
  is_reexport: boolean
  reexport_source: string | null
}

interface DefinitionResponse {
  symbol: string
  definitions: DefinitionLocationResponse[]
  total_count: number
}

interface UsageLocationResponse {
  file_path: string
  line_start: number
  line_end: number
  content: string
  chunk_type: string | null
  usage_type: string
  is_dynamic: boolean
}

interface UsageResponse {
  symbol: string
  usages: UsageLocationResponse[]
  total_count: number
}

// Import Chain Tracking Response Types

interface ImportTreeResponse {
  target_file: string
  direct_imports: string[]
  direct_importers: string[]
  indirect_imports: string[]
  indirect_importers: string[]
}

interface CircularDependencyResponse {
  cycle: string[]
  cycle_type: string
}

interface CircularDependenciesResponse {
  repo_url: string
  branch: string
  circular_dependencies: CircularDependencyResponse[]
  total_count: number
}

interface HubFileResponse {
  file_path: string
  import_count: number
  importers: string[]
}

interface HubFilesResponse {
  repo_url: string
  branch: string
  hub_files: HubFileResponse[]
  total_count: number
  threshold: number
}

// Keyword Search Response Types

interface KeywordMatchResponse {
  file_path: string
  content: string
  line_start: number
  line_end: number
  chunk_type: string | null
  symbol_names: string[]
  bm25_score: number
  exact_match_boost: number
  final_score: number
  repo_url: string | null
  branch: string | null
}

interface KeywordSearchResponse {
  query: string
  normalized_query: string
  matches: KeywordMatchResponse[]
  total_count: number
}

// Hybrid Search Response Types

interface HybridMatchResponse {
  file_path: string
  content: string
  line_start: number
  line_end: number
  chunk_type: string | null
  symbol_names: string[]
  repo_url: string | null
  branch: string | null
  vector_score: number
  vector_rank: number | null
  keyword_score: number
  keyword_rank: number | null
  rrf_score: number
  sources: string[]
}

interface HybridSearchResponse {
  query: string
  quoted_phrases: string[]
  matches: HybridMatchResponse[]
  total_count: number
  vector_weight: number
  keyword_weight: number
  fallback_used: boolean
}

/**
 * HTTP client for the indexer API
 */
export class IndexerClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
  }

  /**
   * Check if the indexer is healthy
   */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return false
      }

      const data = (await response.json()) as HealthResponse
      return data.status === 'healthy'
    } catch {
      return false
    }
  }

  /**
   * Start indexing a repository
   */
  async index(request: IndexRequest): Promise<{ message: string; status: string; branch?: string }> {
    const response = await fetch(`${this.baseUrl}/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo_url: request.repoUrl,
        repo_path: request.repoPath,
        branch: request.branch,
        include_patterns: request.includePatterns,
        exclude_patterns: request.excludePatterns,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to start indexing: ${error}`)
    }

    return (await response.json()) as IndexResponse & { branch?: string }
  }

  /**
   * Search for similar code chunks
   *
   * @param query - Search query text
   * @param repoUrl - Optional repo URL to scope search
   * @param limit - Maximum number of results (default: 5)
   * @param branch - Optional branch to scope search
   */
  async search(
    query: string,
    repoUrl?: string,
    limit: number = 5,
    branch?: string
  ): Promise<CodeChunk[]> {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        repo_url: repoUrl,
        branch,
        limit,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Search failed: ${error}`)
    }

    const data = (await response.json()) as SearchResponse

    // Map snake_case to camelCase
    return data.chunks.map((chunk) => ({
      repoUrl: chunk.repo_url,
      branch: chunk.branch,
      filename: chunk.filename,
      code: chunk.code,
      score: chunk.score,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
    }))
  }

  /**
   * Get statistics for an indexed repository
   *
   * @param repoUrl - Repository URL
   * @param branch - Optional branch (defaults to 'main' on server)
   */
  async stats(repoUrl: string, branch?: string): Promise<IndexStats> {
    let url = `${this.baseUrl}/stats?repo_url=${encodeURIComponent(repoUrl)}`
    if (branch) {
      url += `&branch=${encodeURIComponent(branch)}`
    }

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get stats: ${error}`)
    }

    const data = (await response.json()) as StatsResponse

    return {
      repoUrl: data.repo_url,
      repoId: data.repo_id,
      branch: data.branch,
      chunkCount: data.chunk_count,
      fileCount: data.file_count,
      lastIndexed: data.last_indexed,
      status: data.status as IndexStats['status'],
    }
  }

  /**
   * Delete the index for a repository
   *
   * @param repoUrl - Repository URL to delete
   * @param branch - Optional branch to delete. If not provided, deletes ALL branches for this repo.
   */
  async deleteIndex(repoUrl: string, branch?: string): Promise<{ message: string; deleted_chunks?: number }> {
    let url = `${this.baseUrl}/index/${encodeURIComponent(repoUrl)}`
    if (branch) {
      url += `?branch=${encodeURIComponent(branch)}`
    }

    const response = await fetch(url, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to delete index: ${error}`)
    }

    return (await response.json()) as { message: string; deleted_chunks?: number }
  }

  /**
   * List all indexed repositories with their branches and stats
   */
  async listRepos(): Promise<RepoInfo[]> {
    const response = await fetch(`${this.baseUrl}/repos`, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to list repos: ${error}`)
    }

    const data = (await response.json()) as ReposResponse

    return data.repos.map((repo) => ({
      repoUrl: repo.repo_url,
      repoId: repo.repo_id,
      branches: repo.branches,
      totalChunks: repo.total_chunks,
      totalFiles: repo.total_files,
    }))
  }

  /**
   * Look up where a symbol is defined in the indexed codebase.
   *
   * This helps catch breaking changes by finding all locations where
   * a symbol (function, class, variable, etc.) is defined or re-exported.
   *
   * @param symbol - The symbol name to look up (e.g., 'MyClass', 'handleRequest')
   * @param repoUrl - Optional repository URL to scope the search
   * @param branch - Optional branch to scope the search
   * @param includeReexports - Whether to follow import chains for re-exports (default: true)
   * @param limit - Maximum number of results to return (default: 20)
   */
  async lookupDefinitions(
    symbol: string,
    repoUrl?: string,
    branch?: string,
    includeReexports: boolean = true,
    limit: number = 20
  ): Promise<DefinitionLookupResult> {
    const params = new URLSearchParams()
    if (repoUrl) {
      params.append('repo_url', repoUrl)
    }
    if (branch) {
      params.append('branch', branch)
    }
    params.append('include_reexports', String(includeReexports))
    params.append('limit', String(limit))

    const queryString = params.toString()
    const url = `${this.baseUrl}/definitions/${encodeURIComponent(symbol)}${queryString ? `?${queryString}` : ''}`

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to lookup definitions: ${error}`)
    }

    const data = (await response.json()) as DefinitionResponse

    // Map snake_case to camelCase
    return {
      symbol: data.symbol,
      definitions: data.definitions.map((def) => ({
        filePath: def.file_path,
        lineStart: def.line_start,
        lineEnd: def.line_end,
        content: def.content,
        chunkType: def.chunk_type as ChunkType | null,
        isReexport: def.is_reexport,
        reexportSource: def.reexport_source,
      })),
      totalCount: data.total_count,
    }
  }

  /**
   * Look up all usages of a symbol in the indexed codebase.
   *
   * This helps assess the impact of changes by finding all locations where
   * a symbol is called, imported, or referenced.
   *
   * @param symbol - The symbol name to look up (e.g., 'MyClass', 'handleRequest')
   * @param repoUrl - Optional repository URL to scope the search
   * @param branch - Optional branch to scope the search
   * @param limit - Maximum number of results to return (default: 50)
   */
  async lookupUsages(
    symbol: string,
    repoUrl?: string,
    branch?: string,
    limit: number = 50
  ): Promise<UsageLookupResult> {
    const params = new URLSearchParams()
    if (repoUrl) {
      params.append('repo_url', repoUrl)
    }
    if (branch) {
      params.append('branch', branch)
    }
    params.append('limit', String(limit))

    const queryString = params.toString()
    const url = `${this.baseUrl}/usages/${encodeURIComponent(symbol)}${queryString ? `?${queryString}` : ''}`

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to lookup usages: ${error}`)
    }

    const data = (await response.json()) as UsageResponse

    // Map snake_case to camelCase
    return {
      symbol: data.symbol,
      usages: data.usages.map((usage) => ({
        filePath: usage.file_path,
        lineStart: usage.line_start,
        lineEnd: usage.line_end,
        content: usage.content,
        chunkType: usage.chunk_type as ChunkType | null,
        usageType: usage.usage_type as 'calls' | 'imports' | 'references',
        isDynamic: usage.is_dynamic,
      })),
      totalCount: data.total_count,
    }
  }

  // ============================================================================
  // Import Chain Tracking Methods
  // ============================================================================

  /**
   * Get the 2-level import tree for a file.
   *
   * Returns what the file imports (and what those import),
   * and what imports the file (and what imports those).
   * This helps understand how changes to a file propagate through the codebase.
   *
   * @param filePath - The file path to get the import tree for
   * @param repoUrl - Repository URL to scope the search
   * @param branch - Optional branch to scope the search (defaults to 'main')
   */
  async getImportTree(
    filePath: string,
    repoUrl: string,
    branch?: string
  ): Promise<ImportTree> {
    const params = new URLSearchParams()
    params.append('repo_url', repoUrl)
    if (branch) {
      params.append('branch', branch)
    }

    const queryString = params.toString()
    const url = `${this.baseUrl}/import-tree/${encodeURIComponent(filePath)}?${queryString}`

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get import tree: ${error}`)
    }

    const data = (await response.json()) as ImportTreeResponse

    // Map snake_case to camelCase
    return {
      targetFile: data.target_file,
      directImports: data.direct_imports,
      directImporters: data.direct_importers,
      indirectImports: data.indirect_imports,
      indirectImporters: data.indirect_importers,
    }
  }

  /**
   * Detect circular dependencies in the import graph.
   *
   * Circular dependencies can cause issues with module initialization order,
   * code complexity, and bundle size (in JavaScript/TypeScript).
   *
   * @param repoUrl - Repository URL to analyze
   * @param branch - Optional branch (defaults to 'main')
   * @param maxCycleLength - Maximum cycle length to detect (default: 10)
   */
  async getCircularDependencies(
    repoUrl: string,
    branch?: string,
    maxCycleLength: number = 10
  ): Promise<CircularDependenciesResult> {
    const params = new URLSearchParams()
    params.append('repo_url', repoUrl)
    if (branch) {
      params.append('branch', branch)
    }
    params.append('max_cycle_length', String(maxCycleLength))

    const queryString = params.toString()
    const url = `${this.baseUrl}/circular-dependencies?${queryString}`

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get circular dependencies: ${error}`)
    }

    const data = (await response.json()) as CircularDependenciesResponse

    // Map snake_case to camelCase
    return {
      repoUrl: data.repo_url,
      branch: data.branch,
      circularDependencies: data.circular_dependencies.map((cd) => ({
        cycle: cd.cycle,
        cycleType: cd.cycle_type as 'direct' | 'indirect',
      })),
      totalCount: data.total_count,
    }
  }

  /**
   * Find 'hub' files that are imported by many other files.
   *
   * Hub files are high-impact files where changes could affect many dependents.
   * They may warrant extra scrutiny during code review.
   *
   * @param repoUrl - Repository URL to analyze
   * @param branch - Optional branch (defaults to 'main')
   * @param threshold - Minimum number of importers to be considered a hub (default: 10)
   * @param limit - Maximum number of hub files to return (default: 50)
   */
  async getHubFiles(
    repoUrl: string,
    branch?: string,
    threshold: number = 10,
    limit: number = 50
  ): Promise<HubFilesResult> {
    const params = new URLSearchParams()
    params.append('repo_url', repoUrl)
    if (branch) {
      params.append('branch', branch)
    }
    params.append('threshold', String(threshold))
    params.append('limit', String(limit))

    const queryString = params.toString()
    const url = `${this.baseUrl}/hub-files?${queryString}`

    const response = await fetch(url, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get hub files: ${error}`)
    }

    const data = (await response.json()) as HubFilesResponse

    // Map snake_case to camelCase
    return {
      repoUrl: data.repo_url,
      branch: data.branch,
      hubFiles: data.hub_files.map((hf) => ({
        filePath: hf.file_path,
        importCount: hf.import_count,
        importers: hf.importers,
      })),
      totalCount: data.total_count,
      threshold: data.threshold,
    }
  }

  // ============================================================================
  // Keyword Search (BM25)
  // ============================================================================

  /**
   * Search for code using BM25 keyword matching.
   *
   * This method provides keyword-based search that complements vector similarity
   * search by excelling at exact identifier matches and technical terms.
   *
   * Features:
   * - Handles camelCase and snake_case variations automatically
   * - Boosts exact function/class name matches by the specified multiplier
   * - Uses PostgreSQL full-text search with BM25-style ranking
   *
   * @param query - Search query (identifier or keywords)
   * @param repoUrl - Optional repository URL to scope the search
   * @param branch - Optional branch to scope the search
   * @param limit - Maximum number of results (default: 10)
   * @param exactMatchBoost - Multiplier for exact symbol matches (default: 3.0)
   */
  async keywordSearch(
    query: string,
    repoUrl?: string,
    branch?: string,
    limit: number = 10,
    exactMatchBoost: number = 3.0
  ): Promise<KeywordSearchResult> {
    const response = await fetch(`${this.baseUrl}/keyword-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        repo_url: repoUrl,
        branch,
        limit,
        exact_match_boost: exactMatchBoost,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Keyword search failed: ${error}`)
    }

    const data = (await response.json()) as KeywordSearchResponse

    // Map snake_case to camelCase
    return {
      query: data.query,
      normalizedQuery: data.normalized_query,
      matches: data.matches.map((match): KeywordMatch => ({
        filePath: match.file_path,
        content: match.content,
        lineStart: match.line_start,
        lineEnd: match.line_end,
        chunkType: match.chunk_type as ChunkType | null,
        symbolNames: match.symbol_names,
        bm25Score: match.bm25_score,
        exactMatchBoost: match.exact_match_boost,
        finalScore: match.final_score,
        repoUrl: match.repo_url ?? undefined,
        branch: match.branch ?? undefined,
      })),
      totalCount: data.total_count,
    }
  }

  // ============================================================================
  // Hybrid Search (Vector + BM25 with RRF)
  // ============================================================================

  /**
   * Search for code using hybrid vector + keyword search with Reciprocal Rank Fusion.
   *
   * This method combines the strengths of both search methods:
   * - Vector search: Semantic understanding, conceptual similarity
   * - Keyword search: Exact identifier matches, technical terms
   *
   * The results are combined using Reciprocal Rank Fusion (RRF), which:
   * - Ranks each result by position in both search results
   * - Applies configurable weights (default: 60% vector, 40% keyword)
   * - Returns a unified, deduplicated result set
   *
   * Features:
   * - Quoted phrases (e.g., "getUserById") trigger exact matching
   * - Automatic fallback to pure vector search if keyword returns no results
   * - Handles camelCase and snake_case variations in keyword search
   *
   * @param query - Search query (may contain quoted phrases for exact matching)
   * @param repoUrl - Optional repository URL to scope the search
   * @param branch - Optional branch to scope the search
   * @param limit - Maximum number of results (default: 10)
   * @param vectorWeight - Weight for vector similarity (default: 0.6)
   * @param keywordWeight - Weight for keyword matching (default: 0.4)
   * @param exactMatchBoost - Multiplier for exact symbol matches (default: 3.0)
   */
  async hybridSearch(
    query: string,
    repoUrl?: string,
    branch?: string,
    limit: number = 10,
    vectorWeight: number = 0.6,
    keywordWeight: number = 0.4,
    exactMatchBoost: number = 3.0
  ): Promise<HybridSearchResult> {
    const response = await fetch(`${this.baseUrl}/hybrid-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        repo_url: repoUrl,
        branch,
        limit,
        vector_weight: vectorWeight,
        keyword_weight: keywordWeight,
        exact_match_boost: exactMatchBoost,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Hybrid search failed: ${error}`)
    }

    const data = (await response.json()) as HybridSearchResponse

    // Map snake_case to camelCase
    return {
      query: data.query,
      quotedPhrases: data.quoted_phrases,
      matches: data.matches.map((match): HybridMatch => ({
        filePath: match.file_path,
        content: match.content,
        lineStart: match.line_start,
        lineEnd: match.line_end,
        chunkType: match.chunk_type as ChunkType | null,
        symbolNames: match.symbol_names,
        repoUrl: match.repo_url ?? undefined,
        branch: match.branch ?? undefined,
        vectorScore: match.vector_score,
        vectorRank: match.vector_rank ?? undefined,
        keywordScore: match.keyword_score,
        keywordRank: match.keyword_rank ?? undefined,
        rrfScore: match.rrf_score,
        sources: match.sources as Array<'vector' | 'keyword'>,
      })),
      totalCount: data.total_count,
      vectorWeight: data.vector_weight,
      keywordWeight: data.keyword_weight,
      fallbackUsed: data.fallback_used,
    }
  }
}
