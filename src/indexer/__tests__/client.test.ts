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

  describe('lookupDefinitions', () => {
    it('returns definition locations with snake_case to camelCase mapping', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          symbol: 'MyClass',
          definitions: [
            {
              file_path: 'src/models/MyClass.ts',
              line_start: 10,
              line_end: 50,
              content: 'export class MyClass { }',
              chunk_type: 'class',
              is_reexport: false,
              reexport_source: null,
            },
            {
              file_path: 'src/index.ts',
              line_start: 5,
              line_end: 5,
              content: "export { MyClass } from './models/MyClass'",
              chunk_type: 'export',
              is_reexport: true,
              reexport_source: 'src/models/MyClass.ts',
            },
          ],
          total_count: 2,
        }),
      })

      const result = await client.lookupDefinitions('MyClass', 'https://github.com/test/repo')

      expect(result.symbol).toBe('MyClass')
      expect(result.totalCount).toBe(2)
      expect(result.definitions).toHaveLength(2)

      // Verify direct definition
      expect(result.definitions[0]).toEqual({
        filePath: 'src/models/MyClass.ts',
        lineStart: 10,
        lineEnd: 50,
        content: 'export class MyClass { }',
        chunkType: 'class',
        isReexport: false,
        reexportSource: null,
      })

      // Verify re-export
      expect(result.definitions[1]).toEqual({
        filePath: 'src/index.ts',
        lineStart: 5,
        lineEnd: 5,
        content: "export { MyClass } from './models/MyClass'",
        chunkType: 'export',
        isReexport: true,
        reexportSource: 'src/models/MyClass.ts',
      })
    })

    it('sends correct URL with all query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'test', definitions: [], total_count: 0 }),
      })

      await client.lookupDefinitions('handleRequest', 'https://github.com/test/repo', 'main', true, 10)

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(`${baseUrl}/definitions/handleRequest`)
      expect(calledUrl).toContain('repo_url=https%3A%2F%2Fgithub.com%2Ftest%2Frepo')
      expect(calledUrl).toContain('branch=main')
      expect(calledUrl).toContain('include_reexports=true')
      expect(calledUrl).toContain('limit=10')
      expect(mockFetch).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }))
    })

    it('encodes special characters in symbol name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'MyClass<T>', definitions: [], total_count: 0 }),
      })

      await client.lookupDefinitions('MyClass<T>')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(`${baseUrl}/definitions/${encodeURIComponent('MyClass<T>')}`)
    })

    it('returns empty result when no definitions found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'unknownSymbol', definitions: [], total_count: 0 }),
      })

      const result = await client.lookupDefinitions('unknownSymbol')

      expect(result.symbol).toBe('unknownSymbol')
      expect(result.definitions).toHaveLength(0)
      expect(result.totalCount).toBe(0)
    })

    it('throws error when lookup fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Internal server error',
      })

      await expect(
        client.lookupDefinitions('MyClass', 'https://github.com/test/repo')
      ).rejects.toThrow('Failed to lookup definitions: Internal server error')
    })

    it('respects includeReexports=false parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'test', definitions: [], total_count: 0 }),
      })

      await client.lookupDefinitions('test', undefined, undefined, false)

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('include_reexports=false')
    })
  })

  describe('lookupUsages', () => {
    it('returns usage locations with snake_case to camelCase mapping', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          symbol: 'handleRequest',
          usages: [
            {
              file_path: 'src/controllers/user.ts',
              line_start: 25,
              line_end: 30,
              content: 'handleRequest(req, res)',
              chunk_type: 'function',
              usage_type: 'calls',
              is_dynamic: false,
            },
            {
              file_path: 'src/index.ts',
              line_start: 5,
              line_end: 5,
              content: "import { handleRequest } from './handlers'",
              chunk_type: 'import',
              usage_type: 'imports',
              is_dynamic: false,
            },
            {
              file_path: 'src/lazy-loader.ts',
              line_start: 10,
              line_end: 12,
              content: "const handler = await import('./handlers').then(m => m.handleRequest)",
              chunk_type: 'function',
              usage_type: 'imports',
              is_dynamic: true,
            },
          ],
          total_count: 3,
        }),
      })

      const result = await client.lookupUsages('handleRequest', 'https://github.com/test/repo')

      expect(result.symbol).toBe('handleRequest')
      expect(result.totalCount).toBe(3)
      expect(result.usages).toHaveLength(3)

      // Verify call usage
      expect(result.usages[0]).toEqual({
        filePath: 'src/controllers/user.ts',
        lineStart: 25,
        lineEnd: 30,
        content: 'handleRequest(req, res)',
        chunkType: 'function',
        usageType: 'calls',
        isDynamic: false,
      })

      // Verify static import
      expect(result.usages[1]).toEqual({
        filePath: 'src/index.ts',
        lineStart: 5,
        lineEnd: 5,
        content: "import { handleRequest } from './handlers'",
        chunkType: 'import',
        usageType: 'imports',
        isDynamic: false,
      })

      // Verify dynamic import (flagged as uncertain)
      expect(result.usages[2]).toEqual({
        filePath: 'src/lazy-loader.ts',
        lineStart: 10,
        lineEnd: 12,
        content: "const handler = await import('./handlers').then(m => m.handleRequest)",
        chunkType: 'function',
        usageType: 'imports',
        isDynamic: true,
      })
    })

    it('sends correct URL with all query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'test', usages: [], total_count: 0 }),
      })

      await client.lookupUsages('processData', 'https://github.com/test/repo', 'develop', 25)

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(`${baseUrl}/usages/processData`)
      expect(calledUrl).toContain('repo_url=https%3A%2F%2Fgithub.com%2Ftest%2Frepo')
      expect(calledUrl).toContain('branch=develop')
      expect(calledUrl).toContain('limit=25')
      expect(mockFetch).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }))
    })

    it('encodes special characters in symbol name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'Array<T>', usages: [], total_count: 0 }),
      })

      await client.lookupUsages('Array<T>')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain(`${baseUrl}/usages/${encodeURIComponent('Array<T>')}`)
    })

    it('returns empty result when no usages found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'unusedFunction', usages: [], total_count: 0 }),
      })

      const result = await client.lookupUsages('unusedFunction')

      expect(result.symbol).toBe('unusedFunction')
      expect(result.usages).toHaveLength(0)
      expect(result.totalCount).toBe(0)
    })

    it('throws error when lookup fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Internal server error',
      })

      await expect(
        client.lookupUsages('MyClass', 'https://github.com/test/repo')
      ).rejects.toThrow('Failed to lookup usages: Internal server error')
    })

    it('uses default limit when not specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ symbol: 'test', usages: [], total_count: 0 }),
      })

      await client.lookupUsages('myFunction')

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain('limit=50')
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
