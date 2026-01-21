// Types
export type {
  IndexerConfig,
  CodeChunk,
  SearchResult,
  IndexStats,
  IndexerStatus,
  SemanticContextOptions,
  RepoInfo,
} from './types.js'

// Detector
export { isDockerAvailable, isDockerRunning, checkIndexerPrerequisites } from './detector.js'

// Docker management
export {
  startIndexer,
  stopIndexer,
  isIndexerRunning,
  getIndexerStatus,
  indexRepository,
  resetIndex,
  cleanupIndexer,
  listIndexedRepos,
} from './docker.js'

// HTTP client
export { IndexerClient } from './client.js'

// Context retrieval
export { getSemanticContext, extractQueriesFromDiff } from './context.js'

// Setup wizard
export { setupIndexer, showIndexerStatus, handleStopIndexer, handleCleanupIndexer } from './setup.js'
