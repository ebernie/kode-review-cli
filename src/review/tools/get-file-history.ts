/**
 * Agentic tool: get_file_history.
 *
 * Returns the most recent commits that touched a given file so the model
 * can spot churn, recent risky edits, or the previous shape of the file.
 */

import { getFileHistory, type CommitInfo } from './git-helpers.js'
import { assertWithinRepo } from './path-guard.js'

export interface GetFileHistoryInput {
  filePath: string
  limit?: number
  includeBody?: boolean
}

export interface GetFileHistoryOutput {
  filePath: string
  commits: CommitInfo[]
  totalCount: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export async function getFileHistoryHandler(
  input: GetFileHistoryInput,
  repoRoot: string,
): Promise<GetFileHistoryOutput> {
  const safePath = assertWithinRepo(repoRoot, input.filePath)
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const commits = await getFileHistory(repoRoot, safePath, {
    limit,
    includeBody: Boolean(input.includeBody),
  })
  return { filePath: safePath, commits, totalCount: commits.length }
}
