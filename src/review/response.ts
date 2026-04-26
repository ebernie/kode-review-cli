/**
 * Extract review text from a pi `AgentSession` after `prompt()` resolves.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { TextContent } from '@mariozechner/pi-ai'
import { logger } from '../utils/logger.js'

/**
 * Find the last assistant message and join its text-content parts.
 *
 * Throws when no assistant message is found, or when the last assistant
 * message reports a model error.
 */
export function extractReviewContent(messages: AgentMessage[]): string {
  // Walk backwards to find the most recent assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
      const detail = msg.errorMessage ?? msg.stopReason
      logger.debug(`Assistant message error details: ${JSON.stringify(msg)}`)
      throw new Error(`Model returned an error: ${detail}`)
    }

    const text = msg.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()

    if (!text) {
      logger.debug(`Empty assistant message: ${JSON.stringify(msg)}`)
      throw new Error(
        'Review response contained no text content. The model may have returned ' +
        'only tool calls or an empty response. Run with DEBUG=1 for full details.',
      )
    }

    return text
  }

  throw new Error(
    'No assistant message in session — the model did not produce a response.',
  )
}
