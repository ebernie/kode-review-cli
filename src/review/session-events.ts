/**
 * Event collector for a pi `AgentSession`.
 *
 * Subscribes to the session, counts tool executions, surfaces live tool
 * calls in non-quiet mode, and exposes a "wait until done" promise.
 */

import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent'
import { logger } from '../utils/logger.js'

export interface ReviewEventState {
  toolCallCount: number
  /** Resolved when the session emits `agent_end`. */
  done: Promise<void>
  /** Cancel subscription and reject `done` if not already resolved. */
  unsubscribe: () => void
}

/**
 * Wire up a subscriber to a pi session. Call before `session.prompt(...)`.
 *
 * The returned `done` promise resolves when the agent finishes naturally,
 * and the caller is responsible for racing it against any timeout.
 */
export function attachReviewListener(session: AgentSession): ReviewEventState {
  let toolCallCount = 0
  let resolveDone: () => void = () => {}
  let rejectDone: (err: unknown) => void = () => {}

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case 'tool_execution_start': {
        const argsPreview = previewArgs(event.args)
        logger.debug(`→ tool ${event.toolName}(${argsPreview})`)
        break
      }
      case 'tool_execution_end': {
        toolCallCount++
        if (event.isError) {
          logger.warn(`Tool ${event.toolName} returned an error`)
        }
        break
      }
      case 'agent_end': {
        resolveDone()
        break
      }
      // Other events (message_*, turn_*, queue_update, compaction_*, retry_*)
      // are intentionally ignored — extractReviewContent reads the final
      // session.state.messages directly.
    }
  })

  return {
    get toolCallCount() {
      return toolCallCount
    },
    done,
    unsubscribe: () => {
      unsubscribe()
      // Reject any still-pending listener when the engine bails out early.
      rejectDone(new Error('Listener detached before agent_end'))
    },
  } as ReviewEventState
}

function previewArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args)
    return json.length > 80 ? `${json.slice(0, 77)}...` : json
  } catch {
    return '<unserializable>'
  }
}
