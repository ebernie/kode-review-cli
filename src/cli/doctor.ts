/**
 * System diagnostics command
 *
 * Runs a series of checks to verify the system is properly configured:
 * - Config file exists and is valid
 * - OpenCode CLI installed
 * - Node.js version (18+)
 * - Git installed
 * - GitHub CLI (gh) - installed & authenticated
 * - GitLab CLI (glab) - installed & authenticated
 * - Docker prerequisites (if indexer enabled)
 * - Indexer containers running (if indexer enabled)
 */

import { exec, commandExists } from '../utils/exec.js'
import { getConfig, getConfigPath, isOnboardingComplete } from '../config/index.js'
import {
  isDockerAvailable,
  isDockerRunning,
  isIndexerRunning,
} from '../indexer/index.js'
import { green, red, yellow, cyan, bold, dim } from './colors.js'

export interface DiagnosticCheck {
  /** Name of the check */
  name: string
  /** Status of the check */
  status: 'pass' | 'warn' | 'fail'
  /** Human-readable message */
  message: string
  /** Additional details (optional) */
  details?: string
}

export interface DiagnosticsResult {
  /** All diagnostic checks */
  checks: DiagnosticCheck[]
  /** Number of passing checks */
  passCount: number
  /** Number of warnings */
  warnCount: number
  /** Number of failures */
  failCount: number
}

/**
 * Run all diagnostic checks
 */
export async function runDiagnostics(): Promise<DiagnosticsResult> {
  const checks: DiagnosticCheck[] = []
  const config = getConfig()

  // 1. Config file exists and valid
  checks.push(await checkConfig())

  // 2. Node.js version
  checks.push(await checkNodeVersion())

  // 3. Git installed
  checks.push(await checkGit())

  // 4. OpenCode CLI installed
  checks.push(await checkOpenCode())

  // 5. GitHub CLI
  checks.push(await checkGitHubCli())

  // 6. GitLab CLI
  checks.push(await checkGitLabCli())

  // 7. Docker (if indexer enabled or available)
  if (config.indexer.enabled || await isDockerAvailable()) {
    checks.push(await checkDocker())
  }

  // 8. Indexer containers (if indexer enabled)
  if (config.indexer.enabled) {
    checks.push(await checkIndexerContainers())
  }

  // Calculate totals
  const passCount = checks.filter(c => c.status === 'pass').length
  const warnCount = checks.filter(c => c.status === 'warn').length
  const failCount = checks.filter(c => c.status === 'fail').length

  return {
    checks,
    passCount,
    warnCount,
    failCount,
  }
}

/**
 * Print diagnostic results
 */
export function printDiagnostics(result: DiagnosticsResult): void {
  console.log('')
  console.log(bold('kode-review System Diagnostics'))
  console.log('=' .repeat(50))
  console.log('')

  for (const check of result.checks) {
    const icon = getStatusIcon(check.status)
    const color = getStatusColor(check.status)
    console.log(`${icon} ${color(check.name)}: ${check.message}`)
    if (check.details) {
      console.log(`   ${dim(check.details)}`)
    }
  }

  console.log('')
  console.log('=' .repeat(50))

  // Summary
  const parts: string[] = []
  if (result.passCount > 0) {
    parts.push(green(`${result.passCount} passed`))
  }
  if (result.warnCount > 0) {
    parts.push(yellow(`${result.warnCount} warnings`))
  }
  if (result.failCount > 0) {
    parts.push(red(`${result.failCount} failed`))
  }

  console.log(`Summary: ${parts.join(', ')}`)
  console.log('')

  // Suggestions for failed checks
  if (result.failCount > 0) {
    console.log(cyan('Suggestions:'))
    for (const check of result.checks.filter(c => c.status === 'fail')) {
      const suggestion = getSuggestion(check.name)
      if (suggestion) {
        console.log(`  - ${suggestion}`)
      }
    }
    console.log('')
  }
}

// Individual check implementations

async function checkConfig(): Promise<DiagnosticCheck> {
  try {
    const configPath = getConfigPath()
    const complete = isOnboardingComplete()

    if (!complete) {
      return {
        name: 'Configuration',
        status: 'warn',
        message: 'Onboarding not complete',
        details: `Config at: ${configPath}`,
      }
    }

    return {
      name: 'Configuration',
      status: 'pass',
      message: 'Valid and complete',
      details: `Config at: ${configPath}`,
    }
  } catch (error) {
    return {
      name: 'Configuration',
      status: 'fail',
      message: 'Failed to load configuration',
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkNodeVersion(): Promise<DiagnosticCheck> {
  try {
    const result = await exec('node', ['--version'])
    const version = result.stdout.trim().replace('v', '')
    const major = parseInt(version.split('.')[0], 10)

    if (major < 18) {
      return {
        name: 'Node.js',
        status: 'fail',
        message: `Version ${version} (requires 18+)`,
      }
    }

    return {
      name: 'Node.js',
      status: 'pass',
      message: `Version ${version}`,
    }
  } catch {
    return {
      name: 'Node.js',
      status: 'fail',
      message: 'Not found in PATH',
    }
  }
}

async function checkGit(): Promise<DiagnosticCheck> {
  try {
    const result = await exec('git', ['--version'])
    const version = result.stdout.trim()

    return {
      name: 'Git',
      status: 'pass',
      message: version.replace('git version ', 'Version '),
    }
  } catch {
    return {
      name: 'Git',
      status: 'fail',
      message: 'Not found in PATH',
    }
  }
}

async function checkOpenCode(): Promise<DiagnosticCheck> {
  const exists = await commandExists('opencode')

  if (!exists) {
    return {
      name: 'OpenCode CLI',
      status: 'warn',
      message: 'Not found in PATH',
      details: 'Install via: npm install -g @opencode-ai/cli',
    }
  }

  try {
    const result = await exec('opencode', ['--version'])
    const version = result.stdout.trim()

    return {
      name: 'OpenCode CLI',
      status: 'pass',
      message: `Version ${version || 'installed'}`,
    }
  } catch {
    return {
      name: 'OpenCode CLI',
      status: 'warn',
      message: 'Found but could not get version',
    }
  }
}

async function checkGitHubCli(): Promise<DiagnosticCheck> {
  const exists = await commandExists('gh')

  if (!exists) {
    return {
      name: 'GitHub CLI (gh)',
      status: 'warn',
      message: 'Not installed',
      details: 'Install from: https://cli.github.com/',
    }
  }

  // Check authentication status
  const authResult = await exec('gh', ['auth', 'status'])

  if (authResult.exitCode !== 0) {
    return {
      name: 'GitHub CLI (gh)',
      status: 'warn',
      message: 'Installed but not authenticated',
      details: 'Run: gh auth login',
    }
  }

  return {
    name: 'GitHub CLI (gh)',
    status: 'pass',
    message: 'Installed and authenticated',
  }
}

async function checkGitLabCli(): Promise<DiagnosticCheck> {
  const exists = await commandExists('glab')

  if (!exists) {
    return {
      name: 'GitLab CLI (glab)',
      status: 'warn',
      message: 'Not installed',
      details: 'Install from: https://gitlab.com/gitlab-org/cli',
    }
  }

  // Check authentication status
  const authResult = await exec('glab', ['auth', 'status'])

  if (authResult.exitCode !== 0) {
    return {
      name: 'GitLab CLI (glab)',
      status: 'warn',
      message: 'Installed but not authenticated',
      details: 'Run: glab auth login',
    }
  }

  return {
    name: 'GitLab CLI (glab)',
    status: 'pass',
    message: 'Installed and authenticated',
  }
}

async function checkDocker(): Promise<DiagnosticCheck> {
  const available = await isDockerAvailable()

  if (!available) {
    return {
      name: 'Docker',
      status: 'warn',
      message: 'Not installed or not in PATH',
      details: 'Install from: https://docker.com/',
    }
  }

  const running = await isDockerRunning()

  if (!running) {
    return {
      name: 'Docker',
      status: 'warn',
      message: 'Installed but daemon not running',
      details: 'Start Docker Desktop or docker service',
    }
  }

  return {
    name: 'Docker',
    status: 'pass',
    message: 'Installed and running',
  }
}

async function checkIndexerContainers(): Promise<DiagnosticCheck> {
  try {
    const running = await isIndexerRunning()

    if (!running) {
      return {
        name: 'Indexer Containers',
        status: 'warn',
        message: 'Not running',
        details: 'Start with: kode-review --setup-indexer',
      }
    }

    return {
      name: 'Indexer Containers',
      status: 'pass',
      message: 'Running and healthy',
    }
  } catch (error) {
    return {
      name: 'Indexer Containers',
      status: 'fail',
      message: 'Error checking status',
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

// Helper functions

function getStatusIcon(status: 'pass' | 'warn' | 'fail'): string {
  switch (status) {
    case 'pass':
      return green('✓')
    case 'warn':
      return yellow('!')
    case 'fail':
      return red('✗')
  }
}

function getStatusColor(status: 'pass' | 'warn' | 'fail'): (text: string) => string {
  switch (status) {
    case 'pass':
      return green
    case 'warn':
      return yellow
    case 'fail':
      return red
  }
}

function getSuggestion(checkName: string): string | undefined {
  const suggestions: Record<string, string> = {
    'Configuration': 'Run "kode-review --setup" to complete configuration',
    'Node.js': 'Install Node.js 18 or later from https://nodejs.org/',
    'Git': 'Install Git from https://git-scm.com/',
    'OpenCode CLI': 'Run: npm install -g @opencode-ai/cli',
    'GitHub CLI (gh)': 'Run: gh auth login',
    'GitLab CLI (glab)': 'Run: glab auth login',
    'Docker': 'Install and start Docker from https://docker.com/',
    'Indexer Containers': 'Run: kode-review --setup-indexer',
  }

  return suggestions[checkName]
}
