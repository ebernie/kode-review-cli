import { exec, commandExists } from '../utils/exec.js'
import { logger } from '../utils/logger.js'

export interface MergeRequest {
  iid: number
  title: string
  web_url: string
  state: string
}

export interface MergeRequestInfo {
  title: string
  description: string
  author: { username: string }
  target_branch: string
  source_branch: string
}

/**
 * Check if GitLab CLI is installed
 */
export async function isGlabInstalled(): Promise<boolean> {
  return commandExists('glab')
}

/**
 * Check if GitLab CLI is authenticated
 */
export async function isGlabAuthenticated(): Promise<boolean> {
  const result = await exec('glab', ['auth', 'status'])
  return result.exitCode === 0
}

/**
 * Get MRs for a branch
 */
export async function getGitLabMRs(branch: string): Promise<MergeRequest[]> {
  const result = await exec('glab', [
    'mr',
    'list',
    '--source-branch',
    branch,
    '--state',
    'opened',
    '-F',
    'json',
  ])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch GitLab MRs: ${result.stderr || 'Unknown error'}`)
    return []
  }

  try {
    return JSON.parse(result.stdout) as MergeRequest[]
  } catch (error) {
    logger.debug(`Failed to parse GitLab MR response: ${error}`)
    return []
  }
}

/**
 * Get MR diff
 */
export async function getGitLabMRDiff(mrIid: number): Promise<string | null> {
  const result = await exec('glab', ['mr', 'diff', String(mrIid)])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch diff for MR !${mrIid}: ${result.stderr || 'Unknown error'}`)
    return null
  }

  return result.stdout
}

/**
 * Get MR info
 */
export async function getGitLabMRInfo(mrIid: number): Promise<MergeRequestInfo | null> {
  const result = await exec('glab', ['mr', 'view', String(mrIid), '-F', 'json'])

  if (result.exitCode !== 0) {
    logger.debug(`Failed to fetch info for MR !${mrIid}: ${result.stderr || 'Unknown error'}`)
    return null
  }

  try {
    return JSON.parse(result.stdout) as MergeRequestInfo
  } catch (error) {
    logger.debug(`Failed to parse MR !${mrIid} info: ${error}`)
    return null
  }
}
