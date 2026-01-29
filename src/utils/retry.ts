/**
 * Retry utility with exponential backoff
 *
 * Provides a mechanism to retry failed operations with configurable:
 * - Maximum number of attempts
 * - Initial delay between retries
 * - Maximum delay cap
 * - Exponential backoff multiplier
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts: number
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs: number
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs: number
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
}

/**
 * Error codes that indicate transient network issues worth retrying
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',    // Connection reset by peer
  'ETIMEDOUT',     // Connection timed out
  'ECONNREFUSED',  // Connection refused (server might be starting up)
  'ENOTFOUND',     // DNS lookup failed (temporary DNS issues)
  'ENETUNREACH',   // Network unreachable
  'EHOSTUNREACH',  // Host unreachable
  'EPIPE',         // Broken pipe
  'EAI_AGAIN',     // Temporary DNS failure
])

/**
 * HTTP status codes that indicate transient server issues worth retrying
 */
const RETRYABLE_HTTP_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
])

/**
 * Determines if an error is retryable based on its type and properties
 *
 * Retryable errors include:
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, etc.)
 * - AbortError (timeout via AbortSignal)
 * - HTTP 5xx server errors
 * - HTTP 408 (Request Timeout) and 429 (Too Many Requests)
 */
export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false
  }

  // Handle AbortError (from AbortSignal.timeout)
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return true
    }

    // Check for Node.js system error codes
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code && RETRYABLE_ERROR_CODES.has(nodeError.code)) {
      return true
    }

    // Check for fetch-style errors with cause
    const errorWithCause = error as Error & { cause?: unknown }
    if (errorWithCause.cause && isRetryableError(errorWithCause.cause)) {
      return true
    }

    // Check for HTTP status code in the error message (common pattern)
    const match = error.message.match(/\b(4\d{2}|5\d{2})\b/)
    if (match) {
      const statusCode = parseInt(match[1], 10)
      if (RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
        return true
      }
    }
  }

  // Handle response-like objects with status property
  if (typeof error === 'object' && 'status' in error) {
    const response = error as { status: number }
    if (RETRYABLE_HTTP_STATUS_CODES.has(response.status)) {
      return true
    }
  }

  return false
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Calculate delay for the current attempt with exponential backoff
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
  const delay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1)
  return Math.min(delay, options.maxDelayMs)
}

/**
 * Execute a function with automatic retry on transient failures
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options (optional)
 * @returns The result of the function if successful
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxAttempts: 5, initialDelayMs: 500 }
 * )
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options }

  if (opts.maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1')
  }

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't retry if this is the last attempt
      if (attempt >= opts.maxAttempts) {
        break
      }

      // Don't retry if the error is not retryable
      if (!isRetryableError(error)) {
        break
      }

      // Calculate delay and wait before retrying
      const delay = calculateDelay(attempt, opts)
      await sleep(delay)
    }
  }

  // All retries exhausted, throw the last error
  throw lastError
}

/**
 * Create a retry wrapper with pre-configured options
 *
 * @example
 * ```typescript
 * const retryWithDefaults = createRetryWrapper({ maxAttempts: 5 })
 * const result = await retryWithDefaults(() => fetch(url))
 * ```
 */
export function createRetryWrapper(
  defaultOptions: Partial<RetryOptions>
): <T>(fn: () => Promise<T>, options?: Partial<RetryOptions>) => Promise<T> {
  return <T>(fn: () => Promise<T>, options?: Partial<RetryOptions>) =>
    withRetry(fn, { ...defaultOptions, ...options })
}
