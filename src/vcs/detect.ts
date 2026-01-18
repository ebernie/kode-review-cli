import { exec } from '../utils/exec.js'

export type VcsPlatform = 'github' | 'gitlab' | 'unknown'

/**
 * Detect the VCS platform from the git remote origin URL
 */
export async function detectPlatform(): Promise<VcsPlatform> {
  const result = await exec('git', ['remote', 'get-url', 'origin'])

  if (result.exitCode !== 0) {
    return 'unknown'
  }

  const originUrl = result.stdout.trim()

  if (originUrl.includes('github.com')) {
    return 'github'
  }

  if (originUrl.includes('gitlab')) {
    return 'gitlab'
  }

  return 'unknown'
}

/**
 * Get the current git branch name
 */
export async function getCurrentBranch(): Promise<string | null> {
  const result = await exec('git', ['branch', '--show-current'])

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout.trim() || null
}

/**
 * Check if we're in a git repository
 */
export async function isGitRepository(): Promise<boolean> {
  const result = await exec('git', ['rev-parse', '--git-dir'])
  return result.exitCode === 0
}
