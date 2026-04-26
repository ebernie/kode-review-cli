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
  let settled = false
  let resolveDone: () => void = () => {}

  // `done` is consumed by `Promise.race` in the engine. We never reject it —
  // when the engine bails early (timeout/error), the timeout/error promise
  // wins the race and `done` is left to be GC'd. Rejecting `done` would
  // produce an unhandled rejection on Node ≥15.
  const done = new Promise<void>((resolve) => {
    resolveDone = () => {
      if (settled) return
      settled = true
      resolve()
    }
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
