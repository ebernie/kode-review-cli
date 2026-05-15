/**
 * Agentic tool: get_commits.
 *
 * Returns commits in a ref range (default merge-base..HEAD) so the model can
 * inspect author intent and the sequence of changes that led to the diff.
 */

import { getCommitsInRange, type CommitInfo } from './git-helpers.js'

export interface GetCommitsInput {
  base?: string
  head?: string
  includeBody?: boolean
  limit?: number
}

export interface GetCommitsOutput {
  base: string
  head: string
  commits: CommitInfo[]
  totalCount: number
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export async function getCommitsHandler(
  input: GetCommitsInput,
  repoRoot: string,
  defaultBase: string,
): Promise<GetCommitsOutput> {
  const base = input.base ?? defaultBase
  const head = input.head ?? 'HEAD'
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const commits = await getCommitsInRange(repoRoot, base, head, {
    includeBody: Boolean(input.includeBody),
    limit,
  })
  return { base, head, commits, totalCount: commits.length }
}
