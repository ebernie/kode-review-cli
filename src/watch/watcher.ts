import ora from 'ora'
import { select } from '@inquirer/prompts'
import { logger } from '../utils/logger.js'
import { cyan, green, yellow } from '../cli/colors.js'
import type { CliContext } from '../cli/interactive.js'
import type { CliOptions } from '../cli/args.js'
import { getGitHubPRDiff, getGitHubPRInfo } from '../vcs/github.js'
import { getGitLabMRDiff, getGitLabMRInfo } from '../vcs/gitlab.js'
import { runReview, type ReviewOptions } from '../review/engine.js'
import { WatchStateManager } from './state.js'
import { detectReviewRequests, type DetectorConfig } from './detector.js'
import {
  type ReviewRequest,
  type WatchConfig,
  type ReviewOutcome,
  makeReviewRequestKey,
  formatReviewRequest,
} from './types.js'

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

    // Filter out already reviewed
    const newRequests = detection.found.filter(
      (req) => !stateManager.hasBeenReviewed(makeReviewRequestKey(req))
    )

    if (newRequests.length === 0) {
      logger.info('All PRs/MRs have been reviewed previously')
      stateManager.updateLastPollTime()
      return
    }

    logger.success(`${newRequests.length} new PR/MR(s) to review`)

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
 * Review a single PR/MR
 */
async function reviewRequest(
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
    // Fetch diff and info
    let diffContent: string | null
    let prMrInfo: string | undefined

    if (request.platform === 'github') {
      const [diff, info] = await Promise.all([
        getGitHubPRDiff(request.id),
        getGitHubPRInfo(request.id),
      ])
      diffContent = diff
      prMrInfo = info ? JSON.stringify(info, null, 2) : undefined
    } else {
      const [diff, info] = await Promise.all([
        getGitLabMRDiff(request.id),
        getGitLabMRInfo(request.id),
      ])
      diffContent = diff
      prMrInfo = info ? JSON.stringify(info, null, 2) : undefined
    }

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

    // Build review options
    const reviewOptions: ReviewOptions = {
      diffContent,
      context: `Reviewing ${request.platform === 'github' ? 'Pull Request' : 'Merge Request'} #${request.id} from ${request.repository}`,
      prMrInfo,
      provider: cliOptions.provider,
      model: cliOptions.model,
      variant: cliOptions.variant,
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

    // Mark as reviewed
    const outcome: ReviewOutcome = {
      key,
      success: true,
      reviewedAt: new Date().toISOString(),
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
