import type { CodeChunk, IndexStats, RepoInfo, DefinitionLookupResult, ChunkType } from './types.js'

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
}
