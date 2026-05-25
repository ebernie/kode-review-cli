/**
 * Bounded async worker pool with cooperative early-stop.
 *
 * Runs up to `concurrency` workers over `items`. A worker may call
 * `handle.requestStop()` to ask the pool to stop dequeuing NEW items;
 * already-in-flight workers run to completion (their side effects are not
 * cancelled). This mirrors the orchestrators' rate-limit semantics: the first
 * worker to hit a hard limit stops further scheduling, but partial progress
 * already persisted to disk is preserved.
 *
 * A worker that *throws* is treated as an unexpected (programming-error) path:
 * the pool stops scheduling new work, lets the other in-flight lanes drain to
 * completion (no abandoned promises / unhandled rejections), then rejects with
 * the first error observed. Consumers that expect per-item failures should
 * catch inside their worker and signal via `requestStop()` instead.
 *
 * Result ordering is completion order, not input order — callers that only
 * aggregate counters (the repo-audit orchestrators) do not depend on order.
 */

export interface PoolHandle {
  /** Ask the pool to stop dequeuing new items. Idempotent. In-flight workers finish. */
  requestStop(): void
  /** True once any worker has called requestStop(). */
  readonly stopRequested: boolean
}

export interface PoolOutcome<R> {
  /** One result per item that completed successfully, in completion order. */
  results: R[]
  /** True if requestStop() was called during the run. */
  stopped: boolean
  /**
   * Number of items a worker was *started* for (i.e. dequeued), regardless of
   * outcome. With cooperative stop this is <= items.length. On a successfully
   * returned outcome, `results.length === processed` (the worker-throw path
   * rejects instead of returning).
   */
  processed: number
}

export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number, handle: PoolHandle) => Promise<R>,
): Promise<PoolOutcome<R>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be >= 1 (got ${concurrency})`)
  }

  const results: R[] = []
  let cursor = 0
  let processed = 0
  let stopRequested = false
  let firstError: unknown
  let hasError = false

  const handle: PoolHandle = {
    requestStop() {
      stopRequested = true
    },
    get stopRequested() {
      return stopRequested
    },
  }

  async function drain(): Promise<void> {
    // Cooperative loop: each worker pulls the next index until the list is
    // exhausted or a stop has been requested. cursor++ is atomic in JS's
    // single-threaded model — no two workers can claim the same index.
    for (;;) {
      if (stopRequested) return
      const index = cursor++
      if (index >= items.length) return
      processed++
      try {
        const r = await worker(items[index]!, index, handle)
        results.push(r)
      } catch (err) {
        // Unexpected throw: stop scheduling, remember the first error, and let
        // the other in-flight lanes drain (their stop check returns them
        // cleanly) before runPool rejects below.
        if (!hasError) {
          hasError = true
          firstError = err
        }
        stopRequested = true
        return
      }
    }
  }

  // lanes === 0 when items is empty, so Promise.all([]) resolves immediately.
  const lanes = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: lanes }, () => drain()))

  if (hasError) throw firstError

  return { results, stopped: stopRequested, processed }
}
