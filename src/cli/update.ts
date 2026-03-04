/**
 * CLI self-update command
 *
 * Supports git-clone installations only. Checks for newer versions via
 * `git ls-remote` against the remote repository, then performs
 * git pull + bun install + bun run build when an update is confirmed.
 *
 * Also provides a non-blocking auto-check that runs once per day on startup,
 * printing a notification if a newer version is available.
 */

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { confirm } from '@inquirer/prompts'
import { exec, execInteractive } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import { AppError } from '../utils/errors.js'
import { getConfig, updateConfig } from '../config/index.js'
import { cyan, green, yellow, bold } from './colors.js'

declare const PKG_VERSION: string

const REPO_URL = 'https://github.com/kofikode/kode-review-cli'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

// --- Pure version helpers ---

/**
 * Parse a semver string into [major, minor, patch], stripping optional 'v' prefix.
 * Returns null for invalid input.
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const normalized = raw.startsWith('v') ? raw.slice(1) : raw
  const parts = normalized.split('.')
  if (parts.length !== 3) return null
  const nums = parts.map(p => parseInt(p, 10))
  if (nums.some(n => isNaN(n) || n < 0)) return null
  return nums as [number, number, number]
}

/**
 * Returns true if candidate is strictly newer than current.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const c = parseVersion(candidate)
  const k = parseVersion(current)
  if (!c || !k) return false
  if (c[0] !== k[0]) return c[0] > k[0]
  if (c[1] !== k[1]) return c[1] > k[1]
  return c[2] > k[2]
}

/**
 * Parse git ls-remote or git tag output and return the latest semver version
 * (without 'v' prefix), or null if none found.
 *
 * Accepts lines like:
 *   - "abc123\trefs/tags/v0.2.0"  (git ls-remote)
 *   - "v0.2.0"                    (git tag --list)
 */
export function parseLatestTag(output: string): string | null {
  // Match exact semver tags (vX.Y.Z), rejecting pre-release suffixes like -beta.1
  const tagPattern = /\bv(\d+\.\d+\.\d+)(?![.\d-])/
  const versions: string[] = []

  for (const line of output.split('\n')) {
    const match = line.match(tagPattern)
    if (match) {
      versions.push(match[1])
    }
  }

  if (versions.length === 0) return null

  // Sort descending and return the highest
  versions.sort((a, b) => {
    const va = parseVersion(a) ?? [0, 0, 0]
    const vb = parseVersion(b) ?? [0, 0, 0]
    if (va[0] !== vb[0]) return vb[0] - va[0]
    if (va[1] !== vb[1]) return vb[1] - va[1]
    return vb[2] - va[2]
  })

  return versions[0]
}

// --- Git operations ---
// Note: All git commands use the exec() utility from src/utils/exec.ts
// which wraps execa with reject:false. Arguments are always passed as
// arrays (never interpolated into a shell string), preventing injection.

/**
 * Fetch the latest version from the remote repository using git ls-remote.
 * Returns the version string (without 'v' prefix) or null on failure.
 */
async function fetchLatestVersion(): Promise<string | null> {
  const result = await exec('git', ['ls-remote', '--tags', '--refs', REPO_URL])
  if (result.exitCode !== 0 || !result.stdout.trim()) return null
  return parseLatestTag(result.stdout)
}

/**
 * Resolve the CLI's own installation directory by walking up from the
 * currently-executing file to find the git repository root.
 */
async function resolveInstallDir(): Promise<string | null> {
  const thisFile = fileURLToPath(import.meta.url)
  const result = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(thisFile),
  })
  if (result.exitCode !== 0) return null
  return result.stdout.trim() || null
}

/**
 * Fetch the changelog between two versions from the local git history.
 */
async function getChangelog(
  installDir: string,
  currentVersion: string,
  latestVersion: string
): Promise<string[]> {
  const result = await exec(
    'git',
    ['log', '--oneline', `v${currentVersion}..v${latestVersion}`],
    { cwd: installDir }
  )
  if (result.exitCode !== 0 || !result.stdout.trim()) return []
  return result.stdout.trim().split('\n').filter(Boolean)
}

/**
 * Execute the update steps: git pull, bun install, bun run build.
 * Uses execInteractive so output is visible to the user.
 */
async function performUpdate(installDir: string): Promise<void> {
  const steps = [
    { name: 'Pulling latest changes', command: 'git', args: ['pull', '--ff-only'] },
    { name: 'Installing dependencies', command: 'bun', args: ['install'] },
    { name: 'Building', command: 'bun', args: ['run', 'build'] },
  ] as const

  for (const step of steps) {
    logger.info(`${step.name}...`)
    const exitCode = await execInteractive(step.command, [...step.args], {
      cwd: installDir,
    })
    if (exitCode !== 0) {
      throw new AppError(`Update failed at step "${step.name}" (exit code ${exitCode}).`, {
        category: 'update',
        recoveryHint:
          `Try running manually in ${installDir}:\n` +
          '  git pull --ff-only && bun install && bun run build',
      })
    }
  }
}

// --- Public API ---

/**
 * Interactive update command handler. Called when --update flag is passed.
 */
export async function runUpdate(): Promise<void> {
  const currentVersion = PKG_VERSION

  console.log('')
  console.log(bold('kode-review Updater'))
  console.log('='.repeat(40))
  console.log('')

  logger.info(`Checking for updates... (current: v${currentVersion})`)

  const latestVersion = await fetchLatestVersion()

  if (!latestVersion) {
    throw new AppError('Could not fetch latest version from the remote repository.', {
      category: 'network',
      recoveryHint: 'Check your internet connection and try again.',
    })
  }

  console.log(`  Current version: ${cyan(`v${currentVersion}`)}`)
  console.log(`  Latest version:  ${cyan(`v${latestVersion}`)}`)
  console.log('')

  if (!isNewerVersion(latestVersion, currentVersion)) {
    logger.success('Already on the latest version.')
    return
  }

  // Resolve install directory for changelog and update
  const installDir = await resolveInstallDir()

  if (!installDir) {
    throw new AppError(
      'Could not determine the kode-review installation directory. ' +
        'This command only works for git-clone installations.',
      {
        category: 'update',
        recoveryHint:
          'Ensure kode-review was installed via git clone:\n' +
          `  git clone ${REPO_URL}\n` +
          '  cd kode-review-cli && bun install && bun run build && bun link',
      },
    )
  }

  // Fetch tags into local repo so git log range works
  const fetchResult = await exec('git', ['fetch', '--tags', '--quiet'], { cwd: installDir })
  if (fetchResult.exitCode !== 0) {
    logger.warn('Could not fetch tags for changelog. Proceeding without changelog.')
  }

  // Show changelog
  const changelog = await getChangelog(installDir, currentVersion, latestVersion)
  if (changelog.length > 0) {
    console.log(cyan("What's new:"))
    for (const line of changelog) {
      console.log(`  ${line}`)
    }
    console.log('')
  }

  const confirmed = await confirm({
    message: `Update from v${currentVersion} to v${latestVersion}?`,
    default: true,
  })

  if (!confirmed) {
    logger.info('Update cancelled.')
    return
  }

  await performUpdate(installDir)

  // Update config with check result
  updateConfig({
    updater: {
      ...getConfig().updater,
      lastCheckedAt: new Date().toISOString(),
      latestKnownVersion: latestVersion,
    },
  })

  console.log('')
  console.log(green('='.repeat(40)))
  console.log(green(`  Updated to v${latestVersion}`))
  console.log(green('='.repeat(40)))
  console.log('')
  logger.info('Restart kode-review for the new version to take effect.')
}

/**
 * Non-blocking daily update notification.
 * Called on every startup; silently exits in most cases.
 * Never throws - failure must not affect normal CLI operation.
 */
export async function checkForUpdateNotification(): Promise<void> {
  try {
    const config = getConfig()

    // Throttle: skip if checked within the last 24 hours
    if (config.updater.lastCheckedAt) {
      const lastCheck = new Date(config.updater.lastCheckedAt).getTime()
      if (!isNaN(lastCheck) && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
        return
      }
    }

    // Record check time immediately to prevent parallel runs
    updateConfig({
      updater: {
        ...config.updater,
        lastCheckedAt: new Date().toISOString(),
      },
    })

    const latestVersion = await fetchLatestVersion()
    if (!latestVersion) return

    const currentVersion = PKG_VERSION

    // Store latest known version
    updateConfig({
      updater: {
        ...getConfig().updater,
        lastCheckedAt: new Date().toISOString(),
        latestKnownVersion: latestVersion,
      },
    })

    if (isNewerVersion(latestVersion, currentVersion)) {
      console.log('')
      console.log(
        yellow(
          `  Update available: ${bold(`v${latestVersion}`)} (current: v${currentVersion}). ` +
            `Run: ${cyan('kode-review --update')}`,
        ),
      )
      console.log('')
    }
  } catch {
    // Auto-check must never crash the main flow
  }
}
