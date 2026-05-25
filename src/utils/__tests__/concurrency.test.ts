import { describe, expect, it } from 'vitest'
import { runPool } from '../concurrency.js'

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms))

describe('runPool', () => {
  it('processes every item and returns a result per item', async () => {
    const items = [1, 2, 3, 4, 5]
    const outcome = await runPool(items, 2, async (n) => n * 10)
    expect(outcome.results.slice().sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
    expect(outcome.processed).toBe(5)
    expect(outcome.stopped).toBe(false)
  })

  it('runs `concurrency` lanes in parallel and never exceeds the bound', async () => {
    // A barrier proves real parallelism deterministically: every worker holds
    // until two lanes are simultaneously live. A sequential impl (one lane)
    // could never reach active===2, so it would deadlock and time out —
    // falsifying it. Asserting maxActive===2 also pins the upper bound.
    let active = 0
    let maxActive = 0
    let release!: () => void
    const bothLive = new Promise<void>((r) => {
      release = r
    })
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      if (active === 2) release()
      await bothLive
      active--
    })
    expect(maxActive).toBe(2)
  })

  it('concurrency 1 runs items strictly in input order', async () => {
    const seen: number[] = []
    await runPool([1, 2, 3], 1, async (n) => {
      seen.push(n)
      await tick()
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('requestStop() halts dequeuing new items mid-flight but lets in-flight finish', async () => {
    const started: number[] = []
    const finished: number[] = []
    let resolveBoth!: () => void
    const bothLive = new Promise<void>((r) => {
      resolveBoth = r
    })

    const outcome = await runPool([1, 2, 3, 4, 5, 6], 2, async (n, _i, handle) => {
      started.push(n)
      if (started.length === 2) resolveBoth()
      await bothLive // suspend until both initial lanes are in-flight together
      if (n === started[0]) handle.requestStop() // one lane stops while peer in-flight
      finished.push(n)
      return n
    })

    expect(outcome.stopped).toBe(true)
    // Only the two initially-dequeued items ever start — no item 3+ after stop.
    expect(started.slice().sort((a, b) => a - b)).toEqual([1, 2])
    // Both in-flight workers finished (not cancelled).
    expect(finished.slice().sort((a, b) => a - b)).toEqual([1, 2])
    // Their results are captured, not dropped.
    expect(outcome.results.slice().sort((a, b) => a - b)).toEqual([1, 2])
    expect(outcome.processed).toBe(2)
  })

  it('passes the correct input index to the worker and handles concurrency > item count', async () => {
    const outcome = await runPool(['a', 'b', 'c'], 10, async (item, index) => ({ item, index }))
    expect(outcome.processed).toBe(3)
    expect(outcome.results.slice().sort((x, y) => x.index - y.index)).toEqual([
      { item: 'a', index: 0 },
      { item: 'b', index: 1 },
      { item: 'c', index: 2 },
    ])
  })

  it('a worker throw stops scheduling new work, drains in-flight lanes, then rejects', async () => {
    const started: number[] = []
    let resolveBoth!: () => void
    const bothLive = new Promise<void>((r) => {
      resolveBoth = r
    })
    await expect(
      runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n)
        if (started.length === 2) resolveBoth()
        await bothLive // both initial lanes are in-flight together
        if (n === started[0]) throw new Error('boom') // exactly one lane throws
      }),
    ).rejects.toThrow('boom')
    // The throw set the stop flag, so no item beyond the two initial lanes started.
    expect(started.slice().sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('throws on concurrency < 1 or non-integer concurrency', async () => {
    await expect(runPool([1], 0, async (n) => n)).rejects.toThrow(/concurrency must be >= 1/)
    await expect(runPool([1], 1.5, async (n) => n)).rejects.toThrow(/concurrency must be >= 1/)
  })

  it('returns immediately for an empty item list', async () => {
    const outcome = await runPool([], 4, async (n) => n)
    expect(outcome.results).toEqual([])
    expect(outcome.processed).toBe(0)
  })
})
