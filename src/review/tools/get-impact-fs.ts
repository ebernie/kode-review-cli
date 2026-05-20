/**
 * Filesystem-backed `get_impact`. Resolves *direct* importers by greping
 * for import-statement patterns. Does not chase indirect dependencies.
 */

import { basename, extname } from 'node:path'
import { ripgrepSearch } from './ripgrep.js'
import { assertWithinRepo } from './path-guard.js'
import { filterSensitivePathStrings } from './sensitive-filter.js'
import type { GetImpactInput } from './get-impact-indexer.js'

export interface GetImpactFsOutput {
  targetFile: string
  directImports: string[]
  directImporters: string[]
  indirectImports: string[]
  indirectImporters: string[]
  totalDependents: number
  isHighImpact: boolean
  isPartial: true
}

const HIGH_IMPACT_THRESHOLD = 5

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function importPatterns(filePath: string): string[] {
  // Allow an optional .js/.ts/.jsx/.tsx suffix so TS imports written with the
  // ESM `.js` convention (e.g. `from './utils.js'`) still match against the
  // source file `utils.ts`.
  const base = escapeForRegex(basename(filePath, extname(filePath)))
  const baseWithOptExt = `${base}(?:\\.[jt]sx?)?`
  return [
    `from ['"][^'"]*${baseWithOptExt}['"]`,
    `require\\(['"][^'"]*${baseWithOptExt}['"]\\)`,
    `import ['"][^'"]*${baseWithOptExt}['"]`,
    `from [^\\s]*${base} import`,
  ]
}

export async function getImpactFsHandler(
  input: GetImpactInput,
  repoRoot: string,
): Promise<GetImpactFsOutput> {
  // Throws on path traversal. We use the returned relative path for
  // `targetFile` and the self-match filter below; the import-pattern regex
  // only needs the basename.
  const safePath = assertWithinRepo(repoRoot, input.filePath)
  const seen = new Set<string>()
  for (const pattern of importPatterns(safePath)) {
    const matches = await ripgrepSearch(pattern, repoRoot, {
      maxResults: 100,
      fixedString: false,
    })
    for (const m of matches) {
      if (m.path !== safePath) seen.add(m.path)
    }
  }
  // Mirror the indexer-backed handler's sensitive-path filtering so an
  // import statement in a tracked secrets file (e.g. a .pem that happens
  // to contain `from './utils'` in a comment) cannot leak its presence
  // through the importer list.
  const directImporters = filterSensitivePathStrings(Array.from(seen)).sort()
  return {
    targetFile: safePath,
    directImports: [],
    directImporters,
    indirectImports: [],
    indirectImporters: [],
    totalDependents: directImporters.length,
    isHighImpact: directImporters.length >= HIGH_IMPACT_THRESHOLD,
    isPartial: true,
  }
}
