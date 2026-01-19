/**
 * Platform types
 */
export type Platform = 'github' | 'gitlab'

/**
 * Unified PR/MR representation for watch mode
 */
export interface ReviewRequest {
  /** Platform: github or gitlab */
  platform: Platform
  /** PR number (GitHub) or MR iid (GitLab) */
  id: number
  /** PR/MR title */
  title: string
  /** Web URL to the PR/MR */
  url: string
  /** Repository identifier: "owner/repo" (GitHub) or "group/project" (GitLab) */
  repository: string
  /** ISO timestamp of last update */
  updatedAt: string
  /** PR/MR state */
  state: string
}

/**
 * Unique identifier for a review request
 * Format: "github:owner/repo:123" or "gitlab:group/project:456"
 */
export type ReviewRequestKey = string

/**
 * Outcome of a review attempt
 */
export interface ReviewOutcome {
  /** Unique key identifying the review request */
  key: ReviewRequestKey
  /** Whether the review succeeded */
  success: boolean
  /** ISO timestamp when review was attempted */
  reviewedAt: string
  /** Error message if review failed */
  error?: string
}

/**
 * Configuration for watch mode
 */
export interface WatchConfig {
  /** Polling interval in seconds */
  interval: number
  /** Whether to prompt for PR/MR selection */
  interactive: boolean
  /** Platforms to poll */
  platforms: Platform[]
}

/**
 * Result of detecting review requests
 */
export interface DetectionResult {
  /** Found review requests */
  found: ReviewRequest[]
  /** Errors encountered per platform */
  errors: Array<{ platform: Platform; error: Error }>
}

/**
 * Generate a unique key for a review request
 */
export function makeReviewRequestKey(request: ReviewRequest): ReviewRequestKey {
  return `${request.platform}:${request.repository}:${request.id}`
}

/**
 * Format a review request for display
 */
export function formatReviewRequest(request: ReviewRequest): string {
  const prefix = request.platform === 'github' ? 'PR' : 'MR'
  const symbol = request.platform === 'github' ? '#' : '!'
  return `[${request.platform.toUpperCase()}] ${request.repository} ${prefix} ${symbol}${request.id}: ${request.title}`
}
