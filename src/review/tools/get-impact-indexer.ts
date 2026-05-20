/**
 * MCP Tool: get_impact
 *
 * Get the import tree for a file to understand what depends on it.
 */

import type { IndexerClient } from '../../indexer/client.js'
import { filterSensitivePathStrings } from './sensitive-filter.js'

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

  // Filter sensitive paths out of every dependency list before they reach
  // the model. `totalDependents` is recomputed from the filtered lists so
  // the "high impact" threshold is also evaluated against the safe set.
  const directImports = filterSensitivePathStrings(result.directImports)
  const directImporters = filterSensitivePathStrings(result.directImporters)
  const indirectImports = filterSensitivePathStrings(result.indirectImports)
  const indirectImporters = filterSensitivePathStrings(result.indirectImporters)
  const totalDependents = directImporters.length + indirectImporters.length

  return {
    targetFile: result.targetFile,
    directImports,
    directImporters,
    indirectImports,
    indirectImporters,
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
