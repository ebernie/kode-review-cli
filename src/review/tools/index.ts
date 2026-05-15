/**
 * Agentic tool handlers barrel export.
 *
 * Each indexer-backed tool now ships in two flavours:
 *   - `*-indexer.ts` — original implementation that calls the code indexer.
 *   - `*-fs.ts` — drop-in fallback that uses `ripgrep` + git.
 *
 * `pi-tools.ts` chooses per-tool which handler to register based on whether
 * the indexer is reachable at session start.
 */

export {
  readFileHandler,
  readFileSchema,
  type ReadFileInput,
  type ReadFileOutput,
} from './read-file.js'

// search_code
export {
  searchCodeHandler as searchCodeIndexerHandler,
  searchCodeSchema,
  type SearchCodeInput,
  type SearchCodeOutput,
} from './search-code-indexer.js'
export { searchCodeFsHandler } from './search-code-fs.js'

// find_definitions
export {
  findDefinitionsHandler as findDefinitionsIndexerHandler,
  findDefinitionsSchema,
  type FindDefinitionsInput,
  type FindDefinitionsOutput,
} from './find-definitions-indexer.js'
export { findDefinitionsFsHandler } from './find-definitions-fs.js'

// find_usages
export {
  findUsagesHandler as findUsagesIndexerHandler,
  findUsagesSchema,
  type FindUsagesInput,
  type FindUsagesOutput,
} from './find-usages-indexer.js'
export { findUsagesFsHandler } from './find-usages-fs.js'

// get_call_graph
export {
  getCallGraphHandler as getCallGraphIndexerHandler,
  getCallGraphSchema,
  type GetCallGraphInput,
  type GetCallGraphOutput,
} from './get-call-graph-indexer.js'
export { getCallGraphFsHandler } from './get-call-graph-fs.js'

// get_impact
export {
  getImpactHandler as getImpactIndexerHandler,
  getImpactSchema,
  type GetImpactInput,
  type GetImpactOutput,
} from './get-impact-indexer.js'
export { getImpactFsHandler } from './get-impact-fs.js'

// Always-on git tools
export {
  getCommitsHandler,
  type GetCommitsInput,
  type GetCommitsOutput,
} from './get-commits.js'
export {
  getFileHistoryHandler,
  type GetFileHistoryInput,
  type GetFileHistoryOutput,
} from './get-file-history.js'

// Ripgrep wrapper (exported so doctor + index.ts can probe availability)
export { isRipgrepAvailable, ripgrepSearch, type RipgrepMatch } from './ripgrep.js'

// Git helpers
export { getCommitsInRange, getFileHistory, getMergeBase, type CommitInfo } from './git-helpers.js'
