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
  DefinitionLocation,
  DefinitionLookupResult,
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
  extractCodeByFileFromDiff,
} from './context.js'

// File-type strategies
export {
  getFileType,
  getStrategyForFile,
  extractPriorityQueries,
  extractQueriesUsingStrategy,
  generateRelatedFilePaths,
  applyStrategyOverrides,
  FILE_TYPE_STRATEGIES,
  typescriptStrategy,
  javascriptStrategy,
  pythonStrategy,
  goStrategy,
  cssStrategy,
  scssStrategy,
  genericStrategy,
} from './file-type-strategies.js'

export type {
  FileTypeStrategy,
  FileTypeStrategyConfig,
  PriorityPattern,
  QueryPattern,
  RelatedFilePattern,
  StrategyResult,
  FileTypeStrategyOverrides,
} from './file-type-strategies.js'

// Setup wizard
export { setupIndexer, showIndexerStatus, handleStopIndexer, handleCleanupIndexer } from './setup.js'
