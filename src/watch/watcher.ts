import ora from 'ora'
import { select } from '@inquirer/prompts'
import { logger } from '../utils/logger.js'
import { cyan, green, yellow } from '../cli/colors.js'
import type { CliContext } from '../cli/interactive.js'
import type { CliOptions } from '../cli/args.js'
import { getGitHubPRDiff, getGitHubPRInfo } from '../vcs/github.js'
import { getGitLabMRDiff, getGitLabMRInfo } from '../vcs/gitlab.js'
import { runReview, type ReviewOptions } from '../review/engine.js'
import { buildRevalidatePrompt, parseRevalidationBlock } from '../review/revalidate-prompt.js'
import type { Finding } from '../review/finding-schema.js'
import { WatchStateManager } from './state.js'
import { detectReviewRequests, type DetectorConfig } from './detector.js'
import {
  type ReviewRequest,
  type WatchConfig,
  type ReviewOutcome,
  type Platform,
  makeReviewRequestKey,
  formatReviewRequest,
} from './types.js'

/**
 * Extract the head commit SHA from a platform-specific PR/MR info object.
 *
 * GitHub: `gh pr view --json headRefOid` → `{ headRefOid: "abc..." }`.
 * GitLab: `glab mr view -F json` → `{ sha: "abc..." }` and/or
 *   `{ diff_refs: { head_sha: "abc..." } }`. We prefer `sha` and fall back
 *   to `diff_refs.head_sha`.
 *
 * Returns undefined when the info is missing or the expected field is absent —
 * callers must treat undefined as "head ref unknown, fall back to full review".
 */
export function extractHeadRef(platform: Platform, info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const obj = info as Record<string, unknown>
  if (platform === 'github') {
    return typeof obj.headRefOid === 'string' ? obj.headRefOid : undefined
  }
  if (typeof obj.sha === 'string') return obj.sha
  const refs = obj.diff_refs
  if (refs && typeof refs === 'object') {
    const headSha = (refs as Record<string, unknown>).head_sha
    if (typeof headSha === 'string') return headSha
  }
  return undefined
}

/**
 * Options for starting watch mode
 */
export interface WatchModeOptions {
  detectorConfig: DetectorConfig
  watchConfig: WatchConfig
  cliOptions: CliOptions
  ctx: CliContext
}

/**
 * Start watch mode - monitors for PRs/MRs where user is a reviewer.
 * Polls at the configured interval and either auto-reviews or prompts for selection.
 */
export async function startWatchMode(options: WatchModeOptions): Promise<void> {
  const { detectorConfig, watchConfig, cliOptions, ctx } = options

  // Initialize state manager
  const stateManager = new WatchStateManager()

  // Track if shutdown requested
  let shuttingDown = false
  let currentCycle: Promise<void> | null = null

  // Setup graceful shutdown
  const handleShutdown = () => {
    if (shuttingDown) {
      logger.warn('Force shutdown requested')
      process.exit(1)
    }

    shuttingDown = true
    logger.info('')
    logger.info('Shutting down watch mode...')

    // Capture the cycle reference to avoid race condition
    const cycleToWait = currentCycle
    if (cycleToWait) {
      cycleToWait.then(() => {
        logger.info('Watch mode stopped')
        process.exit(0)
      }).catch(() => {
        process.exit(1)
      })
    } else {
      logger.info('Watch mode stopped')
      process.exit(0)
    }
  }

  process.on('SIGINT', handleShutdown)
  process.on('SIGTERM', handleShutdown)

  // Display startup banner
  if (!ctx.quiet) {
    console.log('')
    console.log(cyan('========================================'))
    console.log(cyan('          WATCH MODE STARTED            '))
    console.log(cyan('========================================'))
    console.log('')
    logger.info(`Polling interval: ${watchConfig.interval} seconds`)
    logger.info(`Platforms: ${watchConfig.platforms.join(', ')}`)
    logger.info(`Mode: ${watchConfig.interactive ? 'Interactive (select PR/MR)' : 'Auto-review all'}`)
    logger.info(`State file: ${stateManager.getPath()}`)
    logger.info(`Previously reviewed: ${stateManager.getReviewedCount()} PR/MR(s)`)
    console.log('')
    logger.info('Press Ctrl+C to stop')
    console.log('')
  }

  // Main polling loop
  while (!shuttingDown) {
    currentCycle = runPollCycle({
      detectorConfig,
      watchConfig,
      cliOptions,
      ctx,
      stateManager,
      shuttingDown: () => shuttingDown,
    })

    await currentCycle
    currentCycle = null

    // Wait for next cycle (unless shutting down)
    if (!shuttingDown) {
      await sleep(watchConfig.interval * 1000)
    }
  }
}

/**
 * Run a single poll cycle
 */
async function runPollCycle(options: {
  detectorConfig: DetectorConfig
  watchConfig: WatchConfig
  cliOptions: CliOptions
  ctx: CliContext
  stateManager: WatchStateManager
  shuttingDown: () => boolean
}): Promise<void> {
  const { detectorConfig, watchConfig, cliOptions, ctx, stateManager, shuttingDown } = options

  const cycleStart = new Date()
  logger.info(yellow(`\n[${cycleStart.toLocaleTimeString()}] Starting poll cycle...`))

  try {
    // Detect review requests
    const spinner = ctx.quiet ? null : ora('Detecting PRs/MRs assigned for review...').start()
    const detection = await detectReviewRequests(detectorConfig)
    spinner?.stop()

    // Report any errors
    for (const { platform, error } of detection.errors) {
      logger.warn(`${platform} detection failed: ${error.message}`)
    }

    if (detection.found.length === 0) {
      logger.info('No PRs/MRs found where you are a reviewer')
      stateManager.updateLastPollTime()
      return
    }

    logger.success(`Found ${detection.found.length} PR/MR(s) where you are a reviewer`)

    // Filter out PRs/MRs with permanent failures so we don't hammer them on
    // every poll. Successfully-reviewed entries still flow through so
    // `reviewRequest` can decide whether the head moved (revalidate) or is
    // unchanged (skip) — that decision needs the live head SHA from the API
    // and is made there, not here.
    const newRequests = detection.found.filter((req) => {
      const key = makeReviewRequestKey(req)
      const outcome = stateManager.getOutcome(key)
      if (!outcome) return true
      // Permanent failures stay filtered. Successful prior reviews proceed —
      // `reviewRequest` will fetch the new head SHA and either skip or
      // revalidate as appropriate.
      return outcome.success
    })

    if (newRequests.length === 0) {
      logger.info('No PRs/MRs to (re)review this cycle')
      stateManager.updateLastPollTime()
      return
    }

    logger.success(`${newRequests.length} PR/MR(s) to evaluate`)

    // Select which to review
    let toReview: ReviewRequest[]

    if (watchConfig.interactive) {
      toReview = await promptSelectRequests(newRequests)
    } else {
      // Auto-review all
      toReview = newRequests
    }

    if (toReview.length === 0) {
      logger.info('No PRs/MRs selected for review')
      stateManager.updateLastPollTime()
      return
    }

    // Review each selected request
    for (const request of toReview) {
      if (shuttingDown()) {
        logger.info('Shutdown requested, stopping reviews')
        break
      }

      await reviewRequest(request, cliOptions, ctx, stateManager)
    }

    stateManager.updateLastPollTime()
    logger.info(green('Poll cycle complete'))
  } catch (error) {
    logger.error(`Poll cycle failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Prompt user to select which PRs/MRs to review
 */
async function promptSelectRequests(requests: ReviewRequest[]): Promise<ReviewRequest[]> {
  if (requests.length === 0) {
    return []
  }

  const choices = [
    ...requests.map((req) => ({
      name: formatReviewRequest(req),
      value: req,
    })),
    { name: 'Skip all for this cycle', value: null },
  ]

  const selected = await select({
    message: `Select a PR/MR to review (${requests.length} available):`,
    choices,
  })

  if (selected === null) {
    logger.info('Skipped all reviews for this cycle')
    return []
  }

  return [selected]
}

/**
 * Review a single PR/MR.
 *
 * Exported for tests — production callers go through `runPollCycle`. Three
 * outcomes are possible per call:
 *
 *  - Head unchanged → skip (no model call, no state write).
 *  - Head moved + prior findings → revalidate AND fresh-review, merge by title,
 *    persist once under the new head ref.
 *  - First review or head moved + no priors → fresh review only.
 */
export async function reviewRequest(
  request: ReviewRequest,
  cliOptions: CliOptions,
  ctx: CliContext,
  stateManager: WatchStateManager
): Promise<void> {
  const key = makeReviewRequestKey(request)
  const label = formatReviewRequest(request)

  console.log('')
  console.log(cyan('========================================'))
  console.log(cyan(`Reviewing: ${request.repository} #${request.id}`))
  console.log(cyan(`Title: ${request.title}`))
  console.log(cyan('========================================'))

  const spinner = ctx.quiet ? null : ora('Fetching diff...').start()

  try {
    // Fetch diff and info; keep the parsed info object in scope so we can read
    // the head SHA before serialising it for the prompt.
    let diffContent: string | null
    let infoObj: unknown
    let prMrInfo: string | undefined

    if (request.platform === 'github') {
      const [diff, info] = await Promise.all([
        getGitHubPRDiff(request.id),
        getGitHubPRInfo(request.id),
      ])
      diffContent = diff
      infoObj = info
    } else {
      const [diff, info] = await Promise.all([
        getGitLabMRDiff(request.id),
        getGitLabMRInfo(request.id),
      ])
      diffContent = diff
      infoObj = info
    }
    prMrInfo = infoObj ? JSON.stringify(infoObj, null, 2) : undefined

    if (!diffContent) {
      throw new Error('Failed to fetch diff')
    }

    spinner?.succeed('Diff fetched')

    // Check diff size
    const diffLines = diffContent.split('\n').length
    logger.info(`Diff size: ${diffLines} lines`)

    if (diffLines > 5000) {
      logger.warn(`Large diff detected (${diffLines} lines). Review may take longer.`)
    }

    // Decide between skip / revalidate / full review based on prior head SHA.
    const headRef = extractHeadRef(request.platform, infoObj)
    const prior = stateManager.getOutcome(key)

    // Head unchanged → nothing to do. This must run BEFORE the revalidation
    // branch so a no-op cycle never triggers a needless model call.
    if (prior?.headRef && headRef && prior.headRef === headRef) {
      logger.info(`Skipping ${label}: head unchanged since last review (${headRef.slice(0, 7)})`)
      return
    }

    // Head moved AND we have prior findings → revalidate prior findings against
    // the new diff, then fall through to a fresh review on the same diff. The
    // revalidation step triages stale priors; the fresh review catches new
    // issues introduced by the newly-pushed commits. Both result sets are
    // merged and persisted in a single write at the bottom of this function.
    let revalidatedSurvivors: Finding[] = []
    if (
      prior?.headRef &&
      prior.findings &&
      prior.findings.length > 0 &&
      headRef &&
      prior.headRef !== headRef
    ) {
      const revalidation = await revalidateRequest(
        request,
        prior.findings,
        diffContent,
        prMrInfo,
        headRef,
        cliOptions,
        ctx,
      )
      revalidatedSurvivors = revalidation.survivingFindings
      if (!revalidation.ok) {
        logger.warn(
          `Revalidation failed (${revalidation.error ?? 'unknown error'}). Proceeding with fresh review on the new diff; ` +
            `prior findings retained as-is in the persisted outcome.`,
        )
      }
      // Do NOT return — fall through to the fresh-review block below.
    }

    // Build review options
    const reviewOptions: ReviewOptions = {
      diffContent,
      context: `Reviewing ${request.platform === 'github' ? 'Pull Request' : 'Merge Request'} #${request.id} from ${request.repository}`,
      prMrInfo,
      model: cliOptions.model,
    }

    // Run review
    const reviewSpinner = ctx.quiet ? null : ora('Running code review...').start()
    const result = await runReview(reviewOptions)
    reviewSpinner?.stop()

    // Output result
    if (!ctx.quiet) {
      console.log('')
      console.log(cyan('========================================'))
      console.log(cyan('           CODE REVIEW OUTPUT           '))
      console.log(cyan('========================================'))
      console.log('')
    }

    console.log(result.content)

    if (!ctx.quiet) {
      console.log('')
      console.log(green('========================================'))
      console.log(green('           REVIEW COMPLETE             '))
      console.log(green('========================================'))
    }

    logger.success(`Review complete: ${label}`)

    // Merge any revalidated survivors with the fresh review's findings. Fresh
    // wins on title collision (most current line numbers / phrasing against
    // the new code). On the no-revalidation path, `revalidatedSurvivors` is []
    // so merging is a no-op and the fresh findings are persisted as-is.
    const mergedFindings = mergeFindingsByTitle(revalidatedSurvivors, result.findings)

    // Mark as reviewed
    const outcome: ReviewOutcome = {
      key,
      success: true,
      reviewedAt: new Date().toISOString(),
      headRef,
      findings: mergedFindings,
    }
    stateManager.markReviewed(outcome)
  } catch (error) {
    spinner?.fail('Review failed')
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to review ${label}: ${errorMessage}`)

    // Check if error is retryable (network, timeout, rate limit)
    const isRetryable = isRetryableError(errorMessage)

    if (isRetryable) {
      logger.info('Error appears transient - will retry in next poll cycle')
      // Don't mark as reviewed, so it will be retried
    } else {
      // Mark as reviewed with error to skip future retries for permanent failures
      const outcome: ReviewOutcome = {
        key,
        success: false,
        reviewedAt: new Date().toISOString(),
        error: errorMessage,
      }
      stateManager.markReviewed(outcome)
    }
  }
}

/**
 * Result of a revalidation pass.
 *
 * `survivingFindings` is the prior-findings subset that should be carried
 * forward into the next persisted outcome. When `ok` is false, the caller
 * still receives `priorFindings` here so a downstream fresh review can layer
 * its results on top of an unchanged baseline.
 */
export interface RevalidationResult {
  /** The findings that survived revalidation (still-present + omitted-for-safety). */
  survivingFindings: Finding[]
  /** Whether revalidation completed end-to-end. false → caller retains priors as-is. */
  ok: boolean
  /** Error message when ok=false (caller decides retry vs proceed). */
  error?: string
}

/**
 * Triage prior findings against a new diff after the PR/MR head has moved.
 *
 * Pure: never persists state itself. Returns the surviving findings so the
 * caller can merge them with a fresh-review pass and persist a single outcome
 * under the new head ref.
 *
 * `survivingFindings` contains the LLM-confirmed still-present findings plus
 * any priors the LLM omitted entirely (retained for safety to avoid silent
 * loss). Resolved and unverifiable findings drop off.
 *
 * On any thrown error the function returns `{ ok: false, survivingFindings: priorFindings }`
 * — it does not re-throw. This lets the caller always proceed to the fresh-review
 * step, which is the whole point of the new head-move flow.
 */
export async function revalidateRequest(
  request: ReviewRequest,
  priorFindings: Finding[],
  newDiff: string,
  prMrInfo: string | undefined,
  headRef: string,
  cliOptions: CliOptions,
  ctx: CliContext,
): Promise<RevalidationResult> {
  const label = formatReviewRequest(request)

  console.log('')
  console.log(cyan('========================================'))
  console.log(cyan(`Revalidating: ${request.repository} #${request.id}`))
  console.log(cyan(`Prior findings: ${priorFindings.length}`))
  console.log(cyan(`Head: ${headRef.slice(0, 7)}`))
  console.log(cyan('========================================'))

  const userPrompt = buildRevalidatePrompt({ priorFindings, newDiff, prMrInfo })

  const spinner = ctx.quiet ? null : ora('Re-checking prior findings against new diff...').start()
  try {
    const result = await runReview({
      diffContent: newDiff,
      context: `Revalidating prior findings on ${request.platform} #${request.id}`,
      prMrInfo,
      model: cliOptions.model,
      userPromptOverride: userPrompt,
    })
    spinner?.stop()

    const parsed = parseRevalidationBlock(result.content)
    if (parsed.error) {
      logger.warn(
        `Revalidation output failed to parse (${parsed.error}): ${parsed.detail ?? ''}. Keeping prior findings as-is.`,
      )
      return { survivingFindings: priorFindings, ok: true }
    }

    const resolved = parsed.outcomes.filter((o) => o.status === 'resolved')
    const still = parsed.outcomes.filter((o) => o.status === 'still-present')
    const unverifiable = parsed.outcomes.filter((o) => o.status === 'unverifiable')

    console.log('')
    console.log(green(`Resolved (${resolved.length}):`))
    for (const o of resolved) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    console.log('')
    console.log(yellow(`Still present (${still.length}):`))
    for (const o of still) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    if (unverifiable.length > 0) {
      console.log('')
      console.log(`Unverifiable (${unverifiable.length}):`)
      for (const o of unverifiable) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    }

    // Persist only still-present findings as the new baseline. The model
    // reports `findingTitle` only, so we match by title. If two priors share
    // a title (rare) they are both kept on a still-present match — that's
    // intentional: better to keep a false-positive than silently drop a
    // still-present issue. A composite key would require extending the
    // RevalidationOutcomeSchema, which is out of scope here.
    const survivingTitles = new Set(still.map((o) => o.findingTitle))

    // Detect findings the LLM omitted entirely (not marked still-present, resolved, or
    // unverifiable). Conservative default: treat them as still-present rather than
    // silently dropping them.
    const respondedTitles = new Set(parsed.outcomes.map((o) => o.findingTitle))
    const omitted = priorFindings.filter((f) => !respondedTitles.has(f.title))
    if (omitted.length > 0) {
      logger.warn(
        `Revalidation response omitted ${omitted.length} prior finding(s): ${omitted
          .map((f) => f.title)
          .join(', ')}. Retaining them as still-present to avoid silent loss.`,
      )
      for (const f of omitted) survivingTitles.add(f.title)
    }

    const survivingFindings = priorFindings.filter((f) => survivingTitles.has(f.title))

    logger.success(
      `Revalidation complete: ${label} (${resolved.length} resolved, ${still.length} remaining)`,
    )

    return { survivingFindings, ok: true }
  } catch (error) {
    spinner?.fail('Revalidation failed')
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to revalidate ${label}: ${errorMessage}`)
    // Return rather than throw: the caller will proceed to a fresh review,
    // and we retain priors as-is so they aren't silently dropped on the way.
    return { survivingFindings: priorFindings, ok: false, error: errorMessage }
  }
}

/**
 * Merge two finding lists, dedup by title. Findings from `later` win on
 * collision — used in watch mode when fresh-review findings (later) should
 * supersede revalidated prior findings (earlier) that name the same issue.
 *
 * Title is used as the identity surrogate. Two distinct issues from the same
 * model rarely produce identical titles in practice, and the alternative
 * (full structural dedup on file+line+evidence) would silently retain
 * near-duplicates after small phrasing changes.
 */
export function mergeFindingsByTitle(earlier: Finding[], later: Finding[]): Finding[] {
  const byTitle = new Map<string, Finding>()
  for (const f of earlier) byTitle.set(f.title, f)
  for (const f of later) byTitle.set(f.title, f)
  return Array.from(byTitle.values())
}

/**
 * Check if an error is likely transient and should be retried
 */
function isRetryableError(errorMessage: string): boolean {
  const retryablePatterns = [
    'network',
    'timeout',
    'timed out',
    'rate limit',
    'econnreset',
    'enotfound',
    'socket hang up',
    'connection refused',
    'temporarily unavailable',
    '503',
    '502',
    '429',
  ]

  const lowerMessage = errorMessage.toLowerCase()
  return retryablePatterns.some((pattern) => lowerMessage.includes(pattern))
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
