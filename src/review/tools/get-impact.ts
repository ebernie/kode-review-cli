/**
 * MCP Tool: get_impact
 *
 * Get the import tree for a file to understand what depends on it.
 */

import type { IndexerClient } from '../../indexer/client.js'

export interface GetImpactInput {
  filePath: string
}

export interface GetImpactOutput {
  targetFile: string
  directImports: string[]
  directImporters: string[]
  indirectImports: string[]
  indirectImporters: string[]
  totalDependents: number
  isHighImpact: boolean
}

const HIGH_IMPACT_THRESHOLD = 5

/**
 * Get the import tree for a file
 */
export async function getImpactHandler(
  input: GetImpactInput,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<GetImpactOutput> {
  const result = await client.getImportTree(
    input.filePath,
    repoUrl,
    branch
  )

  const totalDependents = result.directImporters.length + result.indirectImporters.length

  return {
    targetFile: result.targetFile,
    directImports: result.directImports,
    directImporters: result.directImporters,
    indirectImports: result.indirectImports,
    indirectImporters: result.indirectImporters,
    totalDependents,
    isHighImpact: totalDependents >= HIGH_IMPACT_THRESHOLD,
  }
}

/**
 * Tool schema for MCP registration
 */
export const getImpactSchema = {
  name: 'get_impact',
  description: 'Analyze the import dependencies for a file. Shows what files depend on the target file (importers) and what the target file depends on (imports). Useful for understanding the blast radius of changes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file to analyze (relative to repository root)',
      },
    },
    required: ['filePath'],
  },
}
