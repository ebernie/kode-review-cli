/**
 * Reviewer runner — resolves reviewer names, builds prompts, and dispatches
 * each reviewer to its own pi `AgentSession` in parallel.
 *
 * Each reviewer runs independently: one reviewer's failure does NOT cancel
 * the others. The result array preserves the order of the resolved reviewers
 * (which is the order returned by `resolveReviewerNames`).
 */

import {
  runAgenticReview,
  runReview,
  type AgenticReviewOptions,
  type ReviewOptions,
} from '../review/engine.js'
import type { Finding } from '../review/finding-schema.js'
import type { UsageTotals } from '../review/usage.js'
import {
  buildReviewerUserPrompt,
  loadReviewerSystemPrompt,
  type ReviewData,
} from './prompts.js'
import {
  BUILTIN_REVIEWER_NAMES,
  listUserReviewerNames,
  resolveReviewer,
  type ReviewerInfo,
} from './registry.js'

export interface ReviewerRunResult {
  reviewer: ReviewerInfo
  /** True when the reviewer produced text. When false, `error` is populated. */
  ok: boolean
  /** Raw review text from the model — present when `ok` is true. */
  content?: string
  /** Error message — present when `ok` is false. */
  error?: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Aggregated token usage + estimated cost. Present when `ok` is true. */
  usage?: UsageTotals
  /**
   * Structured findings parsed from the reviewer's output. Optional — failure
   * cases have nothing to populate, and not every consumer asks for them.
   */
  findings?: Finding[]
  /** Number of tool calls the agent made. Only populated in agentic mode. */
  toolCallCount?: number
  /** True when the agent hit maxIterations and was forced to finalize. */
  truncated?: boolean
  /** Human-readable truncation reason when `truncated` is true. */
  truncationReason?: string
}

export interface RunReviewersOptions {
  /** Reviewer names to run (post-resolution: no duplicates, no `all`). */
  reviewers: ReviewerInfo[]
  /** Common review data shared by every reviewer. */
  data: ReviewData
  /** Optional pi model pattern. */
  model?: string
  /** Per-reviewer timeout in ms. */
  timeoutMs?: number
  /** Notification hook fired when a reviewer completes (success or failure). */
  onReviewerComplete?: (result: ReviewerRunResult) => void
}

/**
 * Resolve a list of name tokens — as parsed from `--reviewer` — into the
 * concrete reviewer set to run.
 *
 * Rules:
 *   - The token `all` expands to every available reviewer (built-ins +
 *     user-defined). It is mutually-exclusive shorthand; combining it with
 *     other tokens is allowed but redundant.
 *   - Duplicates are de-duplicated, first occurrence wins.
 *   - Names are validated and resolved through `resolveReviewer()`. Unknown
 *     names throw with a helpful message.
 *
 * Returns reviewers in the order they were requested. For `all`, built-ins
 * come first in their canonical order, then user-defined reviewers
 * (alphabetical).
 */
export function resolveReviewerNames(tokens: string[]): ReviewerInfo[] {
  if (tokens.length === 0) {
    throw new Error('At least one reviewer must be specified.')
  }

  const expanded: string[] = []
  for (const raw of tokens) {
    const token = raw.trim()
    if (token.length === 0) continue
    if (token === 'all') {
      for (const name of BUILTIN_REVIEWER_NAMES) expanded.push(name)
      const userNames = listUserReviewerNames()
      for (const name of userNames) {
        if (!(BUILTIN_REVIEWER_NAMES as readonly string[]).includes(name)) {
          expanded.push(name)
        }
      }
    } else {
      expanded.push(token)
    }
  }

  const seen = new Set<string>()
  const result: ReviewerInfo[] = []
  for (const name of expanded) {
    if (seen.has(name)) continue
    seen.add(name)
    result.push(resolveReviewer(name))
  }

  if (result.length === 0) {
    throw new Error('No reviewers resolved from the provided names.')
  }
  return result
}

/**
 * Run every reviewer in parallel. Returns one result per reviewer in the
 * input order. Failures are captured per-reviewer; this function does not
 * throw on individual reviewer failures.
 */
export async function runReviewers(
  options: RunReviewersOptions,
): Promise<ReviewerRunResult[]> {
  const userPrompt = buildReviewerUserPrompt(options.data)

  const work = options.reviewers.map(async (reviewer): Promise<ReviewerRunResult> => {
    const started = Date.now()
    let systemPrompt: string
    try {
      systemPrompt = loadReviewerSystemPrompt(reviewer)
    } catch (err) {
      const result: ReviewerRunResult = {
        reviewer,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
      options.onReviewerComplete?.(result)
      return result
    }

    try {
      const reviewOptions: ReviewOptions = {
        // The legacy fields are unused when we pass `userPromptOverride`,
        // but the type requires them. Empty strings here are intentional —
        // the system+user prompt pair we pass below is what reaches pi.
        diffContent: '',
        context: '',
        model: options.model,
        systemPrompt,
        userPromptOverride: userPrompt,
        timeoutMs: options.timeoutMs,
      }
      const { content, usage, findings } = await runReview(reviewOptions)
      const result: ReviewerRunResult = {
        reviewer,
        ok: true,
        content,
        durationMs: Date.now() - started,
        usage,
        findings,
      }
      options.onReviewerComplete?.(result)
      return result
    } catch (err) {
      const result: ReviewerRunResult = {
        reviewer,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
      options.onReviewerComplete?.(result)
      return result
    }
  })

  return Promise.all(work)
}

export interface RunAgenticReviewersOptions {
  /** Reviewer names to run (post-resolution: no duplicates, no `all`). */
  reviewers: ReviewerInfo[]
  /**
   * Common agentic data shared by every reviewer (everything except
   * `systemPrompt` and `userPromptOverride`, which the runner sets per
   * reviewer).
   */
  agenticBase: Omit<AgenticReviewOptions, 'systemPrompt' | 'userPromptOverride'>
  /**
   * Optional user prompt override. When undefined, runAgenticReview builds
   * the default agentic prompt from `agenticBase` — that's the recommended
   * shape so every reviewer sees the same structured agentic context.
   */
  userPromptOverride?: string
  /** Notification hook fired when a reviewer completes (success or failure). */
  onReviewerComplete?: (result: ReviewerRunResult) => void
}

/**
 * Agentic analogue of `runReviewers`. Dispatches each reviewer to its own
 * agentic `AgentSession` in parallel, substituting the reviewer's system
 * prompt while preserving the tool-enabled agent loop.
 *
 * One reviewer's failure does NOT cancel the others — failures are captured
 * per-reviewer and surfaced via the returned `ReviewerRunResult`.
 *
 * Returns one result per reviewer in the input order.
 */
export async function runAgenticReviewers(
  options: RunAgenticReviewersOptions,
): Promise<ReviewerRunResult[]> {
  const work = options.reviewers.map(async (reviewer): Promise<ReviewerRunResult> => {
    const started = Date.now()
    let systemPrompt: string
    try {
      systemPrompt = loadReviewerSystemPrompt(reviewer)
    } catch (err) {
      const result: ReviewerRunResult = {
        reviewer,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
      options.onReviewerComplete?.(result)
      return result
    }

    try {
      const agenticOptions: AgenticReviewOptions = {
        ...options.agenticBase,
        systemPrompt,
        userPromptOverride: options.userPromptOverride,
      }
      const { content, usage, findings, toolCallCount, truncated, truncationReason } =
        await runAgenticReview(agenticOptions)
      const result: ReviewerRunResult = {
        reviewer,
        ok: true,
        content,
        durationMs: Date.now() - started,
        usage,
        findings,
        toolCallCount,
        truncated,
        truncationReason,
      }
      options.onReviewerComplete?.(result)
      return result
    } catch (err) {
      const result: ReviewerRunResult = {
        reviewer,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
      options.onReviewerComplete?.(result)
      return result
    }
  })

  return Promise.all(work)
}
