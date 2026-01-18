import { confirm } from '@inquirer/prompts'
import { isGhInstalled, isGhAuthenticated } from '../vcs/github.js'
import { isGlabInstalled, isGlabAuthenticated } from '../vcs/gitlab.js'
import { execInteractive } from '../utils/exec.js'
import { updateConfig } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { cyan, dim } from '../cli/colors.js'

export interface VcsSetupResult {
  github: { enabled: boolean; authenticated: boolean }
  gitlab: { enabled: boolean; authenticated: boolean }
}

/**
 * Setup VCS integrations (GitHub and GitLab)
 */
export async function setupVcs(): Promise<VcsSetupResult> {
  const result: VcsSetupResult = {
    github: { enabled: false, authenticated: false },
    gitlab: { enabled: false, authenticated: false },
  }

  // GitHub setup
  console.log('')
  console.log(cyan('GitHub Integration'))

  const ghInstalled = await isGhInstalled()

  if (ghInstalled) {
    const ghAuth = await isGhAuthenticated()

    if (ghAuth) {
      logger.success('GitHub CLI detected and authenticated')
      result.github = { enabled: true, authenticated: true }
    } else {
      logger.warn('GitHub CLI detected but not authenticated')

      const authenticate = await confirm({
        message: 'Authenticate GitHub CLI now?',
        default: true,
      })

      if (authenticate) {
        const exitCode = await execInteractive('gh', ['auth', 'login'])
        result.github = {
          enabled: true,
          authenticated: exitCode === 0,
        }

        if (exitCode === 0) {
          logger.success('GitHub CLI authenticated')
        }
      } else {
        result.github = { enabled: true, authenticated: false }
      }
    }
  } else {
    console.log(dim('GitHub CLI (gh) not found'))
    console.log(dim('Install from: https://cli.github.com/'))

    const enableGithub = await confirm({
      message: 'Enable GitHub integration? (can configure later)',
      default: false,
    })

    result.github = { enabled: enableGithub, authenticated: false }
  }

  // GitLab setup
  console.log('')
  console.log(cyan('GitLab Integration'))

  const glabInstalled = await isGlabInstalled()

  if (glabInstalled) {
    const glabAuth = await isGlabAuthenticated()

    if (glabAuth) {
      logger.success('GitLab CLI detected and authenticated')
      result.gitlab = { enabled: true, authenticated: true }
    } else {
      logger.warn('GitLab CLI detected but not authenticated')

      const authenticate = await confirm({
        message: 'Authenticate GitLab CLI now?',
        default: true,
      })

      if (authenticate) {
        const exitCode = await execInteractive('glab', ['auth', 'login'])
        result.gitlab = {
          enabled: true,
          authenticated: exitCode === 0,
        }

        if (exitCode === 0) {
          logger.success('GitLab CLI authenticated')
        }
      } else {
        result.gitlab = { enabled: true, authenticated: false }
      }
    }
  } else {
    console.log(dim('GitLab CLI (glab) not found'))
    console.log(dim('Install from: https://gitlab.com/gitlab-org/cli'))

    const enableGitlab = await confirm({
      message: 'Enable GitLab integration? (can configure later)',
      default: false,
    })

    result.gitlab = { enabled: enableGitlab, authenticated: false }
  }

  // Save configuration
  updateConfig({
    github: result.github,
    gitlab: result.gitlab,
  })

  return result
}
