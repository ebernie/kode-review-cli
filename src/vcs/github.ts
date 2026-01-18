import { exec, commandExists } from '../utils/exec.js'
import { logger } from '../utils/logger.js'

export interface PullRequest {
  number: number
  title: string
  url: string
  state: string
}

export interface PullRequestInfo {
  title: string
  body: string
  author: { login: string }
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
}

/**
 * Check if GitHub CLI is installed
 */
export async function isGhInstalled(): Promise<boolean> {
  return commandExists('gh')
}

/**
 * Check if GitHub CLI is authenticated
 */
export async function isGhAuthenticated(): Promise<boolean> {
  const result = await exec('gh', ['auth', 'status'])
  return result.exitCode === 0
}

/**
 * Get PRs for a branch
 */
export async function getGitHubPRs(branch: string): Promise<PullRequest[]> {
  const result = await exec('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--json',
    'number,title,url,state',
    '--state',
    'open',
  ])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch GitHub PRs: ${result.stderr || 'Unknown error'}`)
    return []
  }

  try {
    return JSON.parse(result.stdout) as PullRequest[]
  } catch (error) {
    logger.debug(`Failed to parse GitHub PR response: ${error}`)
    return []
  }
}

/**
 * Get PR diff
 */
export async function getGitHubPRDiff(prNumber: number): Promise<string | null> {
  const result = await exec('gh', ['pr', 'diff', String(prNumber)])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch diff for PR #${prNumber}: ${result.stderr || 'Unknown error'}`)
    return null
  }

  return result.stdout
}

/**
 * Get PR info
 */
export async function getGitHubPRInfo(prNumber: number): Promise<PullRequestInfo | null> {
  const result = await exec('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'title,body,author,baseRefName,headRefName,additions,deletions,changedFiles',
  ])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch info for PR #${prNumber}: ${result.stderr || 'Unknown error'}`)
    return null
  }

  try {
    return JSON.parse(result.stdout) as PullRequestInfo
  } catch (error) {
    logger.debug(`Failed to parse PR #${prNumber} info: ${error}`)
    return null
  }
}
