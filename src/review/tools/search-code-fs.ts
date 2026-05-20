/**
 * Filesystem-backed implementation of the `search_code` tool. Used in agentic
 * mode whenever the indexer is unreachable. Output shape matches the indexer
 * implementation so the prompt and the model do not need to know which is in use.
 */

import { ripgrepSearch } from './ripgrep.js'
import { filterSensitivePaths } from './sensitive-filter.js'
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

  // Apply the same sensitive-path filter `read_file` uses so matches in
  // .env / SSH key / credentials files never reach the model. The ripgrep
  // wrapper does respect .gitignore via rg's defaults; this denylist
  // covers tracked sensitive files (e.g. application-prod.yml) that
  // .gitignore would not catch.
  const safeMatches = filterSensitivePaths(matches)

  return {
    results: safeMatches.map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      score: 1,
      matchTypes: ['lexical'],
    })),
    totalMatches: safeMatches.length,
    query: input.query,
  }
}
