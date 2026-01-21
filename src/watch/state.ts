import Conf from 'conf'
import { z } from 'zod'
import type { ReviewRequestKey, ReviewOutcome } from './types.js'

/**
 * Schema for persisted review outcomes
 */
const ReviewOutcomeSchema = z.object({
  key: z.string(),
  success: z.boolean(),
  reviewedAt: z.string(),
  error: z.string().optional(),
})

/**
 * Schema for watch state
 */
const _WatchStateSchema = z.object({
  reviewedRequests: z.record(z.string(), ReviewOutcomeSchema),
  lastPollTime: z.string().optional(),
})

type WatchState = z.infer<typeof _WatchStateSchema>

/**
 * Manages persistent state for watch mode.
 * Tracks which PRs/MRs have been reviewed to avoid duplicates.
 */
export class WatchStateManager {
  private store: Conf<WatchState>

  constructor(storeName = 'kode-review-watch') {
    this.store = new Conf<WatchState>({
      projectName: storeName,
      defaults: {
        reviewedRequests: {},
        lastPollTime: undefined,
      },
    })
  }

  /**
   * Check if a review request has been reviewed
   */
  hasBeenReviewed(key: ReviewRequestKey): boolean {
    const requests = this.store.get('reviewedRequests')
    return key in requests
  }

  /**
   * Mark a review request as reviewed
   */
  markReviewed(outcome: ReviewOutcome): void {
    const requests = this.store.get('reviewedRequests')
    requests[outcome.key] = outcome
    this.store.set('reviewedRequests', requests)
  }

  /**
   * Get all reviewed request keys
   */
  getReviewedKeys(): ReviewRequestKey[] {
    const requests = this.store.get('reviewedRequests')
    return Object.keys(requests)
  }

  /**
   * Get a specific review outcome
   */
  getOutcome(key: ReviewRequestKey): ReviewOutcome | undefined {
    const requests = this.store.get('reviewedRequests')
    return requests[key]
  }

  /**
   * Update last poll time
   */
  updateLastPollTime(): void {
    this.store.set('lastPollTime', new Date().toISOString())
  }

  /**
   * Get last poll time
   */
  getLastPollTime(): Date | null {
    const time = this.store.get('lastPollTime')
    return time ? new Date(time) : null
  }

  /**
   * Clear all state (for reset)
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Get the file path of the state store
   */
  getPath(): string {
    return this.store.path
  }

  /**
   * Get number of reviewed requests
   */
  getReviewedCount(): number {
    const requests = this.store.get('reviewedRequests')
    return Object.keys(requests).length
  }
}
