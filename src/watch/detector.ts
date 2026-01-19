import { exec } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import type { ReviewRequest, DetectionResult, Platform } from './types.js'

/**
 * Configuration for the detector
 */
export interface DetectorConfig {
  githubEnabled: boolean
  gitlabEnabled: boolean
}

/**
 * GitHub PR response from gh CLI
 */
interface GitHubPRResponse {
  number: number
  title: string
  url: string
  repository: { nameWithOwner: string }
  state: string
  updatedAt: string
}

/**
 * GitLab MR response from glab CLI
 */
interface GitLabMRResponse {
  iid: number
  title: string
  web_url: string
  references: { full: string }
  state: string
  updated_at: string
}

/**
 * Detect all PRs/MRs where user is assigned as reviewer.
 * Polls both GitHub and GitLab (if enabled) in parallel.
 */
export async function detectReviewRequests(config: DetectorConfig): Promise<DetectionResult> {
  const found: ReviewRequest[] = []
  const errors: Array<{ platform: Platform; error: Error }> = []

  const promises: Promise<void>[] = []

  // Detect GitHub PRs
  if (config.githubEnabled) {
    promises.push(
      detectGitHubPRs()
        .then((prs) => {
          found.push(...prs)
        })
        .catch((error) => {
          errors.push({
            platform: 'github',
            error: error instanceof Error ? error : new Error(String(error)),
          })
          logger.debug(`GitHub detection failed: ${error}`)
        })
    )
  }

  // Detect GitLab MRs
  if (config.gitlabEnabled) {
    promises.push(
      detectGitLabMRs()
        .then((mrs) => {
          found.push(...mrs)
        })
        .catch((error) => {
          errors.push({
            platform: 'gitlab',
            error: error instanceof Error ? error : new Error(String(error)),
          })
          logger.debug(`GitLab detection failed: ${error}`)
        })
    )
  }

  await Promise.all(promises)

  return { found, errors }
}

/**
 * Detect GitHub PRs where user is a requested reviewer
 */
async function detectGitHubPRs(): Promise<ReviewRequest[]> {
  const result = await exec('gh', [
    'pr',
    'list',
    '--search',
    'review-requested:@me',
    '--json',
    'number,title,url,repository,state,updatedAt',
    '--limit',
    '100',
  ])

  if (result.exitCode !== 0) {
    throw new Error(`GitHub CLI error: ${result.stderr || 'Unknown error'}`)
  }

  if (!result.stdout.trim()) {
    return []
  }

  let prs: GitHubPRResponse[]
  try {
    prs = JSON.parse(result.stdout) as GitHubPRResponse[]
  } catch (parseError) {
    throw new Error(`Failed to parse GitHub response: ${parseError}`)
  }

  return prs.map((pr) => ({
    platform: 'github' as const,
    id: pr.number,
    title: pr.title,
    url: pr.url,
    repository: pr.repository?.nameWithOwner || 'unknown',
    updatedAt: pr.updatedAt,
    state: pr.state.toLowerCase(),
  }))
}

/**
 * Detect GitLab MRs where user is a reviewer
 */
async function detectGitLabMRs(): Promise<ReviewRequest[]> {
  const result = await exec('glab', [
    'mr',
    'list',
    '--reviewer',
    '@me',
    '-F',
    'json',
    '--per-page',
    '100',
  ])

  if (result.exitCode !== 0) {
    throw new Error(`GitLab CLI error: ${result.stderr || 'Unknown error'}`)
  }

  if (!result.stdout.trim()) {
    return []
  }

  let mrs: GitLabMRResponse[]
  try {
    mrs = JSON.parse(result.stdout) as GitLabMRResponse[]
  } catch (parseError) {
    throw new Error(`Failed to parse GitLab response: ${parseError}`)
  }

  return mrs.map((mr) => ({
    platform: 'gitlab' as const,
    id: mr.iid,
    title: mr.title,
    url: mr.web_url,
    repository: mr.references?.full || 'unknown',
    updatedAt: mr.updated_at,
    state: mr.state.toLowerCase(),
  }))
}
