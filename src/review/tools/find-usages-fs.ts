/**
 * Filesystem-backed `find_usages`. Runs a whole-word ripgrep search for the
 * symbol, then filters out the definition line itself.
 */

import { ripgrepSearch } from './ripgrep.js'
import type { FindUsagesInput, FindUsagesOutput } from './find-usages-indexer.js'

const DEFAULT_LIMIT = 15
const MAX_LIMIT = 30

const DEFINITION_RE = /\b(function|class|const|let|var|type|interface|enum|def|fn|struct|trait|impl|func)\b/

export async function findUsagesFsHandler(
  input: FindUsagesInput,
  repoRoot: string,
): Promise<FindUsagesOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const matches = await ripgrepSearch(input.symbol, repoRoot, {
    maxResults: limit * 2,
    fixedString: true,
    wholeWord: true,
  })

  const usages = matches
    .filter((m) => !DEFINITION_RE.test(m.text))
    .slice(0, limit)
    .map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      usageType: 'references' as const,
      isDynamic: false,
    }))

  return {
    symbol: input.symbol,
    usages,
    totalCount: usages.length,
  }
}
