// Logger
export { logger, log, setQuietMode, outputJson, errorJson, type LogLevel } from './logger.js'

// Command execution
export { exec, commandExists, execInteractive, type ExecResult } from './exec.js'

// LRU Cache
export { LRUCache, type CacheOptions } from './cache.js'

// Retry with exponential backoff
export {
  withRetry,
  isRetryableError,
  createRetryWrapper,
  type RetryOptions,
} from './retry.js'

// Error handling
export {
  AppError,
  wrapError,
  formatError,
  categorizeError,
  getCategoryLabel,
  type ErrorCategory,
} from './errors.js'
