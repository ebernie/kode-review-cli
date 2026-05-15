/**
 * Tests for the pi-AgentSession event listener used by the review engine.
 *
 * These exist independently of engine.test.ts because the listener has its
 * own subtle contract — `done` must resolve once on agent_end and never
 * reject; `unsubscribe()` must call the underlying SDK unsubscribe.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { logger } from '../../utils/logger.js'
import { attachReviewListener } from '../session-events.js'

interface FakeSession {
  emit(event: unknown): void
  subscribe: (listener: (event: unknown) => void) => () => void
  unsubscribed: number
}

function createFakeSession(): FakeSession {
  let subscriber: ((event: unknown) => void) | null = null
  return {
    emit(event) { subscriber?.(event) },
    subscribe(listener) {
      subscriber = listener
      return () => {
        subscriber = null
        ;(this as FakeSession).unsubscribed++
      }
    },
    unsubscribed: 0,
  }
}

describe('attachReviewListener', () => {
  it('counts each tool_execution_end event', () => {
    const session = createFakeSession()
    const state = attachReviewListener(session as never)

    session.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'read_file', result: 'ok', isError: false })
    session.emit({ type: 'tool_execution_end', toolCallId: '2', toolName: 'search_code', result: 'ok', isError: false })

    expect(state.toolCallCount).toBe(2)
  })

  it('does not count tool_execution_start events', () => {
    const session = createFakeSession()
    const state = attachReviewListener(session as never)

    session.emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read_file', args: {} })
    session.emit({ type: 'tool_execution_start', toolCallId: '2', toolName: 'search_code', args: {} })

    expect(state.toolCallCount).toBe(0)
  })

  it('emits a logger.warn when a tool completes with isError=true', () => {
    const session = createFakeSession()
    attachReviewListener(session as never)

    session.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'broken_tool', result: '', isError: true })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken_tool'))
  })

  it('resolves done exactly once on agent_end', async () => {
    const session = createFakeSession()
    const state = attachReviewListener(session as never)

    session.emit({ type: 'agent_end', messages: [] })

    await expect(state.done).resolves.toBeUndefined()

    // Second agent_end is a no-op (resolveDone is idempotent).
    session.emit({ type: 'agent_end', messages: [] })
    await expect(state.done).resolves.toBeUndefined()
  })

  it('fires onProgress on tool_execution_start with toolCallCount=0 and the started tool name', () => {
    const session = createFakeSession()
    const updates: Array<{ toolCallCount: number; lastToolName?: string }> = []
    attachReviewListener(session as never, { onProgress: (p) => updates.push({ ...p }) })

    session.emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read_file', args: {} })

    expect(updates).toEqual([{ toolCallCount: 0, lastToolName: 'read_file' }])
  })

  it('fires onProgress on tool_execution_end with the incremented count and last tool name', () => {
    const session = createFakeSession()
    const updates: Array<{ toolCallCount: number; lastToolName?: string }> = []
    attachReviewListener(session as never, { onProgress: (p) => updates.push({ ...p }) })

    session.emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read_file', args: {} })
    session.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'read_file', result: 'ok', isError: false })
    session.emit({ type: 'tool_execution_start', toolCallId: '2', toolName: 'search_code', args: {} })
    session.emit({ type: 'tool_execution_end', toolCallId: '2', toolName: 'search_code', result: 'ok', isError: false })

    expect(updates).toEqual([
      { toolCallCount: 0, lastToolName: 'read_file' },
      { toolCallCount: 1, lastToolName: 'read_file' },
      { toolCallCount: 1, lastToolName: 'search_code' },
      { toolCallCount: 2, lastToolName: 'search_code' },
    ])
  })

  it('does not invoke onProgress for non-tool events (agent_end, etc.)', () => {
    const session = createFakeSession()
    const onProgress = vi.fn()
    attachReviewListener(session as never, { onProgress })

    session.emit({ type: 'agent_end', messages: [] })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('keeps counting and logging warnings even when onProgress throws (defensive)', () => {
    const session = createFakeSession()
    const onProgress = vi.fn(() => {
      throw new Error('subscriber blew up')
    })
    const state = attachReviewListener(session as never, { onProgress })

    // Mix a clean event and an isError event to verify BOTH that the count
    // keeps accumulating AND that logger.warn still fires when the callback
    // is throwing — the error-isolation wrapper must not swallow downstream
    // side effects from the same case branch.
    session.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'a', result: 'ok', isError: false })
    session.emit({ type: 'tool_execution_end', toolCallId: '2', toolName: 'broken', result: '', isError: true })

    expect(state.toolCallCount).toBe(2)
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken'))
  })

  it('unsubscribe() detaches from the session and does NOT reject done', async () => {
    const session = createFakeSession()
    const state = attachReviewListener(session as never)

    state.unsubscribe()
    expect(session.unsubscribed).toBe(1)

    // `done` is left pending intentionally — engine bails out via the
    // timeout/error promise, not via `done` rejecting. Verify done has not
    // been rejected: race it against a microtask deadline.
    const sentinel = Symbol('still-pending')
    const result = await Promise.race([
      state.done.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<typeof sentinel>((resolve) => setImmediate(() => resolve(sentinel))),
    ])
    expect(result).toBe(sentinel)
  })
})
