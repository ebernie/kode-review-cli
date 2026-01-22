import { select, confirm } from '@inquirer/prompts'
import ora from 'ora'
import { parseArgs, type CliOptions, type ReviewScope } from './cli/args.js'
import { createContext, type CliContext } from './cli/interactive.js'
import { cyan, green } from './cli/colors.js'
import { logger, setQuietMode, errorJson } from './utils/logger.js'
import {
  isOnboardingComplete,
  resetConfig,
  getConfig,
} from './config/index.js'
import { runOnboardingWizard, runProviderSetup, setupVcs } from './onboarding/index.js'
import {
  runReview,
  runReviewWithServer,
  runAgenticReview,
  runAgenticReviewWithServer,
  getLocalChanges,
  hasChanges,
  formatChanges,
  getChangesSummary,
  getProjectStructureContext,
  formatProjectStructureContext,
} from './review/index.js'
import {
  detectPlatform,
  getCurrentBranch,
  isGitRepository,
  getGitHubPRs,
  getGitHubPRDiff,
  getGitHubPRInfo,
  getGitLabMRs,
  getGitLabMRDiff,
  getGitLabMRInfo,
  type VcsPlatform,
  getRepoUrl,
  getRepoRoot,
} from './vcs/index.js'
import { startWatchMode, type WatchConfig, type Platform } from './watch/index.js'
import {
  setupIndexer,
  showIndexerStatus,
  indexRepository,
  resetIndex,
  getSemanticContext,
  isIndexerRunning,
  getIndexerStatus,
  handleCleanupIndexer,
  listIndexedRepos,
  extractPrDescriptionInfo,
  parseDiffToModifiedLines,
  maybeEnqueueBackgroundIndexing,
  getBackgroundIndexer,
  formatBackgroundIndexingNotification,
} from './indexer/index.js'

async function handleSetupCommands(options: CliOptions): Promise<boolean> {
  if (options.reset) {
    const confirmed = await confirm({
      message: 'Reset all configuration? This cannot be undone.',
      default: false,
    })

    if (confirmed) {
      resetConfig()
      logger.success('Configuration reset')
    }
    return true
  }

  if (options.setup) {
    await runOnboardingWizard()
    return true
  }

  if (options.setupProvider) {
    await runProviderSetup()
    return true
  }

  if (options.setupVcs) {
    await setupVcs()
    return true
  }

  return false
}

async function handleIndexerCommands(options: CliOptions): Promise<boolean> {
  // Setup indexer
  if (options.setupIndexer) {
    await setupIndexer()
    return true
  }

  // Show status
  if (options.indexStatus) {
    await showIndexerStatus()
    return true
  }

  // List all indexed repositories
  if (options.indexListRepos) {
    await listIndexedRepos()
    return true
  }

  // Index current repository
  if (options.index) {
    if (!(await isGitRepository())) {
      throw new Error('Not in a git repository')
    }

    const repoRoot = await getRepoRoot()
    if (!repoRoot) {
      throw new Error('Could not determine repository root directory.')
    }

    const repoUrl = await getRepoUrl()
    if (!repoUrl) {
      throw new Error('Could not determine repository URL. Ensure you have a git remote configured.')
    }

    // Determine branch: use --index-branch if provided, otherwise use current branch
    let branch: string | undefined = options.indexBranch
    if (!branch) {
      const currentBranch = await getCurrentBranch()
      if (!currentBranch) {
        throw new Error(
          'Cannot determine current branch (detached HEAD state?). ' +
          'Please specify a branch with --index-branch <name>'
        )
      }
      branch = currentBranch
    }

    await indexRepository(repoRoot, repoUrl, branch)
    return true
  }

  // Reset index for current repository
  if (options.indexReset) {
    if (!(await isGitRepository())) {
      throw new Error('Not in a git repository')
    }

    const repoUrl = await getRepoUrl()
    if (!repoUrl) {
      throw new Error('Could not determine repository URL.')
    }

    // Determine branch for reset
    const branch = options.indexBranch

    const confirmMessage = branch
      ? `Reset the index for ${repoUrl}@${branch}?`
      : `Reset the index for ${repoUrl} (all branches)?`

    const confirmed = await confirm({
      message: confirmMessage,
      default: false,
    })

    if (confirmed) {
      await resetIndex(repoUrl, branch)
    }
    return true
  }

  // Watch mode indexing (continuous)
  if (options.indexWatch) {
    logger.warn('Watch mode indexing is not yet implemented.')
    return true
  }

  // Complete cleanup of the indexer
  if (options.indexerCleanup) {
    await handleCleanupIndexer()
    return true
  }

  // Show background indexing queue
  if (options.indexQueue) {
    await showBackgroundIndexingQueue()
    return true
  }

  // Clear background indexing queue
  if (options.indexQueueClear) {
    const confirmed = await confirm({
      message: 'Clear all pending background indexing jobs?',
      default: false,
    })

    if (confirmed) {
      const indexer = getBackgroundIndexer()
      indexer.clearQueue()
      logger.success('Background indexing queue cleared')
    }
    return true
  }

  // Start background indexer daemon
  if (options.backgroundIndexer) {
    await runBackgroundIndexerDaemon()
    return true
  }

  return false
}

async function showBackgroundIndexingQueue(): Promise<void> {
  const indexer = getBackgroundIndexer()
  const jobs = indexer.getAllJobs()
  const progress = indexer.getProgress()

  console.log('')
  console.log('Background Indexing Queue')
  console.log('=' .repeat(60))
  console.log('')
  console.log(`Status: ${progress.isRunning ? green('Running') : 'Stopped'}`)
  console.log(`Pending: ${progress.pendingCount}`)
  console.log(`Completed (this session): ${progress.completedCount}`)
  console.log(`Failed (this session): ${progress.failedCount}`)

  if (progress.currentJob) {
    console.log('')
    console.log('Currently Processing:')
    console.log(`  ${progress.currentJob.repoUrl}@${progress.currentJob.branch}`)
    console.log(`  Files: ${progress.currentJob.fileCount}`)
  }

  const pendingJobs = jobs.filter(j => j.status === 'pending')
  if (pendingJobs.length > 0) {
    console.log('')
    console.log('Pending Jobs:')
    for (const job of pendingJobs) {
      console.log(`  - ${job.repoUrl}@${job.branch} (${job.fileCount} files, priority: ${job.priority})`)
    }
  }

  const completedJobs = jobs.filter(j => j.status === 'completed').slice(-5)
  if (completedJobs.length > 0) {
    console.log('')
    console.log('Recent Completed:')
    for (const job of completedJobs) {
      const result = job.result
        ? `+${job.result.chunksAdded}/-${job.result.chunksRemoved} chunks`
        : 'no stats'
      console.log(`  - ${job.repoUrl}@${job.branch} (${result})`)
    }
  }

  const failedJobs = jobs.filter(j => j.status === 'failed').slice(-3)
  if (failedJobs.length > 0) {
    console.log('')
    console.log('Recent Failed:')
    for (const job of failedJobs) {
      console.log(`  - ${job.repoUrl}@${job.branch}: ${job.error}`)
    }
  }

  console.log('')
  console.log('=' .repeat(60))
}

async function runBackgroundIndexerDaemon(): Promise<void> {
  logger.info('Starting background indexer daemon...')
  logger.info('Press Ctrl+C to stop')
  console.log('')

  const indexer = getBackgroundIndexer()

  // Set up event handlers for progress display
  indexer.on('job_started', (event) => {
    logger.info(`Started: ${event.job.repoUrl}@${event.job.branch} (${event.job.fileCount} files)`)
  })

  indexer.on('job_completed', (event) => {
    const result = event.job.result
    logger.success(
      `Completed: ${event.job.repoUrl}@${event.job.branch} ` +
        `(+${result?.chunksAdded || 0}/-${result?.chunksRemoved || 0} chunks ` +
        `in ${result?.elapsedSeconds?.toFixed(1) || '?'}s)`
    )
  })

  indexer.on('job_failed', (event) => {
    logger.error(`Failed: ${event.job.repoUrl}@${event.job.branch} - ${event.error}`)
  })

  // Start the indexer
  indexer.start()

  // Set up graceful shutdown
  let shuttingDown = false

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true

    console.log('')
    logger.info('Shutting down background indexer...')
    await indexer.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep the process running
  await new Promise(() => {
    // This promise never resolves - we wait for shutdown signal
  })
}

async function runWatchMode(options: CliOptions, ctx: CliContext): Promise<void> {
  let config = getConfig()

  // Check if VCS is configured - if not, auto-detect
  let githubEnabled = config.github.enabled && config.github.authenticated
  let gitlabEnabled = config.gitlab.enabled && config.gitlab.authenticated

  if (!githubEnabled && !gitlabEnabled) {
    logger.info('VCS not configured yet, detecting GitHub/GitLab CLI status...')
    const vcsResult = await setupVcs()
    githubEnabled = vcsResult.github.enabled && vcsResult.github.authenticated
    gitlabEnabled = vcsResult.gitlab.enabled && vcsResult.gitlab.authenticated
  }

  if (!githubEnabled && !gitlabEnabled) {
    throw new Error(
      'No VCS platforms authenticated for watch mode. Please authenticate with GitHub CLI (gh auth login) or GitLab CLI (glab auth login).'
    )
  }

  // Build platforms list
  const platforms: Platform[] = []
  if (githubEnabled) platforms.push('github')
  if (gitlabEnabled) platforms.push('gitlab')

  // Build watch config
  const watchConfig: WatchConfig = {
    interval: options.watchInterval,
    interactive: options.watchInteractive,
    platforms,
  }

  // Start watch mode
  await startWatchMode({
    detectorConfig: {
      githubEnabled,
      gitlabEnabled,
    },
    watchConfig,
    cliOptions: options,
    ctx,
  })
}

async function selectPrMr(
  ctx: CliContext,
  platform: VcsPlatform,
  branch: string,
  explicitPr?: string
): Promise<{ id: number; platform: VcsPlatform } | null> {
  // If explicit PR specified, use it
  if (explicitPr) {
    const id = parseInt(explicitPr, 10)
    if (isNaN(id)) {
      logger.error(`Invalid PR/MR number: ${explicitPr}`)
      return null
    }
    return { id, platform }
  }

  // Fetch PRs/MRs
  if (platform === 'github') {
    const prs = await getGitHubPRs(branch)

    if (prs.length === 0) {
      return null
    }

    if (prs.length === 1) {
      return { id: prs[0].number, platform }
    }

    // Multiple PRs - need selection
    if (!ctx.interactive) {
      logger.warn(`Multiple PRs found, selecting first: #${prs[0].number}`)
      return { id: prs[0].number, platform }
    }

    const choices = [
      ...prs.map((pr) => ({
        name: `PR #${pr.number}: ${pr.title}`,
        value: pr.number,
      })),
      { name: 'Skip PR review', value: 0 },
    ]

    const selected = await select({
      message: 'Multiple PRs found. Select one to review:',
      choices,
    })

    if (selected === 0) return null
    return { id: selected, platform }
  }

  if (platform === 'gitlab') {
    const mrs = await getGitLabMRs(branch)

    if (mrs.length === 0) {
      return null
    }

    if (mrs.length === 1) {
      return { id: mrs[0].iid, platform }
    }

    if (!ctx.interactive) {
      logger.warn(`Multiple MRs found, selecting first: !${mrs[0].iid}`)
      return { id: mrs[0].iid, platform }
    }

    const choices = [
      ...mrs.map((mr) => ({
        name: `MR !${mr.iid}: ${mr.title}`,
        value: mr.iid,
      })),
      { name: 'Skip MR review', value: 0 },
    ]

    const selected = await select({
      message: 'Multiple MRs found. Select one to review:',
      choices,
    })

    if (selected === 0) return null
    return { id: selected, platform }
  }

  return null
}

async function determineScope(
  ctx: CliContext,
  options: CliOptions,
  hasLocalChanges: boolean,
  hasPrMr: boolean
): Promise<ReviewScope> {
  // If explicit scope provided, use it
  if (options.scope && options.scope !== 'auto') {
    return options.scope
  }

  // Auto-determine scope
  if (hasLocalChanges && hasPrMr) {
    if (!ctx.interactive) {
      // Non-interactive: default to both
      logger.info('Non-interactive mode: reviewing both local changes and PR/MR')
      return 'both'
    }

    const choices = [
      { name: 'Review local changes only', value: 'local' as const },
      { name: 'Review PR/MR only', value: 'pr' as const },
      { name: 'Review both', value: 'both' as const },
    ]

    return await select({
      message: 'Both local changes and a PR/MR were found. What would you like to review?',
      choices,
    })
  }

  if (hasLocalChanges) return 'local'
  if (hasPrMr) return 'pr'

  return 'local' // Default
}

async function runCodeReview(options: CliOptions, ctx: CliContext): Promise<void> {
  // Check if we're in a git repository
  if (!(await isGitRepository())) {
    throw new Error('Not in a git repository')
  }

  // Detect platform and branch
  const platform = await detectPlatform()
  const branch = await getCurrentBranch()

  if (!branch) {
    throw new Error('Could not determine current branch')
  }

  logger.info(`Platform: ${platform}, Branch: ${branch}`)

  // Check for local changes
  const localChanges = await getLocalChanges()
  const hasLocal = hasChanges(localChanges)

  if (hasLocal) {
    logger.success('Found local changes')
    if (ctx.interactive) {
      console.log(cyan(getChangesSummary(localChanges)))
    }
  }

  // Check for PR/MR (unless scope is explicitly local)
  let prMr: { id: number; platform: VcsPlatform } | null = null

  if (options.scope !== 'local' && platform !== 'unknown') {
    logger.info(`Checking for ${platform === 'github' ? 'GitHub PRs' : 'GitLab MRs'}...`)
    prMr = await selectPrMr(ctx, platform, branch, options.pr)

    if (prMr) {
      logger.success(`Selected ${platform === 'github' ? 'PR' : 'MR'} #${prMr.id}`)
    }
  }

  // Determine what to review
  const scope = await determineScope(ctx, options, hasLocal, prMr !== null)

  // Validate we have something to review
  if (scope === 'local' && !hasLocal) {
    throw new Error('No local changes to review')
  }

  if (scope === 'pr' && !prMr) {
    throw new Error('No PR/MR found to review')
  }

  // Build review context and diff
  const contextParts: string[] = []
  let diffContent = ''
  let prMrInfo: string | undefined
  let prDescription: string | undefined // Raw PR/MR description for semantic context biasing
  let prDescriptionSummary: string | undefined // Extracted summary for LLM prompt

  if ((scope === 'local' || scope === 'both') && hasLocal) {
    contextParts.push(`Reviewing local changes (staged and unstaged) on branch '${branch}'.`)
    diffContent += formatChanges(localChanges)
  }

  if ((scope === 'pr' || scope === 'both') && prMr) {
    if (prMr.platform === 'github') {
      contextParts.push(`Reviewing GitHub Pull Request #${prMr.id}.`)

      const [prDiff, prInfo] = await Promise.all([
        getGitHubPRDiff(prMr.id),
        getGitHubPRInfo(prMr.id),
      ])

      if (!prDiff) {
        throw new Error(`Failed to fetch diff for PR #${prMr.id}. Check that the PR exists and you have access.`)
      }

      diffContent += `\n=== PULL REQUEST #${prMr.id} CHANGES ===\n\n${prDiff}`

      if (prInfo) {
        prMrInfo = JSON.stringify(prInfo, null, 2)
        // Extract description for semantic context biasing
        prDescription = prInfo.body
        // Extract summary for LLM prompt
        const descriptionInfo = extractPrDescriptionInfo(prDescription)
        if (descriptionInfo) {
          prDescriptionSummary = descriptionInfo.summary
        }
      }
    } else {
      contextParts.push(`Reviewing GitLab Merge Request !${prMr.id}.`)

      const [mrDiff, mrInfo] = await Promise.all([
        getGitLabMRDiff(prMr.id),
        getGitLabMRInfo(prMr.id),
      ])

      if (!mrDiff) {
        throw new Error(`Failed to fetch diff for MR !${prMr.id}. Check that the MR exists and you have access.`)
      }

      diffContent += `\n=== MERGE REQUEST !${prMr.id} CHANGES ===\n\n${mrDiff}`

      if (mrInfo) {
        prMrInfo = JSON.stringify(mrInfo, null, 2)
        // Extract description for semantic context biasing
        prDescription = mrInfo.description
        // Extract summary for LLM prompt
        const descriptionInfo = extractPrDescriptionInfo(prDescription)
        if (descriptionInfo) {
          prDescriptionSummary = descriptionInfo.summary
        }
      }
    }
  }

  // Check diff size
  const diffLines = diffContent.split('\n').length
  logger.info(`Total diff size: ${diffLines} lines`)

  if (diffLines > 5000) {
    logger.warn(`Large diff detected (${diffLines} lines). Review may take longer.`)

    if (ctx.interactive) {
      const continueAnyway = await confirm({
        message: 'Continue anyway?',
        default: true,
      })

      if (!continueAnyway) {
        throw new Error('Review cancelled by user')
      }
    }
  }

  // Get project structure context (always included for architectural understanding)
  let projectStructureContext: string | undefined
  const repoRoot = await getRepoRoot()

  if (repoRoot) {
    try {
      logger.info('Gathering project structure context...')
      const structureContext = await getProjectStructureContext(repoRoot, diffContent)
      projectStructureContext = formatProjectStructureContext(structureContext)
      logger.success('Project structure context gathered')
    } catch (error) {
      logger.warn('Could not gather project structure context')
      logger.debug(`Error: ${error}`)
    }
  }

  // Retrieve semantic context if requested
  let semanticContext: string | undefined

  if (options.withContext) {
    const config = getConfig()
    const indexerRunning = await isIndexerRunning()

    // Check if indexer is properly set up and running
    if (!config.indexer.enabled || !indexerRunning) {
      const reason = !config.indexer.enabled
        ? 'Indexer has not been set up'
        : 'Indexer containers are not running'

      logger.warn(`${reason}. Semantic context will not be available.`)
      console.log('')
      console.log('To set up the indexer, run:')
      console.log('  kode-review --setup-indexer')
      console.log('')

      if (!ctx.quiet) {
        const continueWithoutContext = await confirm({
          message: 'Continue review without semantic context?',
          default: true,
        })

        if (!continueWithoutContext) {
          logger.info('Review cancelled by user')
          process.exit(0)
        }
      }
    } else {
      const repoUrl = await getRepoUrl()
      if (repoUrl) {
        try {
          logger.info('Retrieving semantic context...')
          const context = await getSemanticContext({
            diffContent,
            repoUrl,
            topK: options.contextTopK,
            maxTokens: config.indexer.maxContextTokens,
            prDescription, // Include PR description for intent biasing
          })

          if (context) {
            semanticContext = context
            logger.success('Semantic context retrieved')
          } else {
            logger.info('No relevant semantic context found')
          }
        } catch (error) {
          logger.warn('Could not retrieve semantic context')
          logger.debug(`Error: ${error}`)
        }

        // Check if background re-indexing should be triggered for large repos
        // This happens asynchronously - reviews proceed with potentially stale index
        try {
          const parsedDiff = parseDiffToModifiedLines(diffContent)
          const fileCount = parsedDiff.fileChanges.size

          if (fileCount > 0 && repoRoot) {
            const branch = await getCurrentBranch()
            const { enqueued, job } = maybeEnqueueBackgroundIndexing({
              repoUrl,
              repoPath: repoRoot,
              branch: branch || 'main',
              fileCount,
            })

            if (enqueued && job) {
              logger.info(
                `Large change detected (${fileCount} files). ` +
                  'Background re-indexing queued - review proceeding with current index.'
              )

              // Start the background indexer if not already running
              const indexer = getBackgroundIndexer()
              if (!indexer.getProgress().isRunning) {
                indexer.start()

                // Set up notification for when indexing completes
                indexer.once('job_completed', (event) => {
                  if (!ctx.quiet) {
                    console.log('')
                    console.log(green(formatBackgroundIndexingNotification(event.job)))
                  }
                })

                indexer.once('job_failed', (event) => {
                  logger.warn(formatBackgroundIndexingNotification(event.job))
                })
              }
            }
          }
        } catch (bgError) {
          // Background indexing errors should not affect the review
          logger.debug(`Background indexing check failed: ${bgError}`)
        }
      }
    }
  }

  // Run review
  if (!ctx.quiet) {
    console.log('')
    console.log(cyan('========================================'))
    if (options.agentic) {
      console.log(cyan('      AGENTIC CODE REVIEW OUTPUT        '))
    } else {
      console.log(cyan('           CODE REVIEW OUTPUT           '))
    }
    console.log(cyan('========================================'))
    console.log('')
  }

  const spinner = ctx.quiet ? null : ora(
    options.agentic ? 'Running agentic code review...' : 'Running code review...'
  ).start()

  try {
    // Handle agentic review mode
    if (options.agentic) {
      // Agentic mode requires the indexer to be running
      const indexerStatus = await getIndexerStatus()

      if (!indexerStatus.running || !indexerStatus.apiUrl) {
        spinner?.fail('Indexer not running')
        throw new Error(
          'Agentic review requires the code indexer to be running.\n' +
          'Start the indexer with: kode-review --setup-indexer\n' +
          'Then index your repository with: kode-review --index'
        )
      }

      const repoUrl = await getRepoUrl()
      if (!repoUrl) {
        spinner?.fail('Could not determine repository URL')
        throw new Error(
          'Could not determine repository URL. Ensure you have a git remote configured.'
        )
      }

      const agenticOptions = {
        diffContent,
        context: contextParts.join('\n'),
        repoRoot: repoRoot!,
        repoUrl,
        branch: branch,
        indexerUrl: indexerStatus.apiUrl,
        prMrInfo,
        prDescriptionSummary,
        projectStructureContext,
        provider: options.provider,
        model: options.model,
        variant: options.variant,
        maxIterations: options.maxIterations,
        timeout: options.agenticTimeout,
      }

      let result

      if (options.attach) {
        result = await runAgenticReviewWithServer(options.attach, agenticOptions)
      } else {
        result = await runAgenticReview(agenticOptions)
      }

      spinner?.stop()

      console.log(result.content)

      if (!ctx.quiet) {
        console.log('')
        if (result.toolCallCount > 0) {
          console.log(cyan(`Tool calls made: ${result.toolCallCount}`))
        }
        if (result.truncated) {
          console.log(cyan(`Note: Review was truncated (${result.truncationReason})`))
        }
        console.log('')
        console.log(green('========================================'))
        console.log(green('       AGENTIC REVIEW COMPLETE          '))
        console.log(green('========================================'))
      }
    } else {
      // Standard review mode
      const reviewOptions = {
        diffContent,
        context: contextParts.join('\n'),
        prMrInfo,
        semanticContext,
        prDescriptionSummary,
        projectStructureContext,
        provider: options.provider,
        model: options.model,
        variant: options.variant,
      }

      let result

      if (options.attach) {
        result = await runReviewWithServer(options.attach, reviewOptions)
      } else {
        result = await runReview(reviewOptions)
      }

      spinner?.stop()

      console.log(result.content)

      if (!ctx.quiet) {
        console.log('')
        console.log(green('========================================'))
        console.log(green('           REVIEW COMPLETE             '))
        console.log(green('========================================'))
      }
    }
  } catch (error) {
    spinner?.fail('Review failed')
    throw error
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv)
  const ctx = createContext(options)

  // Set quiet mode for logger
  setQuietMode(options.quiet)

  try {
    // Handle setup commands first
    if (await handleSetupCommands(options)) {
      return
    }

    // Handle indexer commands
    if (await handleIndexerCommands(options)) {
      return
    }

    // Check if onboarding is needed
    if (!isOnboardingComplete()) {
      if (ctx.interactive) {
        await runOnboardingWizard()

        // If user just completed onboarding, ask if they want to run a review
        const runNow = await confirm({
          message: 'Run a code review now?',
          default: true,
        })

        if (!runNow) {
          return
        }
      } else {
        // Non-interactive mode but no config - error
        throw new Error(
          'Configuration not found. Run "kode-review --setup" first, or configure interactively.'
        )
      }
    }

    // Check if watch mode requested
    if (options.watch) {
      await runWatchMode(options, ctx)
      return
    }

    // Run code review
    await runCodeReview(options, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (options.json) {
      errorJson(message)
    } else {
      logger.error(message)
    }

    process.exit(1)
  }
}

main()
