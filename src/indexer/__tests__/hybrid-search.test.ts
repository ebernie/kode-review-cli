import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest'
import { IndexerClient } from '../client.js'

describe('Hybrid Search', () => {
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

  describe('hybridSearch', () => {
    it('returns combined results with RRF scoring', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'getUserById',
          quoted_phrases: [],
          matches: [
            {
              file_path: 'src/services/user.ts',
              content: 'export function getUserById(id: string) { }',
              line_start: 10,
              line_end: 20,
              chunk_type: 'function',
              symbol_names: ['getUserById'],
              repo_url: 'https://github.com/test/repo',
              branch: 'main',
              vector_score: 0.92,
              vector_rank: 1,
              keyword_score: 0.85,
              keyword_rank: 1,
              rrf_score: 0.0196,
              sources: ['vector', 'keyword'],
            },
            {
              file_path: 'src/controllers/user.ts',
              content: 'const user = await getUserById(req.params.id)',
              line_start: 25,
              line_end: 30,
              chunk_type: 'function',
              symbol_names: ['handleGetUser'],
              repo_url: 'https://github.com/test/repo',
              branch: 'main',
              vector_score: 0.85,
              vector_rank: 2,
              keyword_score: 0.0,
              keyword_rank: null,
              rrf_score: 0.0097,
              sources: ['vector'],
            },
          ],
          total_count: 2,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      const result = await client.hybridSearch('getUserById', 'https://github.com/test/repo')

      expect(result.query).toBe('getUserById')
      expect(result.quotedPhrases).toEqual([])
      expect(result.totalCount).toBe(2)
      expect(result.vectorWeight).toBe(0.6)
      expect(result.keywordWeight).toBe(0.4)
      expect(result.fallbackUsed).toBe(false)

      // Verify first match (found in both searches)
      expect(result.matches[0]).toEqual({
        filePath: 'src/services/user.ts',
        content: 'export function getUserById(id: string) { }',
        lineStart: 10,
        lineEnd: 20,
        chunkType: 'function',
        symbolNames: ['getUserById'],
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
        vectorScore: 0.92,
        vectorRank: 1,
        keywordScore: 0.85,
        keywordRank: 1,
        rrfScore: 0.0196,
        sources: ['vector', 'keyword'],
      })

      // Verify second match (vector only)
      expect(result.matches[1].sources).toEqual(['vector'])
      expect(result.matches[1].keywordRank).toBeUndefined()
    })

    it('sends correct request parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'test',
          quoted_phrases: [],
          matches: [],
          total_count: 0,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      await client.hybridSearch(
        'handleRequest',
        'https://github.com/test/repo',
        'develop',
        15,
        0.7,
        0.3,
        2.5
      )

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/hybrid-search`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'handleRequest',
            repo_url: 'https://github.com/test/repo',
            branch: 'develop',
            limit: 15,
            vector_weight: 0.7,
            keyword_weight: 0.3,
            exact_match_boost: 2.5,
          }),
        })
      )
    })

    it('uses default parameters when not specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'test',
          quoted_phrases: [],
          matches: [],
          total_count: 0,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      await client.hybridSearch('test query')

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/hybrid-search`,
        expect.objectContaining({
          body: JSON.stringify({
            query: 'test query',
            limit: 10,
            vector_weight: 0.6,
            keyword_weight: 0.4,
            exact_match_boost: 3.0,
          }),
        })
      )
    })

    it('handles quoted phrases for exact matching', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: '"getUserById" auth module',
          quoted_phrases: ['getUserById'],
          matches: [
            {
              file_path: 'src/auth/user.ts',
              content: 'function getUserById(id) { }',
              line_start: 1,
              line_end: 5,
              chunk_type: 'function',
              symbol_names: ['getUserById'],
              repo_url: null,
              branch: null,
              vector_score: 0.88,
              vector_rank: 1,
              keyword_score: 2.55,
              keyword_rank: 1,
              rrf_score: 0.0196,
              sources: ['vector', 'keyword'],
            },
          ],
          total_count: 1,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      const result = await client.hybridSearch('"getUserById" auth module')

      expect(result.quotedPhrases).toEqual(['getUserById'])
      expect(result.matches[0].keywordScore).toBe(2.55) // Boosted by exact match
    })

    it('indicates when fallback to vector-only was used', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'semantic concept query',
          quoted_phrases: [],
          matches: [
            {
              file_path: 'src/concept.ts',
              content: 'class ConceptHandler { }',
              line_start: 1,
              line_end: 10,
              chunk_type: 'class',
              symbol_names: ['ConceptHandler'],
              repo_url: null,
              branch: null,
              vector_score: 0.75,
              vector_rank: 1,
              keyword_score: 0.0,
              keyword_rank: null,
              rrf_score: 0.75,
              sources: ['vector'],
            },
          ],
          total_count: 1,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: true,
        }),
      })

      const result = await client.hybridSearch('semantic concept query')

      expect(result.fallbackUsed).toBe(true)
      expect(result.matches[0].sources).toEqual(['vector'])
      expect(result.matches[0].keywordRank).toBeUndefined()
    })

    it('handles results from keyword-only matches', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'XYZ_SPECIAL_CONSTANT',
          quoted_phrases: [],
          matches: [
            {
              file_path: 'src/constants.ts',
              content: 'export const XYZ_SPECIAL_CONSTANT = 42',
              line_start: 5,
              line_end: 5,
              chunk_type: 'constant',
              symbol_names: ['XYZ_SPECIAL_CONSTANT'],
              repo_url: 'https://github.com/test/repo',
              branch: 'main',
              vector_score: 0.0,
              vector_rank: null,
              keyword_score: 3.0,
              keyword_rank: 1,
              rrf_score: 0.0065,
              sources: ['keyword'],
            },
          ],
          total_count: 1,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      const result = await client.hybridSearch('XYZ_SPECIAL_CONSTANT')

      expect(result.matches[0].sources).toEqual(['keyword'])
      expect(result.matches[0].vectorRank).toBeUndefined()
      expect(result.matches[0].vectorScore).toBe(0.0)
    })

    it('throws error when hybrid search fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: async () => 'Search error',
      })

      await expect(
        client.hybridSearch('test query')
      ).rejects.toThrow('Hybrid search failed: Search error')
    })

    it('handles empty results gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'nonexistent_function_xyz123',
          quoted_phrases: [],
          matches: [],
          total_count: 0,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: true,
        }),
      })

      const result = await client.hybridSearch('nonexistent_function_xyz123')

      expect(result.matches).toHaveLength(0)
      expect(result.totalCount).toBe(0)
    })

    it('properly maps null values to undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: 'test',
          quoted_phrases: [],
          matches: [
            {
              file_path: 'src/test.ts',
              content: 'test code',
              line_start: 1,
              line_end: 1,
              chunk_type: null,
              symbol_names: [],
              repo_url: null,
              branch: null,
              vector_score: 0.5,
              vector_rank: 1,
              keyword_score: 0.0,
              keyword_rank: null,
              rrf_score: 0.01,
              sources: ['vector'],
            },
          ],
          total_count: 1,
          vector_weight: 0.6,
          keyword_weight: 0.4,
          fallback_used: false,
        }),
      })

      const result = await client.hybridSearch('test')

      expect(result.matches[0].chunkType).toBeNull()
      expect(result.matches[0].repoUrl).toBeUndefined()
      expect(result.matches[0].branch).toBeUndefined()
      expect(result.matches[0].keywordRank).toBeUndefined()
    })
  })
})
