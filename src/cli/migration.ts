/**
 * v1.0 clean-break migration.
 *
 * On detecting any pre-1.0 (opencode era) config, this module wipes the
 * old config, watch state, and indexer Docker resources after a typed
 * confirmation. No backup file. See docs/superpowers/specs for details.
 */

import { rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  hasOldSchema,
  readLegacyComposeProject,
  resetConfig,
  getConfigPath,
} from '../config/index.js'
import { exec as runCommand, commandExists } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import { yellow, red, green, bold, dim } from './colors.js'

const WATCH_CONFIG_DIR_NAME = 'kode-review-watch'
const ENV_BYPASS = 'KODE_REVIEW_MIGRATE_YES'
const REQUIRED_CONFIRMATION = 'wipe'

export interface MigrationOptions {
  /** Skip the typed-confirmation prompt (e.g., --migrate-yes flag). */
  skipConfirm?: boolean
  /** Override readline input for tests. */
  readLine?: () => Promise<string>
}

export interface MigrationResult {
  performed: boolean
  /** Reason migration was skipped, if it was. */
  skipReason?: 'no-old-schema' | 'aborted' | 'no-tty'
}

/**
 * True iff the v1.0 migration flow needs to run before any other CLI work.
 */
export function needsMigration(): boolean {
  return hasOldSchema()
}

/**
 * Resolve the watch-mode config directory location used by the previous
 * install. Mirrors how `conf` derives `projectName` paths.
 */
export function getLegacyWatchConfigDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return join(appData, WATCH_CONFIG_DIR_NAME, 'Config')
    return join(homedir(), 'AppData', 'Roaming', WATCH_CONFIG_DIR_NAME, 'Config')
  }
  const xdgHome = process.env.XDG_CONFIG_HOME
  if (xdgHome) return join(xdgHome, WATCH_CONFIG_DIR_NAME)
  return join(homedir(), '.config', WATCH_CONFIG_DIR_NAME)
}

function shouldBypassPrompt(options: MigrationOptions): boolean {
  if (options.skipConfirm) return true
  const envValue = process.env[ENV_BYPASS]
  if (envValue && /^(1|true|yes)$/i.test(envValue)) return true
  return false
}

function printWarning(): void {
  const configPath = getConfigPath()
  console.error('')
  console.error(red(bold('⚠  kode-review v1.0 — clean break upgrade')))
  console.error('')
  console.error('This release replaces the opencode-based agent harness with pi (https://pi.dev).')
  console.error('Continuing will permanently delete the following:')
  console.error('')
  console.error(`  • ${configPath}`)
  console.error(`  • ${getLegacyWatchConfigDir()}`)
  console.error('  • The indexer Docker project (containers AND volumes)')
  console.error('')
  console.error(yellow(bold('This is irreversible. There is no backup.')))
  console.error('')
  console.error('To keep your old setup, abort now and pin the previous release:')
  console.error(dim('  npm install -g @kofikode/kode-review-cli@0.4.0'))
  console.error('')
}

async function defaultReadLine(): Promise<string> {
  if (!process.stdin.isTTY) {
    return ''
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(`Type ${bold(REQUIRED_CONFIRMATION)} to continue, anything else to abort: `)
  } finally {
    rl.close()
  }
}

async function tearDownIndexerProject(composeProject: string): Promise<void> {
  if (!(await commandExists('docker'))) {
    logger.debug(`docker not found on PATH; skipping indexer tear-down for "${composeProject}".`)
    return
  }
  logger.info(`Tearing down indexer Docker project "${composeProject}"…`)
  const result = await runCommand('docker', ['compose', '-p', composeProject, 'down', '-v'])
  if (result.exitCode !== 0) {
    logger.warn(`docker compose tear-down exited ${result.exitCode}. Continuing anyway.`)
    if (result.stderr.trim()) logger.debug(result.stderr.trim())
  }
}

async function wipeWatchConfig(): Promise<void> {
  const dir = getLegacyWatchConfigDir()
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    logger.warn(`Could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Run the migration if `hasOldSchema()` is true. The caller should exit
 * cleanly afterwards (regardless of result) so the user re-invokes the CLI
 * in the post-migration state.
 */
export async function runMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
  if (!needsMigration()) {
    return { performed: false, skipReason: 'no-old-schema' }
  }

  // Read BEFORE wiping the config — we need it for the Docker tear-down.
  const composeProject = readLegacyComposeProject()

  printWarning()

  if (!shouldBypassPrompt(options)) {
    if (!process.stdin.isTTY && !options.readLine) {
      console.error(red('Cannot prompt for confirmation: stdin is not a TTY.'))
      console.error(`Re-run with --migrate-yes or set ${ENV_BYPASS}=1 to proceed.`)
      console.error('Aborted. No changes made.')
      return { performed: false, skipReason: 'no-tty' }
    }
    const reader = options.readLine ?? defaultReadLine
    const answer = (await reader()).trim()
    if (answer !== REQUIRED_CONFIRMATION) {
      console.error('')
      console.error('Aborted. No changes made.')
      return { performed: false, skipReason: 'aborted' }
    }
  }

  console.error('')
  await tearDownIndexerProject(composeProject)
  await wipeWatchConfig()
  resetConfig()

  console.error('')
  console.error(green('✔ Migration complete.'))
  console.error(`Run ${bold('kode-review --setup')} to set up v1.0.`)
  console.error('')
  return { performed: true }
}
