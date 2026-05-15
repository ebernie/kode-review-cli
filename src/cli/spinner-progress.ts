/**
 * Throttled spinner text updates driven by `ReviewProgress` events.
 *
 * Pi emits `tool_execution_*` rapidly during agentic reviews. Updating the
 * spinner text on every event causes flicker and pegs a terminal redraw, so
 * we throttle to ~200ms with a leading + trailing edge: the first event
 * paints immediately, subsequent events within the window are coalesced,
 * and the latest pending value is flushed when the window closes.
 */

import type { ReviewProgress } from '../review/session-events.js'

const DEFAULT_INTERVAL_MS = 200

export interface ProgressSpinner {
  /** Set the spinner's status text. ora's `.text` setter satisfies this. */
  text: string
}

export interface ThrottledProgressHandle {
  /** Schedule a spinner update with the given progress snapshot. */
  update(progress: ReviewProgress): void
  /** Flush any pending update synchronously and stop the trailing timer. */
  flush(): void
  /** Drop the pending update without painting it. */
  dispose(): void
}

export interface ThrottledProgressOptions {
  /** Minimum interval between spinner paints. Default 200ms. */
  intervalMs?: number
  /**
   * Base label rendered before the progress suffix
   * (e.g. "Running agentic code review…"). The suffix is appended verbatim.
   */
  baseLabel: string
  /**
   * Override for `Date.now()` (test seam).
   */
  now?: () => number
  /**
   * Override for `setTimeout`/`clearTimeout` (test seam). The callbacks must
   * have the same fire-once semantics as the global functions.
   */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

/**
 * Build a handle that paints `progress` into `spinner.text` at most once
 * per `intervalMs`. Safe to call `update()` from a hot event loop.
 */
export function createThrottledProgressUpdater(
  spinner: ProgressSpinner,
  options: ThrottledProgressOptions,
): ThrottledProgressHandle {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = options.now ?? Date.now
  const sched = options.scheduler ?? {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }

  let lastPaint = 0
  let pending: ReviewProgress | null = null
  let timer: unknown = null
  // Once true, `update()` is a no-op and `flush()`/`dispose()` are safe to
  // call again. Guards against a late pi event arriving after the CLI has
  // already stopped the spinner.
  let disposed = false

  const paint = (progress: ReviewProgress) => {
    spinner.text = formatProgressLabel(options.baseLabel, progress)
    lastPaint = now()
  }

  const flush = () => {
    if (timer !== null) {
      sched.clearTimeout(timer)
      timer = null
    }
    if (pending) {
      paint(pending)
      pending = null
    }
  }

  return {
    update(progress) {
      if (disposed) return
      const elapsed = now() - lastPaint
      if (elapsed >= interval && timer === null) {
        paint(progress)
        return
      }
      pending = progress
      if (timer !== null) return
      const wait = Math.max(0, interval - elapsed)
      timer = sched.setTimeout(() => {
        timer = null
        if (disposed) return
        if (pending) {
          paint(pending)
          pending = null
        }
      }, wait)
    },
    flush,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        sched.clearTimeout(timer)
        timer = null
      }
      pending = null
    },
  }
}

/**
 * Format the spinner suffix for a progress snapshot. Exported for tests.
 *
 * - 0 tool calls and no in-flight tool: `<baseLabel>`
 * - 0 tool calls but a tool just started: `<baseLabel> (running search_code)`
 * - N tool calls: `<baseLabel> (N tool calls — last: search_code)`
 */
export function formatProgressLabel(baseLabel: string, progress: ReviewProgress): string {
  const { toolCallCount, lastToolName } = progress
  if (toolCallCount === 0) {
    if (lastToolName) return `${baseLabel} (running ${lastToolName})`
    return baseLabel
  }
  const noun = toolCallCount === 1 ? 'tool call' : 'tool calls'
  if (lastToolName) {
    return `${baseLabel} (${toolCallCount} ${noun} — last: ${lastToolName})`
  }
  return `${baseLabel} (${toolCallCount} ${noun})`
}
