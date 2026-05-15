/**
 * Filesystem-backed implementation of the `search_code` tool. Used in agentic
 * mode whenever the indexer is unreachable. Output shape matches the indexer
 * implementation so the prompt and the model do not need to know which is in use.
 */

import { ripgrepSearch } from './ripgrep.js'
import type { SearchCodeInput, SearchCodeOutput } from './search-code-indexer.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

export async function searchCodeFsHandler(
  input: SearchCodeInput,
  repoRoot: string,
): Promise<SearchCodeOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const matches = await ripgrepSearch(input.query, repoRoot, {
    maxResults: limit,
    fixedString: true,
  })

  return {
    results: matches.map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      score: 1,
      matchTypes: ['lexical'],
    })),
    totalMatches: matches.length,
    query: input.query,
  }
}
