import { select, confirm } from '@inquirer/prompts'
import ora from 'ora'
import { parseArgs, type CliOptions, type ReviewScope } from './cli/args.js'
import { createContext, type CliContext } from './cli/interactive.js'
import { showConfig } from './cli/show-config.js'
import { runDiagnostics, printDiagnostics } from './cli/doctor.js'
import { initHooks } from './cli/init-hooks.js'
import { runUpdate, checkForUpdateNotification } from './cli/update.js'
import { cyan, green } from './cli/colors.js'
import { createThrottledProgressUpdater } from './cli/spinner-progress.js'
import { logger, setQuietMode, setDebugMode } from './utils/logger.js'
import { commandExists } from './utils/exec.js'
import { sanitizeTerminalText } from './utils/terminal-safe.js'
import { AppError, wrapError, formatError, categorizeError } from './utils/errors.js'
import {
  isOnboardingComplete,
  resetConfig,
  getConfig,
} from './config/index.js'
import { runOnboardingWizard, setupVcs, shouldEnforceOnboardingGate } from './onboarding/index.js'
import { needsMigration, runMigration } from './cli/migration.js'
import {
  runAgenticReview,
  getLocalChanges,
  hasChanges,
  formatChanges,
  getChangesSummary,
  getProjectStructureContext,
  formatProjectStructureContext,
  formatUsageOneLiner,
  type UsageTotals,
  type ReviewProgress,
} from './review/index.js'
import {
  detectCiPlatform,
  extractPrNumber,
  resolveCiExitCode,
  buildCommentPayload,
  buildCompositeCiCommentBody,
  parseReviewSummary,
  postCiComment,
  type CiPlatform,
} from './review/ci-mode.js'
import { filterSuppressedFindings } from './review/suppressions.js'
import {
  listAvailableReviewers,
  resolveReviewerNames,
  runReviewers,
  runAgenticReviewers,
  type ReviewerRunResult,
} from './reviewers/index.js'
import {
  detectPlatform,
  getCurrentBranch,
  resolveBranchLabel,
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
  postReviewToPR,
  type Platform as VcsPlatformType,
} from './vcs/index.js'
import { startWatchMode, type WatchConfig, type Platform } from './watch/index.js'
import {
  listFindings as listRepoAuditFindings,
  runRepoAudit,
  writeRepoReport,
} from './repo-audit/index.js'
import {
  parseReviewContent,
  writeReviewOutput,
  type ReviewOutput,
} from './output/index.js'
import {
  AGENT_REGISTRY,
  parseAgentList,
  runAgentInstall,
} from './agent-install/index.js'
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
  // Update command (works without onboarding)
  if (options.update) {
    await runUpdate()
    return true
  }

  // List reviewers (no side effects, works without onboarding)
  if (options.listReviewers) {
    printReviewerList(options.format)
    return true
  }

  // Info commands (no side effects, can run without onboarding)
  if (options.showConfig) {
    showConfig({ json: options.format === 'json' })
    return true
  }

  if (options.doctor) {
    const result = await runDiagnostics()
    printDiagnostics(result)
    process.exit(result.failCount > 0 ? 1 : 0)
  }

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

  if (options.setupVcs) {
    await setupVcs()
    return true
  }

  // Hook generation
  if (options.initHooks) {
    await initHooks({ interactive: !options.quiet })
    return true
  }

  return false
}

async function handleAgentInstallCommands(
  options: CliOptions,
  ctx: CliContext,
): Promise<boolean> {
  if (options.listAgents) {
    if (options.format === 'json') {
      console.log(
        JSON.stringify(
          AGENT_REGISTRY.map((entry) => ({
            name: entry.name,
            displayName: entry.displayName,
            description: entry.description,
            perRepo: entry.perRepo,
          })),
          null,
          2,
        ),
      )
    } else {
      console.log('')
      console.log('Supported agents (--install-agent <name>):')
      console.log('')
      for (const entry of AGENT_REGISTRY) {
        const scope = entry.perRepo ? '(per-repo)' : '(user-level)'
        console.log(`  ${cyan(entry.name.padEnd(14))} ${scope}  ${entry.description}`)
      }
      console.log('')
      console.log('Use "all" to install for every agent, or comma-separate (e.g. claude-code,codex).')
    }
    return true
  }

  if (options.installAgent !== undefined) {
    const agents = parseAgentList(options.installAgent)
    const repoRoot = (await isGitRepository()) ? await getRepoRoot() : null
    await runAgentInstall({
      agents,
      force: options.installAgentForce,
      ctx,
      repoRoot: repoRoot ?? null,
    })
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
        // pr.title is attacker-controlled; sanitize before inquirer
        // renders it to the terminal.
        name: `PR #${pr.number}: ${sanitizeTerminalText(pr.title)}`,
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
        // mr.title is attacker-controlled; sanitize before inquirer
        // renders it to the terminal.
        name: `MR !${mr.iid}: ${sanitizeTerminalText(mr.title)}`,
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

/**
 * Dispatch `--scope repo`. Self-contained — does not consult local diffs or
 * PR/MR detection. Delegates to runRepoAudit() in src/repo-audit/.
 */
export async function runRepoScopeAudit(
  options: CliOptions,
  _ctx: CliContext,
  branch: string,
): Promise<void> {
  const repoRoot = await getRepoRoot()
  if (!repoRoot) {
    throw new Error('Not in a git repository')
  }

  // repoUrl is only needed by the indexer + as a non-fatal hint for the
  // agent. Don't gate --report-only on it: a local-only repo with cached
  // findings should still render.
  const repoUrl = (await getRepoUrl()) ?? ''
  if (!repoUrl && !options.reportOnly) {
    logger.warn(
      'Repo has no origin URL. Proceeding without indexer integration — ' +
        'the agent will use filesystem-only tools.',
    )
  }

  // Optional indexer URL (used by agentic tools for richer search).
  const indexerUrl = await resolveIndexerUrlIfRunning()

  let result: Awaited<ReturnType<typeof runRepoAudit>> | null = null
  let runError: unknown = null
  try {
    result = await runRepoAudit({
      repoRoot,
      repoUrl,
      branch,
      indexerUrl,
      cli: options,
    })
  } catch (err) {
    runError = err
    logger.error(
      `Repo audit terminated early: ${err instanceof Error ? err.message : String(err)}. ` +
        `Rendering whatever findings landed on disk before the failure.`,
    )
  }

  // Always render whatever's on disk — even on hard abort the previously
  // persisted findings are still useful to the user.
  const allFindings = await listRepoAuditFindings(repoRoot)
  await writeRepoReport({
    records: allFindings,
    format: options.format,
    suppressionsDisabled: options.noSuppressions,
    outputFile: options.outputFile,
    quiet: options.quiet,
  })

  if (result) {
    const abortedSuffix = result.aborted ? ' (aborted)' : ''
    logger.success(
      cyan(
        `Repo audit complete${abortedSuffix}: reviewed=${result.featuresReviewed} ` +
          `skipped=${result.featuresSkipped} ` +
          `findings=${result.findingsEmitted} ` +
          `suppressed=${result.findingsSuppressed} ` +
          `on-disk=${result.findingsOnDisk}`,
      ),
    )
    if (result.aborted) {
      logger.warn(`Abort reason: ${result.abortReason ?? '(unspecified)'}`)
    }
  }

  // CI mode: fail on CRITICAL (or HIGH if --fail-on=high).
  // `uncertain` status (set by --revalidate when the agent couldn't determine
  // whether the finding is fixed) is treated the same as `open` — the agent
  // gave up, so a human still needs to look. Letting CI silently pass on
  // uncertain CRITICAL findings would defeat the purpose of the gate.
  if (options.ci) {
    const triggerSev = options.failOn === 'high' ? ['CRITICAL', 'HIGH'] : ['CRITICAL']
    const blockers = allFindings.filter(
      (r) =>
        (r.status === 'open' || r.status === 'uncertain') &&
        triggerSev.includes(r.finding.severity),
    )
    if (options.failOn !== 'none' && blockers.length > 0) {
      const uncertainCount = blockers.filter((r) => r.status === 'uncertain').length
      const uncertainSuffix = uncertainCount > 0 ? ` (${uncertainCount} uncertain)` : ''
      logger.error(
        `CI mode: ${blockers.length} ${options.failOn.toUpperCase()}+ finding(s)${uncertainSuffix}; failing.`,
      )
      process.exit(1)
    }
  }

  // Re-throw any hard error AFTER rendering, so the user still gets their
  // findings file but the shell still sees a non-zero exit.
  if (runError) {
    throw runError
  }
}

/**
 * Return the indexer URL if the indexer is running, else undefined.
 * Mirrors the lookup performed by the diff-scope review path.
 */
async function resolveIndexerUrlIfRunning(): Promise<string | undefined> {
  try {
    const status = await getIndexerStatus()
    if (status.running && status.apiUrl) return status.apiUrl
  } catch {
    // Indexer status probe failure is non-fatal for repo scope; the agent
    // falls back to filesystem-only tools.
  }
  return undefined
}


async function runCodeReview(options: CliOptions, ctx: CliContext): Promise<void> {
  // Check if we're in a git repository
  if (!(await isGitRepository())) {
    throw new Error('Not in a git repository')
  }

  // --ci posts a sticky comment but does NOT route through
  // postReviewToPR, so it never triggers a platform approval mutation
  // regardless of --auto-approve. Surface this so users who pass both
  // flags don't silently get a comment-only run.
  if (options.ci && options.autoApprove) {
    logger.warn(
      '--auto-approve is ignored in --ci mode: the CI sticky-comment path does not call the approval API. Drop --ci or run without --auto-approve to silence this warning.',
    )
  }

  // Detect platform and branch. Detached-HEAD (no current branch) is the
  // norm in CI runs that check out by SHA — fall back to a literal label.
  const platform = await detectPlatform()
  const branch = resolveBranchLabel(await getCurrentBranch(), options)

  logger.info(`Platform: ${platform}, Branch: ${branch}`)

  // --scope repo dispatches to the whole-codebase audit, which has its own
  // flow (clawpatch map → kode-agent review per feature → persist findings).
  // It never consults local changes or PR/MR detection. The --watch +
  // --scope repo guard fires earlier in main() before this point.
  if (options.scope === 'repo') {
    await runRepoScopeAudit(options, ctx, branch)
    return
  }

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

  const baseSpinnerLabel = options.agentic
    ? 'Running agentic code review...'
    : 'Running code review...'
  const spinner = ctx.quiet ? null : ora(baseSpinnerLabel).start()
  const progressUpdater = spinner
    ? createThrottledProgressUpdater(spinner, { baseLabel: baseSpinnerLabel })
    : null
  const onProgress: ((p: ReviewProgress) => void) | undefined = progressUpdater
    ? (p) => progressUpdater.update(p)
    : undefined

  try {
    // Handle agentic review mode
    if (options.agentic) {
      // Check indexer status - optional for agentic mode
      const indexerStatus = await getIndexerStatus()

      // Determine indexer URL (undefined if not running) and pick a one-line
      // info message describing which toolset is active.
      let indexerUrl: string | undefined
      if (indexerStatus.running && indexerStatus.apiUrl) {
        indexerUrl = indexerStatus.apiUrl
        logger.info('Agentic mode: indexer reachable — using indexer-backed search/definitions/usages/call-graph/impact tools')
      } else {
        const rgAvailable = await commandExists('rg')
        if (rgAvailable) {
          logger.info(
            'Agentic mode: indexer not running — using filesystem-backed tools (ripgrep + git). ' +
            'read_file, search_code, find_definitions, find_usages, get_impact, get_commits, get_file_history active. get_call_graph degraded.'
          )
        } else {
          logger.warn(
            'Agentic mode: no indexer and no ripgrep — only read_file, get_call_graph (degraded), get_commits, and get_file_history will be active. ' +
            'Install ripgrep (https://github.com/BurntSushi/ripgrep#installation) for full coverage, or start the indexer with: kode-review --setup-indexer'
          )
        }
      }

      const repoUrl = await getRepoUrl()
      if (!repoUrl) {
        progressUpdater?.dispose()
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
        indexerUrl,  // Optional - undefined when indexer not running
        prMrInfo,
        prDescriptionSummary,
        projectStructureContext,
        model: options.model,
        maxIterations: options.maxIterations,
        timeout: options.agenticTimeout,
        onProgress,
      }

      // Resolve --reviewer tokens. When the user did not pass --reviewer,
      // args.ts defaults `options.reviewers` to ['general'] — we detect this
      // single-default case and preserve the original single-shot agentic
      // path byte-for-byte. Anything else routes through the multi-reviewer
      // agentic path so each requested persona's system prompt is honored.
      const agenticReviewerInfos = resolveReviewerNames(options.reviewers)
      const isDefaultGeneralAgentic =
        agenticReviewerInfos.length === 1 &&
        agenticReviewerInfos[0].name === 'general'

      if (isDefaultGeneralAgentic) {
        const result = await runAgenticReview(agenticOptions)

        progressUpdater?.dispose()
        spinner?.stop()

        // Apply CI / suppression handling on the agentic output. The filtered
        // content is what we both render to the user AND post to the PR.
        const { content: reviewContent, ciExitCode } = await applyCiAndSuppressions(
          result.content,
          options,
          repoRoot!,
          result.usage,
        )

        // Process review output. When --ci posted a sticky comment we suppress
        // the legacy `--post-to-pr` path so we don't double-post.
        await processReviewOutput(reviewContent, options, ctx, prMr, branch, {
          agentic: true,
          toolCallCount: result.toolCallCount,
          truncated: result.truncated,
          truncationReason: result.truncationReason,
          usage: result.usage,
        })

        if (ciExitCode !== undefined) {
          process.exit(ciExitCode)
        }
      } else {
        // Multi-reviewer agentic path — mirrors the non-agentic branch's
        // plumbing (per-reviewer suppressions, worst-exit-code aggregation,
        // composite CI sticky comment, multi-reviewer output rendering).
        if (!ctx.quiet) {
          const names = agenticReviewerInfos.map((r) => r.name).join(', ')
          logger.info(`Dispatching ${agenticReviewerInfos.length} agentic reviewer(s) in parallel: ${names}`)
        }

        // Strip `onProgress` for the parallel path: a single spinner being
        // driven by N reviewers in parallel produces incoherent flicker. The
        // per-reviewer completion line below is the right granularity here.
        const { onProgress: _drop, ...agenticBaseForMulti } = agenticOptions
        const results = await runAgenticReviewers({
          reviewers: agenticReviewerInfos,
          agenticBase: agenticBaseForMulti,
          onReviewerComplete: (r) => {
            if (ctx.quiet) return
            if (r.ok) {
              logger.success(`Reviewer ${r.reviewer.name} completed in ${Math.round(r.durationMs / 100) / 10}s`)
            } else {
              logger.warn(`Reviewer ${r.reviewer.name} failed: ${r.error}`)
            }
          },
        })

        progressUpdater?.dispose()
        spinner?.stop()

        // Mirror the non-agentic branch: per-reviewer suppression filtering
        // and worst-exit-code aggregation. The CI sticky comment is posted
        // ONCE after the loop with one section per reviewer. The composite
        // body doesn't depend on agentic-specific fields, so the same helper
        // works for both modes.
        // TODO: unify with the non-agentic branch's identical loop in a
        // follow-up — copy-paste is acceptable here to keep the single-mode
        // fast path's behavior byte-for-byte identical.
        let aggregateCiExitCode: number | undefined
        for (const r of results) {
          if (!r.ok || r.content === undefined) continue
          const { content: filtered, ciExitCode } = await applyCiAndSuppressions(
            r.content,
            options,
            repoRoot!,
            r.usage,
            { postComment: false },
          )
          r.content = filtered
          if (ciExitCode !== undefined) {
            aggregateCiExitCode =
              aggregateCiExitCode === undefined
                ? ciExitCode
                : Math.max(aggregateCiExitCode, ciExitCode)
          }
        }

        if (options.ci) {
          const successful = results
            .filter((r) => r.ok && r.content !== undefined)
            .map((r) => ({ reviewer: r.reviewer, content: r.content!, usage: r.usage }))
          if (successful.length > 0) {
            await postCiStickyComment(buildCompositeCiCommentBody(successful), options, repoRoot!)
          }
        }

        await processMultiReviewerOutput(results, options, ctx, prMr, branch, true)

        if (aggregateCiExitCode !== undefined) {
          process.exit(aggregateCiExitCode)
        }
      }
    } else {
      // Standard (non-agentic) review mode — dispatch to one or more reviewer
      // personas, each running in its own pi `AgentSession` in parallel.
      //
      // Note on onProgress: non-agentic reviews don't make tool calls, so
      // there's no live tool-progress signal to surface on the spinner.
      // Per-reviewer completion is reported via `onReviewerComplete` below.
      const reviewerInfos = resolveReviewerNames(options.reviewers)
      const reviewData = {
        diffContent,
        context: contextParts.join('\n'),
        prMrInfo,
        semanticContext,
        prDescriptionSummary,
        projectStructureContext,
      }

      if (!ctx.quiet) {
        const names = reviewerInfos.map((r) => r.name).join(', ')
        logger.info(`Dispatching ${reviewerInfos.length} reviewer(s) in parallel: ${names}`)
      }

      const results = await runReviewers({
        reviewers: reviewerInfos,
        data: reviewData,
        model: options.model,
        onReviewerComplete: (r) => {
          if (ctx.quiet) return
          if (r.ok) {
            logger.success(`Reviewer ${r.reviewer.name} completed in ${Math.round(r.durationMs / 100) / 10}s`)
          } else {
            logger.warn(`Reviewer ${r.reviewer.name} failed: ${r.error}`)
          }
        },
      })

      progressUpdater?.dispose()
      spinner?.stop()

      // CI mode + suppressions for multi-reviewer:
      //
      // - Suppression filtering runs PER reviewer (so each persona's content
      //   is filtered against the same source markers).
      // - The CI exit code is the WORST (highest) across reviewers, so a
      //   single failing persona can still fail the run.
      // - The sticky comment is posted ONCE after the loop as a single
      //   composite body with one section per reviewer — preventing each
      //   per-reviewer call from racing under the shared sticky marker.
      let aggregateCiExitCode: number | undefined
      for (const r of results) {
        if (!r.ok || r.content === undefined) continue
        const { content: filtered, ciExitCode } = await applyCiAndSuppressions(
          r.content,
          options,
          repoRoot!,
          r.usage,
          { postComment: false },
        )
        r.content = filtered
        if (ciExitCode !== undefined) {
          aggregateCiExitCode =
            aggregateCiExitCode === undefined
              ? ciExitCode
              : Math.max(aggregateCiExitCode, ciExitCode)
        }
      }

      if (options.ci) {
        const successful = results
          .filter((r) => r.ok && r.content !== undefined)
          .map((r) => ({ reviewer: r.reviewer, content: r.content!, usage: r.usage }))
        if (successful.length > 0) {
          await postCiStickyComment(buildCompositeCiCommentBody(successful), options, repoRoot!)
        }
      }

      await processMultiReviewerOutput(results, options, ctx, prMr, branch)

      if (aggregateCiExitCode !== undefined) {
        process.exit(aggregateCiExitCode)
      }
    }
  } catch (error) {
    progressUpdater?.dispose()
    spinner?.fail('Review failed')
    throw error
  }
}

interface CiAndSuppressionsResult {
  content: string
  /** Defined only when --ci was passed; caller must process.exit(ciExitCode). */
  ciExitCode?: number
}

/**
 * Apply post-model filters (suppressions) and — if --ci was passed — post
 * the sticky comment and compute the CI exit code.
 *
 * The caller is responsible for calling `process.exit(ciExitCode)` AFTER the
 * rendered review has been printed. We do not register a `beforeExit` hook
 * here because explicit `process.exit()` calls elsewhere would bypass it,
 * masking real exit codes (e.g., a review-engine crash would silently
 * override a CI exit code of 0).
 */
async function applyCiAndSuppressions(
  rawContent: string,
  options: CliOptions,
  repoRoot: string,
  // Optional because per-reviewer results may be in a failure state (no usage).
  // formatUsageOneLiner() handles undefined by emitting a "—" placeholder.
  usage?: UsageTotals,
  // When the caller plans to post a single composite comment after running
  // every reviewer (multi-reviewer CI), pass `postComment: false` so this
  // function only filters + computes the exit code and leaves the sticky
  // comment alone. Without this, N reviewers would post-and-delete N times
  // under the same marker, leaving only the last reviewer's comment.
  opts: { postComment?: boolean } = {},
): Promise<CiAndSuppressionsResult> {
  const { postComment = true } = opts

  // 1) Suppressions — always-on; --no-suppressions disables.
  let reviewContent = rawContent
  if (!options.noSuppressions) {
    try {
      const { filtered, suppressedCount } = await filterSuppressedFindings(rawContent, repoRoot)
      reviewContent = filtered
      if (suppressedCount > 0) {
        logger.info(`Suppressed ${suppressedCount} finding(s) via kode-review: ignore markers`)
      }
    } catch (err) {
      logger.warn(`Suppression filter failed — using raw review: ${(err as Error).message}`)
    }
  }

  // 2) CI mode — compute the exit code (and optionally post the sticky).
  if (!options.ci) return { content: reviewContent }

  const summary = parseReviewSummary(reviewContent)
  const exitCode = resolveCiExitCode(summary, options.failOn)

  if (postComment) {
    const commentBody = `${reviewContent}\n\n---\n_${formatUsageOneLiner(usage)}_`
    await postCiStickyComment(commentBody, options, repoRoot)
  }

  return { content: reviewContent, ciExitCode: exitCode }
}

/**
 * Post a single sticky CI comment under the shared `<!-- kode-review:sticky -->`
 * marker. Resolves the PR number from `--pr` or the CI env, detects the
 * platform, and delegates to the platform-specific runner. No-ops with a
 * warning when either is missing.
 *
 * Centralized here so both the single-reviewer agentic path and the
 * composite multi-reviewer path go through the same one-comment-per-run
 * codepath — preventing N reviewers from racing each other under the
 * sticky marker.
 */
async function postCiStickyComment(
  commentBody: string,
  options: CliOptions,
  repoRoot: string,
): Promise<void> {
  const platform: CiPlatform | null = detectCiPlatform()
  const envPr = platform ? extractPrNumber(platform) : null
  const prNumber: number | null = options.pr ? Number(options.pr) : envPr

  if (!platform || !prNumber) {
    if (!prNumber) {
      logger.warn('CI mode active but no PR/MR number could be resolved — skipping comment post.')
    } else if (!platform) {
      logger.warn('CI mode active but no CI platform detected (not running in GitHub Actions / GitLab CI) — skipping comment post.')
    }
    return
  }

  const payload = buildCommentPayload(commentBody)
  try {
    const posted = await postCiComment(platform, prNumber, payload, repoRoot)
    if (!posted) {
      logger.warn(`Failed to post review comment to ${platform} PR/MR #${prNumber}`)
    } else {
      logger.info(`Posted review to ${platform} PR/MR #${prNumber} (sticky)`)
    }
  } catch (err) {
    logger.warn(`Could not post CI comment: ${(err as Error).message}`)
  }
}


/**
 * Process and output review results based on options
 */
async function processReviewOutput(
  rawContent: string,
  options: CliOptions,
  ctx: CliContext,
  prMr: { id: number; platform: VcsPlatform } | null,
  branch: string,
  metadata: {
    agentic: boolean
    toolCallCount?: number
    truncated?: boolean
    truncationReason?: string
    usage?: UsageTotals
  }
): Promise<void> {
  // Parse review content into structured data
  const structured = parseReviewContent(rawContent)

  // Build review output object
  const reviewOutput: ReviewOutput = {
    raw: rawContent,
    structured: structured ?? undefined,
  }

  // Add metadata to structured review if available
  if (reviewOutput.structured) {
    const scope = options.scope === 'auto'
      ? (prMr ? 'pr' : 'local')
      : (options.scope ?? 'local')

    reviewOutput.structured.metadata = {
      timestamp: new Date().toISOString(),
      scope: scope as 'local' | 'pr' | 'both',
      agentic: metadata.agentic,
      toolCalls: metadata.toolCallCount,
      truncated: metadata.truncated,
      truncationReason: metadata.truncationReason,
      prNumber: prMr?.platform === 'github' ? prMr.id : undefined,
      mrIid: prMr?.platform === 'gitlab' ? prMr.id : undefined,
      branch,
      model: options.model,
      usage: metadata.usage,
    }
  }

  // Write to file and/or stdout via unified writer
  await writeReviewOutput(reviewOutput, {
    format: options.format,
    outputFile: options.outputFile,
    quiet: options.outputFile ? ctx.quiet : false,
  })

  if (options.outputFile) {
    logger.success(`Review written to ${options.outputFile}`)
  }

  // Display completion banner
  if (!ctx.quiet) {
    console.log('')
    if (metadata.agentic) {
      if (metadata.toolCallCount && metadata.toolCallCount > 0) {
        console.log(cyan(`Tool calls made: ${metadata.toolCallCount}`))
      }
      if (metadata.truncated) {
        console.log(cyan(`Note: Review was truncated (${metadata.truncationReason})`))
      }
      console.log(cyan(formatUsageOneLiner(metadata.usage)))
      console.log('')
      console.log(green('========================================'))
      console.log(green('       AGENTIC REVIEW COMPLETE          '))
      console.log(green('========================================'))
    } else {
      console.log(cyan(formatUsageOneLiner(metadata.usage)))
      console.log('')
      console.log(green('========================================'))
      console.log(green('           REVIEW COMPLETE             '))
      console.log(green('========================================'))
    }
  }

  // Post to PR/MR if requested.
  // When --ci is active, the sticky-comment path in applyCiAndSuppressions
  // already posted; skip the legacy poster to avoid duplicate comments.
  if (options.ci) {
    // no-op — sticky comment handled upstream
  } else if (options.postToPr && prMr && reviewOutput.structured) {
    logger.info('Posting review to PR/MR...')

    const postResult = await postReviewToPR(
      reviewOutput.structured,
      {
        prNumber: prMr.platform === 'github' ? prMr.id : undefined,
        mrIid: prMr.platform === 'gitlab' ? prMr.id : undefined,
        platform: prMr.platform as VcsPlatformType,
        postInlineComments: true,
        // Approval mutation is gated behind --auto-approve. Without
        // that flag the review still posts as a comment, but the
        // bot never trips an actual platform approval based on a
        // model-derived verdict from possibly-injected PR content.
        setApprovalStatus: options.autoApprove,
      }
    )

    if (postResult.success) {
      logger.success('Review posted to PR/MR')
      if (postResult.inlineCommentsPosted > 0) {
        logger.success(`Posted ${postResult.inlineCommentsPosted}/${postResult.inlineCommentsAttempted} inline comment(s)`)
      }
      if (postResult.approvalStatusSet) {
        logger.success(`Review status: ${reviewOutput.structured.verdict.recommendation}`)
      }
      // Inline-comment failures don't flip overall success but must still be visible
      if (postResult.inlineCommentsFailed > 0) {
        logger.warn(`${postResult.inlineCommentsFailed} inline comment(s) failed to post`)
      }
    } else {
      for (const error of postResult.errors) {
        logger.error(error)
      }
    }
  } else if (options.postToPr && !prMr) {
    logger.warn('--post-to-pr specified but no PR/MR was reviewed')
  } else if (options.postToPr && !reviewOutput.structured) {
    logger.warn('Could not parse review for PR posting. Raw comment posted instead.')
  }
}

/**
 * Print the list of available reviewers (built-in + user-defined).
 *
 * When `format === 'json'`, emits a JSON array suitable for scripting and
 * skips the human-readable help text.
 */
export function printReviewerList(format: 'text' | 'json' | 'markdown'): void {
  const reviewers = listAvailableReviewers()
  if (format === 'json') {
    console.log(JSON.stringify(reviewers, null, 2))
    return
  }
  console.log('')
  console.log('Available reviewers:')
  console.log('')
  for (const r of reviewers) {
    const tag = r.builtin ? cyan('[builtin]') : green('[user]    ')
    console.log(`  ${tag} ${r.name.padEnd(14)} ${r.description}`)
  }
  console.log('')
  console.log('Run a reviewer with:  kode-review --reviewer <name>')
  console.log('Run multiple:         kode-review --reviewer security,architect')
  console.log('Run all in parallel:  kode-review --reviewer all')
  console.log('')
  console.log('To define your own reviewer, drop a markdown prompt at:')
  console.log('  ~/.config/kode-review/reviewers/<name>.md')
  console.log('(or override the location with $KODE_REVIEW_REVIEWERS_DIR)')
}

/**
 * Derive a per-reviewer output filename from a base path.
 *
 * `review.md` + `security` → `review.security.md`. When no extension is
 * present, the reviewer name is appended with a dash.
 */
function perReviewerOutputPath(basePath: string, reviewerName: string): string {
  const lastDot = basePath.lastIndexOf('.')
  const lastSep = Math.max(basePath.lastIndexOf('/'), basePath.lastIndexOf('\\'))
  if (lastDot > lastSep && lastDot !== -1) {
    return `${basePath.slice(0, lastDot)}.${reviewerName}${basePath.slice(lastDot)}`
  }
  return `${basePath}-${reviewerName}`
}

/**
 * Handle output for one or more parallel reviewer runs.
 *
 * Single-reviewer runs are written exactly as before (no per-reviewer
 * filename suffix, no section header). Multi-reviewer runs prefix each
 * section with a header in stdout output, and write to per-reviewer files
 * when `--output-file` is set. Failed reviewers are surfaced but don't
 * block the remaining output.
 *
 * Returns when every successful reviewer has been written + (optionally)
 * posted. Throws only if every reviewer failed — partial failure is logged
 * and treated as non-fatal.
 */
async function processMultiReviewerOutput(
  results: ReviewerRunResult[],
  options: CliOptions,
  ctx: CliContext,
  prMr: { id: number; platform: VcsPlatform } | null,
  branch: string,
  agentic: boolean = false,
): Promise<void> {
  const okResults = results.filter((r) => r.ok && r.content !== undefined)
  const failed = results.filter((r) => !r.ok)

  if (okResults.length === 0) {
    const detail = failed.map((r) => `${r.reviewer.name}: ${r.error}`).join('; ')
    throw new Error(`All reviewers failed. ${detail}`)
  }

  const multi = results.length > 1

  // Hoist invariants out of the per-reviewer loop so we don't repeat the
  // same warning once per successful reviewer.
  if (options.postToPr && !prMr) {
    logger.warn('--post-to-pr specified but no PR/MR was reviewed')
  }

  for (let i = 0; i < okResults.length; i++) {
    const r = okResults[i]
    const rawContent = r.content!
    const structured = parseReviewContent(rawContent)

    const reviewOutput: ReviewOutput = {
      raw: rawContent,
      structured: structured ?? undefined,
    }

    if (reviewOutput.structured) {
      const scope = options.scope === 'auto'
        ? (prMr ? 'pr' : 'local')
        : (options.scope ?? 'local')

      reviewOutput.structured.metadata = {
        timestamp: new Date().toISOString(),
        scope: scope as 'local' | 'pr' | 'both',
        agentic,
        toolCalls: r.toolCallCount,
        truncated: r.truncated,
        truncationReason: r.truncationReason,
        prNumber: prMr?.platform === 'github' ? prMr.id : undefined,
        mrIid: prMr?.platform === 'gitlab' ? prMr.id : undefined,
        branch,
        model: options.model,
        reviewer: r.reviewer.name,
      }
    }

    const outputFile = options.outputFile && multi
      ? perReviewerOutputPath(options.outputFile, r.reviewer.name)
      : options.outputFile

    if (!ctx.quiet && multi) {
      const tag = r.reviewer.builtin ? '[builtin]' : '[user]'
      console.log('')
      console.log(cyan('────────────────────────────────────────'))
      console.log(cyan(` Reviewer: ${r.reviewer.name} ${tag}`))
      console.log(cyan('────────────────────────────────────────'))
      console.log('')
    }

    // Agentic-mode signals: surface truncation + tool-call counts per reviewer
    // so an iteration-cap truncation in --reviewer X,Y is visible instead of
    // silently dropped. Mirrors the single-shot agentic path's wording.
    if (!ctx.quiet && agentic) {
      if (r.truncated && r.truncationReason) {
        logger.warn(`  Note: ${r.reviewer.name} review was truncated (${r.truncationReason})`)
      }
      if (typeof r.toolCallCount === 'number' && r.toolCallCount > 0) {
        logger.info(`  Tool calls (${r.reviewer.name}): ${r.toolCallCount}`)
      }
    }

    await writeReviewOutput(reviewOutput, {
      format: options.format,
      outputFile,
      quiet: outputFile ? ctx.quiet : false,
    })

    if (outputFile) {
      logger.success(`Review (${r.reviewer.name}) written to ${outputFile}`)
    }

    // PR/MR posting — one comment per reviewer so each persona's verdict is
    // visible separately rather than being merged into a single decision.
    if (options.postToPr && prMr && reviewOutput.structured) {
      logger.info(`Posting ${r.reviewer.name} review to PR/MR...`)

      const postResult = await postReviewToPR(
        reviewOutput.structured,
        {
          prNumber: prMr.platform === 'github' ? prMr.id : undefined,
          mrIid: prMr.platform === 'gitlab' ? prMr.id : undefined,
          platform: prMr.platform as VcsPlatformType,
          postInlineComments: true,
          // Approval mutation requires BOTH (a) the user explicitly
          // opting in via --auto-approve AND (b) being in single-
          // reviewer mode — multi-reviewer runs never approve, since a
          // single persona's verdict shouldn't represent the whole
          // review's outcome.
          setApprovalStatus: options.autoApprove && !multi,
        }
      )

      if (postResult.success) {
        logger.success(`Posted ${r.reviewer.name} review to PR/MR`)
        if (postResult.inlineCommentsPosted > 0) {
          logger.success(`Posted ${postResult.inlineCommentsPosted}/${postResult.inlineCommentsAttempted} inline comment(s)`)
        }
        // Inline-comment failures don't flip overall success but must still be visible
        if (postResult.inlineCommentsFailed > 0) {
          logger.warn(`${postResult.inlineCommentsFailed} inline comment(s) failed to post`)
        }
      } else {
        for (const error of postResult.errors) {
          logger.error(error)
        }
      }
    } else if (options.postToPr && prMr && !reviewOutput.structured) {
      logger.warn(`Could not parse ${r.reviewer.name} review for PR posting.`)
    }
  }

  if (!ctx.quiet) {
    console.log('')
    console.log(green('========================================'))
    console.log(green('           REVIEW COMPLETE              '))
    console.log(green('========================================'))
    if (multi) {
      console.log('')
      const summary = okResults
        .map((r) => `  ${r.reviewer.name}: ok (${Math.round(r.durationMs / 100) / 10}s)`)
        .concat(failed.map((r) => `  ${r.reviewer.name}: FAILED — ${r.error}`))
        .join('\n')
      console.log(summary)
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv)
  const ctx = createContext(options)

  // Set quiet mode for logger
  setQuietMode(options.quiet)

  // Enable debug mode when DEBUG=1
  setDebugMode(process.env.DEBUG === '1')

  try {
    // v1.0 clean-break migration gate. --doctor must remain reachable even on
    // a corrupt or legacy install so it can surface config problems as a
    // structured diagnostic row. needsMigration() reads the config file and
    // will throw a SyntaxError on corruption, so we gate the entire call on
    // !options.doctor rather than only gating the runMigration() branch.
    if (!options.doctor && needsMigration()) {
      const result = await runMigration({ skipConfirm: options.migrateYes })
      // Always exit after migration (or abort): re-running puts the user in
      // the post-migration state, which is what setup expects.
      process.exit(result.performed ? 0 : 1)
    }

    // Handle setup commands first
    if (await handleSetupCommands(options)) {
      return
    }

    // Handle agent skill/command install (`--install-agent`, `--list-agents`).
    // Runs after `handleSetupCommands` so info-only flags (`--update`,
    // `--list-reviewers`) keep their precedence; runs before the onboarding
    // gate so a fresh install can wire up tooling without configuring pi
    // first.
    if (await handleAgentInstallCommands(options, ctx)) {
      return
    }

    // Handle indexer commands
    if (await handleIndexerCommands(options)) {
      return
    }

    // Check if onboarding is needed
    if (shouldEnforceOnboardingGate(options, isOnboardingComplete())) {
      if (ctx.interactive) {
        const setupOk = await runOnboardingWizard()
        // Wizard returns false if pi isn't installed or has no usable model.
        // It already printed the actionable hint; don't proceed to a review
        // that would only fail at the auth gate.
        if (!setupOk) return

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

    // Non-blocking daily update check (fire-and-forget)
    checkForUpdateNotification().catch(() => {})

    // Check if watch mode requested. --watch + --scope repo is rejected at
    // parse time (see src/cli/args.ts); reaching here with --watch means
    // diff-scope watch mode.
    if (options.watch) {
      await runWatchMode(options, ctx)
      return
    }

    // Run code review
    await runCodeReview(options, ctx)
  } catch (error) {
    // Convert to AppError with proper categorization
    const appError = error instanceof AppError
      ? error
      : wrapError(error, categorizeError(error))

    if (options.format === 'json') {
      // JSON output includes category and recovery hint
      console.log(JSON.stringify({
        error: appError.message,
        category: appError.category,
        recoveryHint: appError.recoveryHint,
      }))
    } else {
      // Human-readable output with optional verbose mode
      const verbose = process.env.DEBUG === '1'
      logger.error(formatError(appError, verbose))
    }

    process.exit(1)
  }
}

main()
