/**
 * Thin wrappers around the git CLI used by the agentic tool layer.
 */

import { exec as runProcess } from '../../utils/exec.js'

export interface CommitInfo {
  sha: string
  shortSha: string
  author: string
  authorEmail: string
  timestamp: string
  subject: string
  body?: string
}

export interface GetCommitsOptions {
  includeBody?: boolean
  limit?: number
}

const COMMIT_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e'
const FIELD_SEP = '\x1f'
const RECORD_SEP = '\x1e'

function parseCommits(stdout: string, includeBody: boolean): CommitInfo[] {
  if (!stdout.trim()) return []
  const out: CommitInfo[] = []
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, '')
    if (!trimmed) continue
    const [sha, shortSha, author, authorEmail, timestamp, subject, body] = trimmed.split(FIELD_SEP)
    if (!sha) continue
    out.push({
      sha,
      shortSha,
      author,
      authorEmail,
      timestamp,
      subject,
      ...(includeBody ? { body: (body ?? '').trim() } : {}),
    })
  }
  return out
}

export async function getCommitsInRange(
  repoRoot: string,
  base: string,
  head: string,
  options: GetCommitsOptions = {},
): Promise<CommitInfo[]> {
  const limit = options.limit ?? 50
  const result = await runProcess(
    'git',
    ['log', `--pretty=format:${COMMIT_FORMAT}`, '-n', String(limit), `${base}..${head}`],
    { cwd: repoRoot },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git log failed: ${result.stderr}`)
  }
  return parseCommits(result.stdout, Boolean(options.includeBody))
}

export async function getFileHistory(
  repoRoot: string,
  filePath: string,
  options: GetCommitsOptions = {},
): Promise<CommitInfo[]> {
  const limit = options.limit ?? 10
  const result = await runProcess(
    'git',
    ['log', `--pretty=format:${COMMIT_FORMAT}`, '-n', String(limit), '--', filePath],
    { cwd: repoRoot },
  )
  if (result.exitCode !== 0) {
    throw new Error(`git log for ${filePath} failed: ${result.stderr}`)
  }
  return parseCommits(result.stdout, Boolean(options.includeBody))
}

export async function getMergeBase(
  repoRoot: string,
  refA: string,
  refB: string,
): Promise<string> {
  const result = await runProcess('git', ['merge-base', refA, refB], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git merge-base ${refA} ${refB} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}
