import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'
import { IndexerClient } from '../client.js'

describe('IndexerClient', () => {
  const baseUrl = 'http://localhost:8321'
  let client: IndexerClient
  let originalFetch: typeof global.fetch
  let mockFetch: Mock

  beforeEach(() => {
    originalFetch = global.fetch
    mockFetch = vi.fn()
    global.fetch = mockFetch
    client = new IndexerClient(baseUrl)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.resetAllMocks()
  })

  describe('health', () => {
    it('returns true when the API responds with healthy status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'healthy', database: 'connected', embedding_model: 'test' }),
      })

      const result = await client.health()
      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/health`,
        expect.objectContaining({ method: 'GET' })
      )
    })

    it('returns false when the API responds with unhealthy status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'unhealthy', database: 'disconnected' }),
      })

      const result = await client.health()
      expect(result).toBe(false)
    })

    it('returns false when the API request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      const result = await client.health()
      expect(result).toBe(false)
    })

    it('returns false when fetch throws an error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await client.health()
      expect(result).toBe(false)
    })
  })

  describe('index', () => {
    it('sends correct request to start indexing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Indexing started', status: 'indexing' }),
      })

      const result = await client.index({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/repo',
        includePatterns: ['**/*.ts'],
        excludePatterns: ['**/node_modules/**'],
      })

      expect(result).toEqual({ message: 'Indexing started', status: 'indexing' })
      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/index`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo_url: 'https://github.com/test/repo',
            repo_path: '/repo',
            include_patterns: ['**/*.ts'],
            exclude_patterns: ['**/node_modules/**'],
          }),
        })
      )
    })

    it('throws error when indexing request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Internal server error',
      })

      await expect(
        client.index({
          repoUrl: 'https://github.com/test/repo',
          repoPath: '/repo',
          includePatterns: [],
          excludePatterns: [],
        })
      ).rejects.toThrow('Failed to start indexing: Internal server error')
    })
  })

  describe('search', () => {
    it('returns code chunks from search results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'test query',
          chunks: [
            {
              filename: 'src/app.ts',
              code: 'function test() {}',
              score: 0.95,
              start_line: 10,
              end_line: 15,
            },
            {
              filename: 'src/utils.ts',
              code: 'const helper = () => {}',
              score: 0.85,
              start_line: 1,
              end_line: 5,
            },
          ],
        }),
      })

      const results = await client.search('test query', 'https://github.com/test/repo', 5)

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        filename: 'src/app.ts',
        code: 'function test() {}',
        score: 0.95,
        startLine: 10,
        endLine: 15,
      })
      expect(results[1]).toEqual({
        filename: 'src/utils.ts',
        code: 'const helper = () => {}',
        score: 0.85,
        startLine: 1,
        endLine: 5,
      })
    })

    it('sends correct search request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: 'test', chunks: [] }),
      })

      await client.search('test query', 'https://github.com/test/repo', 10)

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/search`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'test query',
            repo_url: 'https://github.com/test/repo',
            limit: 10,
          }),
        })
      )
    })

    it('throws error when search fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Search error',
      })

      await expect(
        client.search('test', 'https://github.com/test/repo')
      ).rejects.toThrow('Search failed: Search error')
    })
  })

  describe('stats', () => {
    it('returns repository statistics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repo_url: 'https://github.com/test/repo',
          chunk_count: 100,
          file_count: 25,
          last_indexed: '2024-01-15T10:30:00Z',
          status: 'indexed',
        }),
      })

      const stats = await client.stats('https://github.com/test/repo')

      expect(stats).toEqual({
        repoUrl: 'https://github.com/test/repo',
        chunkCount: 100,
        fileCount: 25,
        lastIndexed: '2024-01-15T10:30:00Z',
        status: 'indexed',
      })
    })

    it('encodes repo URL in query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repo_url: 'https://github.com/test/repo',
          chunk_count: 0,
          file_count: 0,
          last_indexed: null,
          status: 'not_indexed',
        }),
      })

      await client.stats('https://github.com/test/repo?with=params')

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/stats?repo_url=${encodeURIComponent('https://github.com/test/repo?with=params')}`,
        expect.objectContaining({ method: 'GET' })
      )
    })

    it('throws error when stats request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Not found',
      })

      await expect(
        client.stats('https://github.com/test/repo')
      ).rejects.toThrow('Failed to get stats: Not found')
    })
  })

  describe('deleteIndex', () => {
    it('sends delete request for repository index', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Index deleted' }),
      })

      await client.deleteIndex('https://github.com/test/repo')

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/index/${encodeURIComponent('https://github.com/test/repo')}`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })

    it('throws error when delete fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Delete failed',
      })

      await expect(
        client.deleteIndex('https://github.com/test/repo')
      ).rejects.toThrow('Failed to delete index: Delete failed')
    })
  })

  describe('constructor', () => {
    it('removes trailing slash from base URL', async () => {
      const clientWithSlash = new IndexerClient('http://localhost:8321/')

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      })

      await clientWithSlash.health()

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8321/health',
        expect.any(Object)
      )
    })
  })
})
