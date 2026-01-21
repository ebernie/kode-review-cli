// Types
export type {
  IndexerConfig,
  CodeChunk,
  SearchResult,
  IndexStats,
  IndexerStatus,
  SemanticContextOptions,
  RepoInfo,
  ModifiedLine,
  ParsedDiff,
  WeightedCodeChunk,
  ChangeType,
  PrDescriptionInfo,
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
  runCocoIndexFlow,
  extractRelationships,
  verifyExport,
} from './docker.js'

// HTTP client
export { IndexerClient } from './client.js'

// Context retrieval
export {
  getSemanticContext,
  extractQueriesFromDiff,
  parseDiffToModifiedLines,
  chunkOverlapsModifiedLines,
  applyModifiedLineWeighting,
  isTestFile,
  generateTestFilePaths,
  extractSourceFilesFromDiff,
  findRelatedTestFiles,
  extractPrDescriptionInfo,
  extractQueriesFromPrDescription,
} from './context.js'

// Setup wizard
export { setupIndexer, showIndexerStatus, handleStopIndexer, handleCleanupIndexer } from './setup.js'
