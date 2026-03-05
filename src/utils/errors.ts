/**
 * Error handling utilities
 *
 * Provides structured error handling with:
 * - Error categorization for better user feedback
 * - Recovery hints to guide users toward solutions
 * - Consistent error formatting for CLI output
 */

/**
 * Categories of errors that can occur in the application
 */
export type ErrorCategory =
  | 'config'   // Configuration file issues
  | 'network'  // Network connectivity issues
  | 'vcs'      // VCS (GitHub/GitLab) related issues
  | 'indexer'  // Semantic indexer issues
  | 'review'   // Code review execution issues
  | 'update'   // Self-update issues
  | 'unknown'  // Uncategorized errors

/**
 * Application error with category and recovery hints
 *
 * Provides structured error information for better user feedback
 * and programmatic error handling.
 */
export class AppError extends Error {
  readonly category: ErrorCategory
  readonly cause?: Error
  readonly recoveryHint?: string

  constructor(
    message: string,
    options: {
      category: ErrorCategory
      cause?: Error
      recoveryHint?: string
    }
  ) {
    super(message)
    this.name = 'AppError'
    this.category = options.category
    this.cause = options.cause
    this.recoveryHint = options.recoveryHint

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError)
    }
  }

  /**
   * Get a JSON-serializable representation of the error
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      recoveryHint: this.recoveryHint,
      cause: this.cause?.message,
    }
  }
}

/**
 * Recovery hints for common error scenarios
 */
const RECOVERY_HINTS: Record<string, string> = {
  // Config errors
  'ENOENT': 'Run "kode-review --setup" to create a new configuration.',
  'EACCES': 'Check file permissions for the configuration directory.',
  'invalid configuration': 'Run "kode-review --reset" then "kode-review --setup" to reconfigure.',

  // Network errors
  'ECONNREFUSED': 'Check if the service is running and accessible.',
  'ECONNRESET': 'The connection was interrupted. Try again.',
  'ETIMEDOUT': 'The request timed out. Check your network connection or try again.',
  'ENOTFOUND': 'DNS lookup failed. Check your internet connection.',
  'fetch failed': 'Network request failed. Check your connection and try again.',

  // VCS errors
  'gh auth': 'Run "gh auth login" to authenticate with GitHub.',
  'glab auth': 'Run "glab auth login" to authenticate with GitLab.',
  'not found': 'Check that the PR/MR exists and you have access to it.',
  'not a git repository': 'Navigate to a git repository directory.',

  // Indexer errors
  'docker': 'Ensure Docker is installed and running.',
  'indexer': 'Run "kode-review --setup-indexer" to configure the indexer.',
  'container': 'Start the indexer containers with "docker compose up -d".',

  // Review errors
  'no changes': 'Stage some changes with "git add" or specify a PR with --pr.',
  'rate limit': 'Wait a moment before trying again.',
  'api key': 'Check your API key configuration with "kode-review --show-config".',
  'did not return a response': 'Run "kode-review --setup-provider" to reconfigure your model provider.',
}

/**
 * Attempt to determine a recovery hint for an error
 */
function getRecoveryHint(error: unknown, category: ErrorCategory): string | undefined {
  const errorString = String(error).toLowerCase()
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : errorString

  // Check for known error patterns
  for (const [pattern, hint] of Object.entries(RECOVERY_HINTS)) {
    if (errorMessage.includes(pattern.toLowerCase())) {
      return hint
    }
  }

  // Check for error codes
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code && RECOVERY_HINTS[nodeError.code]) {
      return RECOVERY_HINTS[nodeError.code]
    }
  }

  // Provide category-specific generic hints
  switch (category) {
    case 'config':
      return 'Run "kode-review --show-config" to check your configuration.'
    case 'network':
      return 'Check your network connection and try again.'
    case 'vcs':
      return 'Run "kode-review --setup-vcs" to verify VCS authentication.'
    case 'indexer':
      return 'Run "kode-review --index-status" to check indexer status.'
    case 'review':
      return 'Try running with DEBUG=1 for more details.'
    case 'update':
      return 'Try running "git pull && bun install && bun run build" manually in the installation directory.'
    default:
      return undefined
  }
}

/**
 * Determine the error category based on error properties and message
 */
export function categorizeError(error: unknown): ErrorCategory {
  if (error === null || error === undefined) {
    return 'unknown'
  }

  const errorString = String(error).toLowerCase()
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : errorString

  // Check for error codes (Node.js system errors)
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException
    const code = nodeError.code?.toLowerCase()

    // Network-related error codes
    if (code && ['econnrefused', 'econnreset', 'etimedout', 'enotfound', 'enetunreach'].includes(code)) {
      return 'network'
    }

    // File system error codes (often config-related)
    if (code && ['enoent', 'eacces', 'eperm'].includes(code)) {
      return 'config'
    }
  }

  // Check for patterns in error message
  if (errorMessage.includes('config') || errorMessage.includes('configuration')) {
    return 'config'
  }

  if (
    errorMessage.includes('network') ||
    errorMessage.includes('fetch') ||
    errorMessage.includes('connection') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('abort')
  ) {
    return 'network'
  }

  if (
    errorMessage.includes('github') ||
    errorMessage.includes('gitlab') ||
    errorMessage.includes('gh ') ||
    errorMessage.includes('glab ') ||
    errorMessage.includes(' pr ') ||
    errorMessage.includes(' mr ') ||
    errorMessage.includes('pull request') ||
    errorMessage.includes('merge request')
  ) {
    return 'vcs'
  }

  if (
    errorMessage.includes('indexer') ||
    errorMessage.includes('docker') ||
    errorMessage.includes('container') ||
    errorMessage.includes('semantic')
  ) {
    return 'indexer'
  }

  if (
    errorMessage.includes('review') ||
    errorMessage.includes('diff') ||
    errorMessage.includes('opencode') ||
    errorMessage.includes('model') ||
    errorMessage.includes('api key') ||
    errorMessage.includes('rate limit')
  ) {
    return 'review'
  }

  return 'unknown'
}

/**
 * Wrap an unknown error in an AppError with proper categorization
 *
 * @param error - The original error (can be any type)
 * @param category - Override category (if not provided, will be auto-detected)
 * @param context - Additional context to prepend to the error message
 */
export function wrapError(
  error: unknown,
  category?: ErrorCategory,
  context?: string
): AppError {
  // If already an AppError, optionally add context
  if (error instanceof AppError) {
    if (context) {
      return new AppError(`${context}: ${error.message}`, {
        category: category ?? error.category,
        cause: error.cause,
        recoveryHint: error.recoveryHint,
      })
    }
    return error
  }

  // Determine the error category
  const detectedCategory = category ?? categorizeError(error)

  // Extract the error message
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else {
    message = String(error)
  }

  // Add context if provided
  if (context) {
    message = `${context}: ${message}`
  }

  // Get recovery hint
  const recoveryHint = getRecoveryHint(error, detectedCategory)

  // Get the original error as cause
  const cause = error instanceof Error ? error : undefined

  return new AppError(message, {
    category: detectedCategory,
    cause,
    recoveryHint,
  })
}

/**
 * Format an error for CLI display
 *
 * @param error - The error to format
 * @param verbose - Whether to include stack trace and additional details
 */
export function formatError(error: Error, verbose: boolean = false): string {
  const parts: string[] = []

  // Main error message
  parts.push(error.message)

  // Add category for AppErrors
  if (error instanceof AppError) {
    if (error.recoveryHint) {
      parts.push('')
      parts.push(`Hint: ${error.recoveryHint}`)
    }
  }

  // Add stack trace in verbose mode
  if (verbose && error.stack) {
    parts.push('')
    parts.push('Stack trace:')
    // Skip the first line (error message) since we already printed it
    const stackLines = error.stack.split('\n').slice(1)
    parts.push(...stackLines)

    // Add cause stack trace if present
    if (error instanceof AppError && error.cause?.stack) {
      parts.push('')
      parts.push('Caused by:')
      parts.push(...error.cause.stack.split('\n'))
    }
  }

  return parts.join('\n')
}

/**
 * Get a user-friendly label for an error category
 */
export function getCategoryLabel(category: ErrorCategory): string {
  const labels: Record<ErrorCategory, string> = {
    config: 'Configuration Error',
    network: 'Network Error',
    vcs: 'VCS Error',
    indexer: 'Indexer Error',
    review: 'Review Error',
    update: 'Update Error',
    unknown: 'Error',
  }
  return labels[category]
}
