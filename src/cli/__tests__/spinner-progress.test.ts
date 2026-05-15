/**
 * Tests for the throttled spinner progress updater and the label formatter.
 *
 * We drive `setTimeout`/`Date.now()` via the test seam in
 * `createThrottledProgressUpdater` rather than vitest fake timers — the
 * scheduler-injection seam is part of the public contract for this module
 * (used internally to keep the throttle deterministic), so we test against it.
 */

import { describe, it, expect } from 'vitest'
import {
  createThrottledProgressUpdater,
  formatProgressLabel,
  type ProgressSpinner,
} from '../spinner-progress.js'

interface FakeScheduler {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** Fire the first pending timer (FIFO). Returns true if a timer fired. */
  tick: () => boolean
  pendingMs: () => number[]
}

function fakeScheduler(): FakeScheduler {
  const timers: Array<{ id: number; cb: () => void; ms: number }> = []
  let nextId = 1
  return {
    setTimeout(cb, ms) {
      const id = nextId++
      timers.push({ id, cb, ms })
      return id
    },
    clearTimeout(handle) {
      const idx = timers.findIndex((t) => t.id === handle)
      if (idx >= 0) timers.splice(idx, 1)
    },
    tick() {
      const t = timers.shift()
      if (!t) return false
      t.cb()
      return true
    },
    pendingMs() {
      return timers.map((t) => t.ms)
    },
  }
}

function fakeSpinner(): ProgressSpinner & { paints: string[] } {
  const obj = {
    _text: '',
    paints: [] as string[],
    get text() {
      return this._text
    },
    set text(v: string) {
      this._text = v
      this.paints.push(v)
    },
  }
  return obj as ProgressSpinner & { paints: string[] }
}

describe('formatProgressLabel', () => {
  it('returns the base label alone when no tools have run and none are in flight', () => {
    expect(formatProgressLabel('Running review…', { toolCallCount: 0 })).toBe('Running review…')
  })

  it('shows "running <tool>" when the first tool has started but not finished', () => {
    expect(
      formatProgressLabel('Running review…', { toolCallCount: 0, lastToolName: 'read_file' }),
    ).toBe('Running review… (running read_file)')
  })

  it('uses singular "tool call" when count is 1', () => {
    expect(
      formatProgressLabel('Running review…', { toolCallCount: 1, lastToolName: 'read_file' }),
    ).toBe('Running review… (1 tool call — last: read_file)')
  })

  it('uses plural "tool calls" when count > 1', () => {
    expect(
      formatProgressLabel('Running review…', { toolCallCount: 3, lastToolName: 'search_code' }),
    ).toBe('Running review… (3 tool calls — last: search_code)')
  })

  it('omits the "last: …" suffix when lastToolName is missing (defensive — pi always sets it in practice)', () => {
    expect(formatProgressLabel('Running review…', { toolCallCount: 2 })).toBe(
      'Running review… (2 tool calls)',
    )
  })
})

describe('createThrottledProgressUpdater', () => {
  it('paints the first update synchronously then suppresses an immediate second call inside the window', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'read_file' })
    // Same instant: this MUST NOT paint synchronously, even though
    // `elapsed >= interval` is false on the first call. This guards
    // against the SUT regressing to "always paint when no timer pending".
    updater.update({ toolCallCount: 2, lastToolName: 'search_code' })

    expect(spinner.paints).toEqual(['Reviewing… (1 tool call — last: read_file)'])
    // A trailing timer should have been scheduled for the suppressed call.
    expect(sched.pendingMs().length).toBe(1)
  })

  it('coalesces rapid updates inside the throttle window into a single trailing paint', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' })
    // Inside the window: these should NOT paint synchronously.
    nowVal += 50
    updater.update({ toolCallCount: 2, lastToolName: 'b' })
    nowVal += 50
    updater.update({ toolCallCount: 3, lastToolName: 'c' })
    nowVal += 50
    updater.update({ toolCallCount: 4, lastToolName: 'd' })

    // Still only the leading paint has happened.
    expect(spinner.paints).toEqual(['Reviewing… (1 tool call — last: a)'])
    // Exactly one trailing timer should be scheduled.
    expect(sched.pendingMs().length).toBe(1)

    // Fire the trailing timer: only the *latest* pending value paints.
    sched.tick()
    expect(spinner.paints).toEqual([
      'Reviewing… (1 tool call — last: a)',
      'Reviewing… (4 tool calls — last: d)',
    ])
  })

  it('repaints when an update arrives after the throttle window has elapsed', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' })
    nowVal += 250 // Past the window.
    updater.update({ toolCallCount: 2, lastToolName: 'b' })

    expect(spinner.paints).toEqual([
      'Reviewing… (1 tool call — last: a)',
      'Reviewing… (2 tool calls — last: b)',
    ])
    expect(sched.pendingMs()).toEqual([])
  })

  it('flush() paints any pending update, clears the trailing timer, and is idempotent', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' }) // leading paint
    nowVal += 50
    updater.update({ toolCallCount: 5, lastToolName: 'e' }) // queued as pending

    // Precondition: a trailing timer MUST be scheduled for the pending update.
    // Without this assertion, flush() could paint via some unintended path
    // (e.g., not actually triggered by the throttler) and the test still passes.
    expect(sched.pendingMs().length).toBe(1)

    updater.flush()

    expect(spinner.paints).toEqual([
      'Reviewing… (1 tool call — last: a)',
      'Reviewing… (5 tool calls — last: e)',
    ])
    expect(sched.pendingMs()).toEqual([])

    // Second flush is a no-op: pending was already drained.
    updater.flush()
    expect(spinner.paints.length).toBe(2)
  })

  it('dispose() drops the pending update without painting it', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' }) // leading paint
    nowVal += 50
    updater.update({ toolCallCount: 9, lastToolName: 'queued' })

    updater.dispose()
    // Tick: the timer should have been cleared, no further paint.
    sched.tick() // returns false but harmless
    expect(spinner.paints).toEqual(['Reviewing… (1 tool call — last: a)'])
    expect(sched.pendingMs()).toEqual([])
  })

  it('after dispose(), update() is a no-op — guards against late pi events painting a stopped spinner', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' }) // leading paint
    updater.dispose()

    // Time has clearly elapsed past the window — without the disposed guard,
    // this would take the synchronous leading-edge branch and repaint.
    nowVal += 5000
    updater.update({ toolCallCount: 99, lastToolName: 'late' })

    expect(spinner.paints).toEqual(['Reviewing… (1 tool call — last: a)'])
    expect(sched.pendingMs()).toEqual([])
  })

  it('dispose() is idempotent — double-dispose does not throw or paint', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => 1000,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' })
    expect(() => {
      updater.dispose()
      updater.dispose()
    }).not.toThrow()
    expect(spinner.paints.length).toBe(1)
  })


  it('does not schedule a second trailing timer when one is already pending', () => {
    const spinner = fakeSpinner()
    const sched = fakeScheduler()
    let nowVal = 1000
    const updater = createThrottledProgressUpdater(spinner, {
      baseLabel: 'Reviewing…',
      intervalMs: 200,
      now: () => nowVal,
      scheduler: sched,
    })

    updater.update({ toolCallCount: 1, lastToolName: 'a' })
    nowVal += 10
    updater.update({ toolCallCount: 2, lastToolName: 'b' })
    nowVal += 10
    updater.update({ toolCallCount: 3, lastToolName: 'c' })

    expect(sched.pendingMs().length).toBe(1)
  })
})
