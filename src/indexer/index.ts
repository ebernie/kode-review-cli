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
  // Import chain tracking types
  ImportTree,
  CircularDependency,
  CircularDependenciesResult,
  HubFile,
  HubFilesResult,
  // Keyword search types (BM25)
  KeywordMatch,
  KeywordSearchResult,
  KeywordSearchOptions,
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

// XML context formatting
export {
  formatContextAsXml,
  formatChunkAsXml,
  getContextType,
  getRelevanceLevel,
  getRetrievalReason,
  groupChunksByType,
  getXmlSchemaDocumentation,
} from './xml-context.js'

export type {
  ContextType,
  RelevanceLevel,
  XmlContextMetadata,
} from './xml-context.js'

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
