/**
 * Shared helper for the async event-driven OpenCode SDK flow.
 *
 * Subscribe to SSE events -> send prompt async -> wait for session idle -> fetch messages.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import type { Event, Message, Part } from '@opencode-ai/sdk'
import { logger } from '../utils/logger.js'

export interface PromptAndWaitOptions {
  client: OpencodeClient
  sessionId: string
  body: {
    model?: {
      providerID: string
      modelID: string
      variant?: string
    }
    system?: string
    parts: Array<{ type: 'text'; text: string }>
  }
  /** Timeout in milliseconds (default: 180_000 = 3 minutes) */
  timeoutMs?: number
}

export interface SessionMessage {
  info: Message
  parts: Part[]
}

/**
 * Send a prompt asynchronously and wait for the session to become idle,
 * then fetch and return the last assistant message.
 */
export async function promptAndWaitForResponse(
  options: PromptAndWaitOptions
): Promise<SessionMessage> {
  const { client, sessionId, body, timeoutMs = 180_000 } = options

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // 1. Subscribe to SSE events BEFORE sending prompt (avoid race)
    const { stream } = await client.event.subscribe({
      signal: controller.signal,
    })

    // 2. Send prompt asynchronously (returns 204 void)
    const asyncResult = await client.session.promptAsync({
      path: { id: sessionId },
      body,
    })

    if (asyncResult.error) {
      throw new Error(
        `Failed to send prompt: ${JSON.stringify(asyncResult.error)}`
      )
    }

    // 3. Iterate SSE events, waiting for session.idle or session.error
    //    We must ignore idle events that arrive before the prompt is being
    //    processed (the session starts idle before the prompt runs).
    let sawActivity = false

    for await (const event of stream) {
      const typed = event as Event
      const props = typed.properties as Record<string, unknown>
      const eventSessionId = props.sessionID as string | undefined

      logger.debug(`SSE event: ${typed.type}`)

      // Track any sign of the session working on our prompt
      if (eventSessionId === sessionId && typed.type !== 'session.idle') {
        sawActivity = true
      }

      // Filter events for our session
      if (typed.type === 'session.idle') {
        if (eventSessionId === sessionId) {
          if (!sawActivity) {
            logger.debug('Ignoring early session.idle (no activity seen yet)')
            continue
          }
          logger.debug('Session became idle, fetching messages')
          break
        }
      }

      if (typed.type === 'session.error') {
        if (eventSessionId === sessionId) {
          const errorDetail = props.error
            ? `: ${JSON.stringify(props.error)}`
            : ''
          throw new Error(`Session error during prompt${errorDetail}`)
        }
      }
    }

    // 4. Fetch messages
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
    })

    if (!messagesResult.data || messagesResult.data.length === 0) {
      throw new Error('No messages returned after session completion')
    }

    // 5. Return the last assistant message
    const messages = messagesResult.data
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((m) => m.info.role === 'assistant')

    if (!lastAssistantMessage) {
      // The model provider silently failed — session went busy→idle
      // without producing an assistant response.
      const modelInfo = body.model
      const modelDesc = modelInfo
        ? `${modelInfo.providerID}/${modelInfo.modelID}`
        : 'unknown'
      throw new Error(
        `The model provider (${modelDesc}) did not return a response. ` +
        'This usually means the model is unavailable, misconfigured, or the API key has expired.\n' +
        '  Run: kode-review --setup-provider  to reconfigure your provider.'
      )
    }

    return lastAssistantMessage

  } finally {
    clearTimeout(timeout)
    // Abort the SSE stream if still open
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
}

/**
 * Count tool-type parts across all messages in a session.
 */
export function countToolCalls(messages: SessionMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool') {
        count++
      }
    }
  }
  return count
}
