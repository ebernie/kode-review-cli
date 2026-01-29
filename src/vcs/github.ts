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

/**
 * Post a comment on a GitHub PR
 */
export async function postGitHubPRComment(
  prNumber: number,
  body: string
): Promise<{ success: boolean; error?: string }> {
  const result = await exec('gh', ['pr', 'comment', String(prNumber), '--body', body])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error posting comment'
    logger.debug(`Failed to post comment on PR #${prNumber}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

/**
 * Post an inline comment on a specific file/line in a PR review.
 * Note: This creates a pending review comment that must be submitted with submitGitHubPRReview.
 * For standalone comments, use the REST API via gh api.
 */
export async function postGitHubPRLineComment(
  prNumber: number,
  body: string,
  path: string,
  line: number,
  side: 'LEFT' | 'RIGHT' = 'RIGHT'
): Promise<{ success: boolean; error?: string }> {
  // Get the repository info
  const repoResult = await exec('gh', ['repo', 'view', '--json', 'owner,name'])
  if (repoResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get repository info' }
  }

  let owner: string
  let repo: string
  try {
    const repoInfo = JSON.parse(repoResult.stdout)
    owner = repoInfo.owner.login
    repo = repoInfo.name
  } catch {
    return { success: false, error: 'Failed to parse repository info' }
  }

  // Get the PR's head commit SHA
  const prResult = await exec('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'headRefOid',
  ])
  if (prResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get PR head commit' }
  }

  let commitId: string
  try {
    const prInfo = JSON.parse(prResult.stdout)
    commitId = prInfo.headRefOid
  } catch {
    return { success: false, error: 'Failed to parse PR head commit' }
  }

  // Create the review comment via GitHub API
  const apiPath = `repos/${owner}/${repo}/pulls/${prNumber}/comments`

  const result = await exec('gh', [
    'api',
    '-X', 'POST',
    apiPath,
    '-f', `body=${body}`,
    '-f', `commit_id=${commitId}`,
    '-f', `path=${path}`,
    '-F', `line=${line}`,
    '-f', `side=${side}`,
  ])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error posting line comment'
    logger.debug(`Failed to post line comment on PR #${prNumber}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

export type GitHubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/**
 * Submit a PR review with approval status
 */
export async function submitGitHubPRReview(
  prNumber: number,
  body: string,
  event: GitHubReviewEvent
): Promise<{ success: boolean; error?: string }> {
  const args = ['pr', 'review', String(prNumber)]

  switch (event) {
    case 'APPROVE':
      args.push('--approve')
      break
    case 'REQUEST_CHANGES':
      args.push('--request-changes')
      break
    case 'COMMENT':
      args.push('--comment')
      break
  }

  if (body) {
    args.push('--body', body)
  }

  const result = await exec('gh', args)

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error submitting review'
    logger.debug(`Failed to submit review for PR #${prNumber}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}
