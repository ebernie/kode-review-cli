/**
 * Filesystem-backed `find_definitions`. Uses ripgrep with language-aware
 * regex patterns to locate symbol definitions across the working tree.
 *
 * This is a heuristic, not a parser — it catches the common idiomatic forms
 * (function/class/const/def/type) in JS/TS/Py/Go/Rust/Java. Misses are
 * acceptable; the model can fall back to `search_code`.
 */

import { ripgrepSearch } from './ripgrep.js'
import type {
  FindDefinitionsInput,
  FindDefinitionsOutput,
} from './find-definitions-indexer.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildDefinitionPattern(symbol: string): string {
  const s = escapeForRegex(symbol)
  return `\\b(function|class|const|let|var|type|interface|enum|def|fn|struct|trait|impl|func)\\b[^\\n]{0,80}\\b${s}\\b`
}

export async function findDefinitionsFsHandler(
  input: FindDefinitionsInput,
  repoRoot: string,
): Promise<FindDefinitionsOutput> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const pattern = buildDefinitionPattern(input.symbol)
  const matches = await ripgrepSearch(pattern, repoRoot, {
    maxResults: limit,
    fixedString: false,
  })

  return {
    symbol: input.symbol,
    definitions: matches.map((m) => ({
      path: m.path,
      lines: `${m.line}-${m.line}`,
      content: m.text,
      isReexport: false,
    })),
    totalCount: matches.length,
  }
}
