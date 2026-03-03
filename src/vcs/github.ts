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

export interface GitHubPRContext {
  owner: string
  repo: string
  commitId: string
}

/**
 * Fetch repository and PR metadata needed for line comments.
 * Call once before a loop and pass the context to postGitHubPRLineComment.
 */
export async function getGitHubPRContext(
  prNumber: number
): Promise<{ success: true; context: GitHubPRContext } | { success: false; error: string }> {
  const [repoResult, prResult] = await Promise.all([
    exec('gh', ['repo', 'view', '--json', 'owner,name']),
    exec('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid']),
  ])

  if (repoResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get repository info' }
  }
  if (prResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get PR head commit' }
  }

  try {
    const repoInfo = JSON.parse(repoResult.stdout)
    const prInfo = JSON.parse(prResult.stdout)
    return {
      success: true,
      context: {
        owner: repoInfo.owner.login,
        repo: repoInfo.name,
        commitId: prInfo.headRefOid,
      },
    }
  } catch {
    return { success: false, error: 'Failed to parse repository or PR info' }
  }
}

/**
 * Post an inline comment on a specific file/line in a PR review.
 * Pass a pre-fetched context from getGitHubPRContext to avoid redundant API calls.
 */
export async function postGitHubPRLineComment(
  prNumber: number,
  body: string,
  path: string,
  line: number,
  side: 'LEFT' | 'RIGHT' = 'RIGHT',
  prContext?: GitHubPRContext
): Promise<{ success: boolean; error?: string }> {
  let ctx: GitHubPRContext

  if (prContext) {
    ctx = prContext
  } else {
    const ctxResult = await getGitHubPRContext(prNumber)
    if (!ctxResult.success) {
      return { success: false, error: ctxResult.error }
    }
    ctx = ctxResult.context
  }

  const apiPath = `repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}/comments`

  const result = await exec('gh', [
    'api',
    '-X', 'POST',
    apiPath,
    '-f', `body=${body}`,
    '-f', `commit_id=${ctx.commitId}`,
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
