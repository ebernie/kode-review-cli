import { exec } from '../utils/exec.js'

export interface LocalChanges {
  staged: string
  unstaged: string
  stagedFiles: string[]
  unstagedFiles: string[]
}

/**
 * Get local git changes (staged and unstaged)
 */
export async function getLocalChanges(): Promise<LocalChanges> {
  const [staged, unstaged, stagedNames, unstagedNames] = await Promise.all([
    exec('git', ['diff', '--cached']),
    exec('git', ['diff']),
    exec('git', ['diff', '--cached', '--name-status']),
    exec('git', ['diff', '--name-status']),
  ])

  return {
    staged: staged.stdout,
    unstaged: unstaged.stdout,
    stagedFiles: stagedNames.stdout.split('\n').filter(Boolean),
    unstagedFiles: unstagedNames.stdout.split('\n').filter(Boolean),
  }
}

/**
 * Check if there are any local changes
 */
export function hasChanges(changes: LocalChanges): boolean {
  return Boolean(changes.staged || changes.unstaged)
}

/**
 * Format changes as a diff string
 */
export function formatChanges(changes: LocalChanges): string {
  const parts: string[] = []

  if (changes.staged) {
    parts.push('=== STAGED CHANGES ===\n')
    parts.push(changes.staged)
    parts.push('\n')
  }

  if (changes.unstaged) {
    parts.push('=== UNSTAGED CHANGES ===\n')
    parts.push(changes.unstaged)
    parts.push('\n')
  }

  return parts.join('\n')
}

/**
 * Get a summary of changed files
 */
export function getChangesSummary(changes: LocalChanges): string {
  const parts: string[] = []

  if (changes.stagedFiles.length > 0) {
    parts.push('Staged files:')
    changes.stagedFiles.forEach((f) => parts.push(`  ${f}`))
    parts.push('')
  }

  if (changes.unstagedFiles.length > 0) {
    parts.push('Unstaged files:')
    changes.unstagedFiles.forEach((f) => parts.push(`  ${f}`))
    parts.push('')
  }

  return parts.join('\n')
}
