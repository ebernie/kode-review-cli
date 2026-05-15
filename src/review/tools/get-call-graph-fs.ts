/**
 * Filesystem-backed `get_call_graph`. There is no reliable way to build a
 * proper call graph from text matching, so this returns a structured
 * "unavailable" response that keeps the schema stable.
 */

import type {
  GetCallGraphInput,
  GetCallGraphOutput,
} from './get-call-graph-indexer.js'

export type GetCallGraphFsOutput = GetCallGraphOutput & {
  available: false
  reason: string
}

export async function getCallGraphFsHandler(
  input: GetCallGraphInput,
): Promise<GetCallGraphFsOutput> {
  return {
    function: input.functionName,
    direction: input.direction ?? 'both',
    callers: [],
    callees: [],
    totalNodes: 0,
    available: false,
    reason:
      'Call graph requires the indexer. Use `find_usages` for callers and `read_file` + `search_code` to inspect callees manually.',
  }
}
