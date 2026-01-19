import { select, confirm } from '@inquirer/prompts'
import ora from 'ora'
import { parseArgs, type CliOptions, type ReviewScope } from './cli/args.js'
import { createContext, type CliContext } from './cli/interactive.js'
import { cyan, green } from './cli/colors.js'
import { logger, setQuietMode, errorJson } from './utils/logger.js'
import {
  isOnboardingComplete,
  resetConfig,
} from './config/index.js'
import { runOnboardingWizard, runProviderSetup, setupVcs } from './onboarding/index.js'
import {
  runReview,
  runReviewWithServer,
  getLocalChanges,
  hasChanges,
  formatChanges,
  getChangesSummary,
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
} from './vcs/index.js'

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

  // Run review
  if (!ctx.quiet) {
    console.log('')
    console.log(cyan('========================================'))
    console.log(cyan('           CODE REVIEW OUTPUT           '))
    console.log(cyan('========================================'))
    console.log('')
  }

  const spinner = ctx.quiet ? null : ora('Running code review...').start()

  try {
    const reviewOptions = {
      diffContent,
      context: contextParts.join('\n'),
      prMrInfo,
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
