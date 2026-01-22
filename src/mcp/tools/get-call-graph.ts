/**
 * MCP Tool: get_call_graph
 *
 * Get the call graph for a function - who calls it and what it calls.
 */

import type { IndexerClient } from '../../indexer/client.js'
import type { CallGraphDirection, CallGraphNode } from '../../indexer/types.js'

export interface GetCallGraphInput {
  functionName: string
  direction?: 'callers' | 'callees' | 'both'
  depth?: number
}

export interface GetCallGraphOutput {
  function: string
  direction: string
  callers: Array<{
    name: string
    path: string
    lines: string
    depth: number
  }>
  callees: Array<{
    name: string
    path: string
    lines: string
    depth: number
  }>
  totalNodes: number
}

const DEFAULT_DEPTH = 2
const MAX_DEPTH = 3

/**
 * Get the call graph for a function
 */
export async function getCallGraphHandler(
  input: GetCallGraphInput,
  client: IndexerClient,
  repoUrl: string,
  branch?: string
): Promise<GetCallGraphOutput> {
  const direction = input.direction ?? 'both'
  const depth = Math.min(input.depth ?? DEFAULT_DEPTH, MAX_DEPTH)

  const result = await client.getCallGraph(
    input.functionName,
    repoUrl,
    branch,
    direction as CallGraphDirection,
    depth
  )

  const mapNode = (node: CallGraphNode) => ({
    name: node.name,
    path: node.filePath,
    lines: `${node.lineStart}-${node.lineEnd}`,
    depth: node.depth,
  })

  return {
    function: result.function,
    direction: result.direction,
    callers: result.callers.map(mapNode),
    callees: result.callees.map(mapNode),
    totalNodes: result.totalNodes,
  }
}

/**
 * Tool schema for MCP registration
 */
export const getCallGraphSchema = {
  name: 'get_call_graph',
  description: 'Get the call graph for a function - find what functions call it (callers) and what functions it calls (callees). Useful for understanding the execution flow and potential impact of changes.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      functionName: {
        type: 'string',
        description: 'The function name to get the call graph for',
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees', 'both'],
        description: 'Which direction to traverse (default: both)',
      },
      depth: {
        type: 'number',
        description: `How many levels deep to traverse (default: ${DEFAULT_DEPTH}, max: ${MAX_DEPTH})`,
      },
    },
    required: ['functionName'],
  },
}
