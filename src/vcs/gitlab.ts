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

/**
 * Post a comment on a GitLab MR
 */
export async function postGitLabMRComment(
  mrIid: number,
  body: string
): Promise<{ success: boolean; error?: string }> {
  const result = await exec('glab', ['mr', 'note', String(mrIid), '--message', body])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error posting comment'
    logger.debug(`Failed to post comment on MR !${mrIid}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

export interface GitLabMRContext {
  projectPath: string
  baseSha: string
  headSha: string
  startSha: string
}

/**
 * Fetch repository and MR metadata needed for line comments.
 * Call once before a loop and pass the context to postGitLabMRLineComment.
 */
export async function getGitLabMRContext(
  mrIid: number
): Promise<{ success: true; context: GitLabMRContext } | { success: false; error: string }> {
  const repoResult = await exec('glab', ['repo', 'view', '-F', 'json'])
  if (repoResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get repository info' }
  }

  let projectPath: string
  try {
    const repoInfo = JSON.parse(repoResult.stdout)
    projectPath = encodeURIComponent(repoInfo.path_with_namespace || repoInfo.full_path)
  } catch {
    return { success: false, error: 'Failed to parse repository info' }
  }

  const mrResult = await exec('glab', [
    'api',
    `projects/${projectPath}/merge_requests/${mrIid}`,
  ])
  if (mrResult.exitCode !== 0) {
    return { success: false, error: 'Failed to get MR details' }
  }

  try {
    const mrInfo = JSON.parse(mrResult.stdout)
    const baseSha = mrInfo.diff_refs?.base_sha
    const headSha = mrInfo.diff_refs?.head_sha
    const startSha = mrInfo.diff_refs?.start_sha
    if (!baseSha || !headSha || !startSha) {
      return { success: false, error: 'MR diff refs not available' }
    }
    return { success: true, context: { projectPath, baseSha, headSha, startSha } }
  } catch {
    return { success: false, error: 'Failed to parse MR details' }
  }
}

/**
 * Post an inline comment on a specific file/line in an MR.
 * Pass a pre-fetched context from getGitLabMRContext to avoid redundant API calls.
 */
export async function postGitLabMRLineComment(
  mrIid: number,
  body: string,
  path: string,
  newLine: number,
  mrContext?: GitLabMRContext
): Promise<{ success: boolean; error?: string }> {
  let ctx: GitLabMRContext

  if (mrContext) {
    ctx = mrContext
  } else {
    const ctxResult = await getGitLabMRContext(mrIid)
    if (!ctxResult.success) {
      return { success: false, error: ctxResult.error }
    }
    ctx = ctxResult.context
  }

  const apiPath = `projects/${ctx.projectPath}/merge_requests/${mrIid}/discussions`

  const result = await exec('glab', [
    'api',
    '-X', 'POST',
    apiPath,
    '-f', `body=${body}`,
    '-f', `position[position_type]=text`,
    '-f', `position[base_sha]=${ctx.baseSha}`,
    '-f', `position[head_sha]=${ctx.headSha}`,
    '-f', `position[start_sha]=${ctx.startSha}`,
    '-f', `position[new_path]=${path}`,
    '-f', `position[old_path]=${path}`,
    '-F', `position[new_line]=${newLine}`,
  ])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error posting line comment'
    logger.debug(`Failed to post line comment on MR !${mrIid}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

/**
 * Approve a GitLab MR
 */
export async function approveGitLabMR(
  mrIid: number
): Promise<{ success: boolean; error?: string }> {
  const result = await exec('glab', ['mr', 'approve', String(mrIid)])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error approving MR'
    logger.debug(`Failed to approve MR !${mrIid}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

/**
 * Revoke approval on a GitLab MR
 */
export async function revokeGitLabMRApproval(
  mrIid: number
): Promise<{ success: boolean; error?: string }> {
  const result = await exec('glab', ['mr', 'revoke', String(mrIid)])

  if (result.exitCode !== 0) {
    const error = result.stderr || 'Unknown error revoking MR approval'
    logger.debug(`Failed to revoke approval for MR !${mrIid}: ${error}`)
    return { success: false, error }
  }

  return { success: true }
}

/**
 * Set GitLab MR approval status based on approve flag
 */
export async function setGitLabMRApproval(
  mrIid: number,
  approve: boolean
): Promise<{ success: boolean; error?: string }> {
  if (approve) {
    return approveGitLabMR(mrIid)
  } else {
    return revokeGitLabMRApproval(mrIid)
  }
}
