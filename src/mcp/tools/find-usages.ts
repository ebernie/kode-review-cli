/**
 * MCP Tool: find_usages
 *
 * Find all usages of a symbol (where it's called, imported, or referenced).
 */

import type { IndexerClient } from '../../indexer/client.js'
import type { UsageLocation } from '../../indexer/types.js'

export interface FindUsagesInput {
  symbol: string
  limit?: number
}

export interface FindUsagesOutput {
  symbol: string
  usages: Array<{
    path: string
    lines: string
    content: string
    usageType: 'calls' | 'imports' | 'references'
    isDynamic: boolean
  }>
  totalCount: number
}

const DEFAULT_LIMIT = 15
const MAX_LIMIT = 30

/**
 * Look up all usages of a symbol
 */
export async function findUsagesHandler(
  input: FindUsagesInput,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<FindUsagesOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

  const result = await client.lookupUsages(
    input.symbol,
    repoUrl,
    branch,
    limit
  )

  const usages = result.usages.map((usage: UsageLocation) => ({
    path: usage.filePath,
    lines: `${usage.lineStart}-${usage.lineEnd}`,
    content: usage.content,
    usageType: usage.usageType,
    isDynamic: usage.isDynamic,
  }))

  return {
    symbol: result.symbol,
    usages,
    totalCount: result.totalCount,
  }
}

/**
 * Tool schema for MCP registration
 */
export const findUsagesSchema = {
  name: 'find_usages',
  description: 'Find all places where a symbol is used (called, imported, or referenced). Useful for impact analysis - understanding what code might be affected by changes to a symbol.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'The symbol name to look up usages for (e.g., "fetchUser", "validateInput")',
      },
      limit: {
        type: 'number',
        description: `Maximum results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
      },
    },
    required: ['symbol'],
  },
}
