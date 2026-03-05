import type { TextPart } from '@opencode-ai/sdk'
import { logger } from '../utils/logger.js'

interface ModelError {
  name: string
  data: Record<string, unknown>
}

interface PromptResponseData {
  info?: {
    error?: ModelError
    [key: string]: unknown
  }
  parts?: Array<{ type: string; text?: string; [key: string]: unknown }>
}

/**
 * Extract text content from an OpenCode prompt response, with proper error handling.
 *
 * The OpenCode SDK may return HTTP 200 with an error in `info.error` when the
 * model/provider fails (auth errors, API errors, aborted messages, etc.).
 * In these cases, `parts` may be undefined or empty. This function checks for
 * such errors and surfaces an actionable message.
 */
export function extractResponseContent(data: PromptResponseData): string {
  // Check for model/provider errors embedded in the response
  const modelError = data.info?.error
  if (modelError) {
    const errorMessage = typeof modelError.data?.message === 'string'
      ? modelError.data.message
      : modelError.name
    const isRetryable = modelError.data?.isRetryable === true
    logger.debug(`Model error details: ${JSON.stringify(modelError)}`)
    throw new Error(
      `Model returned an error: ${errorMessage}` +
      (isRetryable ? ' (retryable)' : '')
    )
  }

  const parts = data.parts
  if (!parts || parts.length === 0) {
    // Log full response for debugging — this is the only way to diagnose
    // what the OpenCode server actually returned
    logger.debug(`Full response data: ${JSON.stringify(data, null, 2)}`)

    // Surface key details in the error message itself so users don't need DEBUG=1
    const infoSummary = data.info
      ? `modelID=${(data.info as Record<string, unknown>).modelID ?? 'unknown'}, ` +
        `providerID=${(data.info as Record<string, unknown>).providerID ?? 'unknown'}, ` +
        `finish=${(data.info as Record<string, unknown>).finish ?? 'none'}`
      : 'no info in response'
    throw new Error(
      `Review response contained no content (${infoSummary}). ` +
      'The model may have returned an empty response. Run with DEBUG=1 for full response details.'
    )
  }

  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}
