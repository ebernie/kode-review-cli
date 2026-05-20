/**
 * MCP Tool: search_code
 *
 * Hybrid semantic + keyword search using the code indexer.
 */

import type { IndexerClient } from '../../indexer/client.js'
import type { HybridMatch } from '../../indexer/types.js'
import { filterSensitivePaths } from './sensitive-filter.js'

export interface SearchCodeInput {
  query: string
  limit?: number
}

export interface SearchCodeOutput {
  results: Array<{
    path: string
    lines: string
    content: string
    score: number
    matchTypes: string[]
  }>
  totalMatches: number
  query: string
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

/**
 * Search for code using hybrid vector + keyword search
 */
export async function searchCodeHandler(
  input: SearchCodeInput,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<SearchCodeOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

  const searchResult = await client.hybridSearch(
    input.query,
    repoUrl,
    branch,
    limit
  )

  const results = searchResult.matches.map((match: HybridMatch) => ({
    path: match.filePath,
    lines: `${match.lineStart}-${match.lineEnd}`,
    content: match.content,
    score: match.rrfScore,
    matchTypes: match.sources,
  }))

  // Mirror the sensitive-path filter used by the fs-backed handler so an
  // indexed secrets file (mis-committed .env, application-prod.yml) does
  // not leak its contents into the model's context.
  const safeResults = filterSensitivePaths(results)

  return {
    results: safeResults,
    totalMatches: safeResults.length,
    query: input.query,
  }
}

/**
 * Tool schema for MCP registration
 */
export const searchCodeSchema = {
  name: 'search_code',
  description: 'Search for code using hybrid semantic + keyword search. Use to find related code, implementations, patterns, or specific functionality in the repository.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query - can be natural language or code identifiers',
      },
      limit: {
        type: 'number',
        description: `Maximum results to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
      },
    },
    required: ['query'],
  },
}
