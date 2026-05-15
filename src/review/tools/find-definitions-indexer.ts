/**
 * MCP Tool: find_definitions
 *
 * Find where a symbol (function, class, variable, etc.) is defined.
 */

import type { IndexerClient } from '../../indexer/client.js'
import type { DefinitionLocation } from '../../indexer/types.js'

export interface FindDefinitionsInput {
  symbol: string
  includeReexports?: boolean
  limit?: number
}

export interface FindDefinitionsOutput {
  symbol: string
  definitions: Array<{
    path: string
    lines: string
    content: string
    isReexport: boolean
    reexportSource?: string
  }>
  totalCount: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

/**
 * Look up where a symbol is defined
 */
export async function findDefinitionsHandler(
  input: FindDefinitionsInput,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<FindDefinitionsOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const includeReexports = input.includeReexports ?? true

  const result = await client.lookupDefinitions(
    input.symbol,
    repoUrl,
    branch,
    includeReexports,
    limit
  )

  const definitions = result.definitions.map((def: DefinitionLocation) => ({
    path: def.filePath,
    lines: `${def.lineStart}-${def.lineEnd}`,
    content: def.content,
    isReexport: def.isReexport,
    reexportSource: def.reexportSource ?? undefined,
  }))

  return {
    symbol: result.symbol,
    definitions,
    totalCount: result.totalCount,
  }
}

/**
 * Tool schema for MCP registration
 */
export const findDefinitionsSchema = {
  name: 'find_definitions',
  description: 'Find where a symbol (function, class, variable, type, interface) is defined in the codebase. Useful for understanding implementation details or checking if a symbol exists.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'The symbol name to look up (e.g., "MyClass", "handleRequest", "UserService")',
      },
      includeReexports: {
        type: 'boolean',
        description: 'Include re-exported definitions (default: true)',
      },
      limit: {
        type: 'number',
        description: `Maximum results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
      },
    },
    required: ['symbol'],
  },
}
