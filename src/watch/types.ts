import type { Finding } from '../review/finding-schema.js'
import { sanitizeTerminalText } from '../utils/terminal-safe.js'

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
  /** Head commit SHA at review time. Enables revalidation when the PR head moves. */
  headRef?: string
  /** Parsed structured findings from the review. */
  findings?: Finding[]
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
 * Format a review request for display.
 *
 * `request.title` and `request.repository` originate from external VCS
 * metadata — both are sanitized through sanitizeTerminalText so a
 * malicious PR title can't inject ANSI/OSC sequences (clearing the
 * screen, manipulating the clipboard via OSC 52, etc.) when this label
 * is rendered to the terminal or copied into log captures.
 */
export function formatReviewRequest(request: ReviewRequest): string {
  const prefix = request.platform === 'github' ? 'PR' : 'MR'
  const symbol = request.platform === 'github' ? '#' : '!'
  const repository = sanitizeTerminalText(request.repository)
  const title = sanitizeTerminalText(request.title)
  return `[${request.platform.toUpperCase()}] ${repository} ${prefix} ${symbol}${request.id}: ${title}`
}
