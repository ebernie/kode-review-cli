import { exec } from '../utils/exec.js'

export type VcsPlatform = 'github' | 'gitlab' | 'unknown'

/**
 * Get the first available git remote URL
 * Tries 'origin' first, then falls back to the first available remote
 */
async function getFirstRemoteUrl(): Promise<string | null> {
  // Try origin first (most common)
  const originResult = await exec('git', ['remote', 'get-url', 'origin'])
  if (originResult.exitCode === 0 && originResult.stdout.trim()) {
    return originResult.stdout.trim()
  }

  // List all remotes and try the first one
  const remotesResult = await exec('git', ['remote'])
  if (remotesResult.exitCode !== 0 || !remotesResult.stdout.trim()) {
    return null
  }

  const remotes = remotesResult.stdout.trim().split('\n').filter(Boolean)
  if (remotes.length === 0) {
    return null
  }

  // Get URL of the first available remote
  const firstRemote = remotes[0]
  const urlResult = await exec('git', ['remote', 'get-url', firstRemote])
  if (urlResult.exitCode === 0 && urlResult.stdout.trim()) {
    return urlResult.stdout.trim()
  }

  return null
}

/**
 * Detect the VCS platform from the git remote URL
 * Falls back to first available remote if 'origin' doesn't exist
 */
export async function detectPlatform(): Promise<VcsPlatform> {
  const remoteUrl = await getFirstRemoteUrl()

  if (!remoteUrl) {
    return 'unknown'
  }

  if (remoteUrl.includes('github.com')) {
    return 'github'
  }

  if (remoteUrl.includes('gitlab')) {
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

/**
 * Get the git remote URL
 * Falls back to first available remote if 'origin' doesn't exist
 */
export async function getRepoUrl(): Promise<string | null> {
  return getFirstRemoteUrl()
}

/**
 * Get the git repository root directory
 */
export async function getRepoRoot(): Promise<string | null> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'])

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout.trim() || null
}
