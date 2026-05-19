/**
 * clawpatch installation detection + install hints.
 *
 * --scope repo delegates feature mapping + state to the external `clawpatch`
 * CLI. We never auto-install it (npm i -g is brittle and noisy across
 * package managers); instead we detect it on PATH and, if missing, print
 * explicit instructions tailored to the user's repo (their lockfile picks
 * the package manager).
 *
 * Note: this module shells out via the project's safe `runCommand` wrapper
 * (execa under the hood — no shell). Identical pattern to src/onboarding/pi.ts.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { commandExists, exec as runCommand } from '../utils/exec.js'

const CLAWPATCH_NPM_NAME = 'clawpatch'
const CLAWPATCH_MIN_NODE_MAJOR = 22

export interface InstallStatus {
  installed: boolean
  /** clawpatch --version output if installed; null otherwise. */
  version: string | null
}

/**
 * Returns whether `clawpatch` is on PATH and (if so) its reported version.
 *
 * A failed `--version` invocation is treated as "installed but unhealthy" so
 * callers can still distinguish it from "not on PATH at all." Both surface
 * the install hint to the user.
 */
export async function detectClawpatch(): Promise<InstallStatus> {
  if (!(await commandExists(CLAWPATCH_NPM_NAME))) {
    return { installed: false, version: null }
  }
  const result = await runCommand(CLAWPATCH_NPM_NAME, ['--version'])
  const versionRaw = `${result.stdout}\n${result.stderr}`.trim()
  return {
    installed: true,
    version: result.exitCode === 0 && versionRaw.length > 0 ? versionRaw : null,
  }
}

/**
 * Pick the most likely package manager from the user's repo. Heuristic only —
 * the user can copy any of the printed commands.
 */
export function detectPreferredPackageManager(repoRoot: string): 'bun' | 'pnpm' | 'npm' | 'yarn' {
  if (existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb'))) return 'bun'
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * Multi-line, copy-pastable install hint with the preferred manager listed
 * first. Includes `npx clawpatch` as an ephemeral fallback.
 */
export function buildInstallHint(repoRoot: string): string {
  const preferred = detectPreferredPackageManager(repoRoot)
  const commands: Array<[label: string, cmd: string]> = []
  const lines: string[] = [
    'clawpatch is not on PATH. --scope repo requires it for feature mapping.',
    '',
    'Install one of:',
  ]
  switch (preferred) {
    case 'bun':
      commands.push(['bun', 'bun add -g clawpatch'])
      break
    case 'pnpm':
      commands.push(['pnpm', 'pnpm add -g clawpatch'])
      break
    case 'yarn':
      commands.push(['yarn', 'yarn global add clawpatch'])
      break
    default:
      commands.push(['npm', 'npm install -g clawpatch'])
      break
  }
  // Always offer npm as the fallback (it's the most universally available).
  if (preferred !== 'npm') commands.push(['npm', 'npm install -g clawpatch'])
  // Ephemeral fallback.
  commands.push(['npx', 'npx clawpatch <command>     # ephemeral, slower per-invocation'])

  for (const [label, cmd] of commands) {
    lines.push(`  ${label.padEnd(5)} ${cmd}`)
  }
  lines.push('', `(Requires Node.js >= ${CLAWPATCH_MIN_NODE_MAJOR})`)
  return lines.join('\n')
}

/**
 * True if the current Node version is at least `clawpatch`'s minimum.
 */
export function isNodeVersionCompatible(): boolean {
  const m = process.version.match(/^v?(\d+)/)
  if (!m) return false
  return parseInt(m[1]!, 10) >= CLAWPATCH_MIN_NODE_MAJOR
}

export function buildNodeUpgradeHint(): string {
  return [
    `--scope repo requires Node.js >= ${CLAWPATCH_MIN_NODE_MAJOR} (clawpatch's minimum).`,
    `You're running ${process.version}.`,
    '',
    'Upgrade Node via your version manager (nvm/fnm/asdf/volta), then re-run.',
  ].join('\n')
}
