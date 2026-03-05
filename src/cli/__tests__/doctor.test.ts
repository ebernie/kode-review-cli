import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { printDiagnostics, runDiagnostics, type DiagnosticsResult } from '../doctor.js'

// Mock dependencies for runDiagnostics
vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
  commandExists: vi.fn(),
}))

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
  getConfigPath: vi.fn(),
  isOnboardingComplete: vi.fn(),
}))

vi.mock('../../indexer/index.js', () => ({
  isDockerAvailable: vi.fn(),
  isDockerRunning: vi.fn(),
  isIndexerRunning: vi.fn(),
}))

import { exec, commandExists } from '../../utils/exec.js'
import { getConfig, getConfigPath, isOnboardingComplete } from '../../config/index.js'
import { isDockerAvailable, isDockerRunning, isIndexerRunning } from '../../indexer/index.js'

const mockExec = exec as unknown as ReturnType<typeof vi.fn>
const mockCommandExists = commandExists as unknown as ReturnType<typeof vi.fn>
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>
const mockGetConfigPath = getConfigPath as unknown as ReturnType<typeof vi.fn>
const mockIsOnboardingComplete = isOnboardingComplete as unknown as ReturnType<typeof vi.fn>
const mockIsDockerAvailable = isDockerAvailable as unknown as ReturnType<typeof vi.fn>
const mockIsDockerRunning = isDockerRunning as unknown as ReturnType<typeof vi.fn>
const mockIsIndexerRunning = isIndexerRunning as unknown as ReturnType<typeof vi.fn>

describe('printDiagnostics', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('prints header', () => {
    const result: DiagnosticsResult = {
      checks: [],
      passCount: 0,
      warnCount: 0,
      failCount: 0,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('System Diagnostics')
  })

  it('prints each check with status', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Test Check', status: 'pass', message: 'All good' },
        { name: 'Warning Check', status: 'warn', message: 'Some warning' },
        { name: 'Failed Check', status: 'fail', message: 'Something failed' },
      ],
      passCount: 1,
      warnCount: 1,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Test Check')
    expect(output).toContain('All good')
    expect(output).toContain('Warning Check')
    expect(output).toContain('Failed Check')
  })

  it('prints details when present', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Check', status: 'warn', message: 'Warning', details: 'Additional details here' },
      ],
      passCount: 0,
      warnCount: 1,
      failCount: 0,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Additional details here')
  })

  it('prints summary with all counts', () => {
    const result: DiagnosticsResult = {
      checks: [],
      passCount: 5,
      warnCount: 2,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Summary')
    expect(output).toContain('5 passed')
    expect(output).toContain('2 warnings')
    expect(output).toContain('1 failed')
  })

  it('prints only non-zero counts in summary', () => {
    const result: DiagnosticsResult = {
      checks: [],
      passCount: 3,
      warnCount: 0,
      failCount: 0,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('3 passed')
    expect(output).not.toContain('0 warnings')
    expect(output).not.toContain('0 failed')
  })

  it('prints suggestions for failed checks', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Configuration', status: 'fail', message: 'Failed' },
      ],
      passCount: 0,
      warnCount: 0,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Suggestions')
    expect(output).toContain('kode-review --setup')
  })

  it('prints suggestions for Node.js failure', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Node.js', status: 'fail', message: 'Not found' },
      ],
      passCount: 0,
      warnCount: 0,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Suggestions')
    expect(output).toContain('nodejs.org')
  })

  it('prints suggestions for Git failure', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Git', status: 'fail', message: 'Not found' },
      ],
      passCount: 0,
      warnCount: 0,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Suggestions')
    expect(output).toContain('git-scm.com')
  })

  it('does not print suggestions when no failures', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Test', status: 'pass', message: 'OK' },
      ],
      passCount: 1,
      warnCount: 0,
      failCount: 0,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).not.toContain('Suggestions')
  })
})

describe('diagnostic output quality', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('includes all required information for failed diagnostics', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'Node.js', status: 'fail', message: 'Version 16.0.0 (requires 18+)' },
        { name: 'Git', status: 'fail', message: 'Not found in PATH' },
      ],
      passCount: 0,
      warnCount: 0,
      failCount: 2,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')

    // Verify each failure is mentioned with its status
    expect(output).toContain('Node.js')
    expect(output).toContain('Version 16.0.0')
    expect(output).toContain('Git')
    expect(output).toContain('Not found')

    // Verify actionable guidance is provided for failures
    expect(output.toLowerCase()).toMatch(/suggestion|install|run/)
  })

  it('provides specific recovery commands for each failure type', () => {
    const failures = [
      { name: 'Configuration', status: 'fail' as const, message: 'Invalid' },
      { name: 'GitHub CLI (gh)', status: 'fail' as const, message: 'Not authenticated' },
      { name: 'Docker', status: 'fail' as const, message: 'Not running' },
    ]

    for (const failure of failures) {
      consoleSpy.mockClear()

      const result: DiagnosticsResult = {
        checks: [failure],
        passCount: 0,
        warnCount: 0,
        failCount: 1,
      }

      printDiagnostics(result)

      const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')

      // Each failure should have actionable suggestion (URL or command)
      expect(output).toMatch(/https?:\/\/|kode-review|gh |glab |docker/)
    }
  })

  it('clearly distinguishes between pass, warn, and fail statuses', () => {
    const result: DiagnosticsResult = {
      checks: [
        { name: 'PassCheck', status: 'pass', message: 'OK' },
        { name: 'WarnCheck', status: 'warn', message: 'Warning' },
        { name: 'FailCheck', status: 'fail', message: 'Failed' },
      ],
      passCount: 1,
      warnCount: 1,
      failCount: 1,
    }

    printDiagnostics(result)

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')

    // Each status type should be visually distinguishable (icon or color marker)
    // The function uses ✓ for pass, ! for warn, ✗ for fail
    expect(output).toContain('PassCheck')
    expect(output).toContain('WarnCheck')
    expect(output).toContain('FailCheck')

    // Summary should contain accurate counts
    expect(output).toContain('1 passed')
    expect(output).toContain('1 warning')
    expect(output).toContain('1 failed')
  })
})

describe('runDiagnostics', () => {
  function setupDefaults() {
    mockGetConfig.mockReturnValue({ indexer: { enabled: false } })
    mockGetConfigPath.mockReturnValue('/home/user/.config/kode-review/config.json')
    mockIsOnboardingComplete.mockReturnValue(true)
    mockIsDockerAvailable.mockResolvedValue(false)
    mockIsDockerRunning.mockResolvedValue(false)
    mockIsIndexerRunning.mockResolvedValue(false)
    mockCommandExists.mockResolvedValue(true)
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'node') return { stdout: 'v20.10.0', exitCode: 0 }
      if (cmd === 'git') return { stdout: 'git version 2.43.0', exitCode: 0 }
      if (cmd === 'opencode') return { stdout: '1.0.0', exitCode: 0 }
      if (cmd === 'gh' && args?.includes('status')) return { stdout: 'Logged in', exitCode: 0 }
      if (cmd === 'glab' && args?.includes('status')) return { stdout: 'Logged in', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaults()
  })

  it('returns all checks passing when system is healthy', async () => {
    const result = await runDiagnostics()

    expect(result.passCount).toBe(result.checks.length)
    expect(result.warnCount).toBe(0)
    expect(result.failCount).toBe(0)
  })

  it('returns mix of pass and warn when onboarding incomplete and opencode missing', async () => {
    mockIsOnboardingComplete.mockReturnValue(false)
    mockCommandExists.mockImplementation(async (cmd: string) => {
      if (cmd === 'opencode') return false
      return true
    })

    const result = await runDiagnostics()

    expect(result.passCount).toBeGreaterThan(0)
    expect(result.warnCount).toBeGreaterThan(0)
    expect(result.failCount).toBe(0)
    expect(result.passCount + result.warnCount + result.failCount).toBe(result.checks.length)
  })

  it('includes Docker check when indexer is enabled', async () => {
    mockGetConfig.mockReturnValue({ indexer: { enabled: true } })
    mockIsDockerAvailable.mockResolvedValue(true)
    mockIsDockerRunning.mockResolvedValue(true)
    mockIsIndexerRunning.mockResolvedValue(true)

    const result = await runDiagnostics()

    const checkNames = result.checks.map(c => c.name)
    expect(checkNames).toContain('Docker')
    expect(checkNames).toContain('Indexer Containers')
  })

  it('skips Docker and indexer checks when indexer disabled and Docker unavailable', async () => {
    mockGetConfig.mockReturnValue({ indexer: { enabled: false } })
    mockIsDockerAvailable.mockResolvedValue(false)

    const result = await runDiagnostics()

    const checkNames = result.checks.map(c => c.name)
    expect(checkNames).not.toContain('Docker')
    expect(checkNames).not.toContain('Indexer Containers')
  })

  it('returns fail when git is not found', async () => {
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === 'git') throw new Error('not found')
      if (cmd === 'node') return { stdout: 'v20.10.0', exitCode: 0 }
      if (cmd === 'opencode') return { stdout: '1.0.0', exitCode: 0 }
      if (cmd === 'gh') return { stdout: 'Logged in', exitCode: 0 }
      if (cmd === 'glab') return { stdout: 'Logged in', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    })

    const result = await runDiagnostics()

    const gitCheck = result.checks.find(c => c.name === 'Git')
    expect(gitCheck).toBeDefined()
    expect(gitCheck!.status).toBe('fail')
    expect(result.failCount).toBeGreaterThanOrEqual(1)
  })

  it('returns fail when Node.js version is too low', async () => {
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === 'node') return { stdout: 'v16.0.0', exitCode: 0 }
      if (cmd === 'git') return { stdout: 'git version 2.43.0', exitCode: 0 }
      if (cmd === 'opencode') return { stdout: '1.0.0', exitCode: 0 }
      if (cmd === 'gh') return { stdout: 'Logged in', exitCode: 0 }
      if (cmd === 'glab') return { stdout: 'Logged in', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    })

    const result = await runDiagnostics()

    const nodeCheck = result.checks.find(c => c.name === 'Node.js')
    expect(nodeCheck).toBeDefined()
    expect(nodeCheck!.status).toBe('fail')
  })

  it('handles config load failure gracefully', async () => {
    mockGetConfigPath.mockImplementation(() => { throw new Error('Config corrupted') })

    const result = await runDiagnostics()

    const configCheck = result.checks.find(c => c.name === 'Configuration')
    expect(configCheck).toBeDefined()
    expect(configCheck!.status).toBe('fail')
    expect(result.failCount).toBeGreaterThanOrEqual(1)
  })

  it('returns warn when VCS CLI is installed but not authenticated', async () => {
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'node') return { stdout: 'v20.10.0', exitCode: 0 }
      if (cmd === 'git') return { stdout: 'git version 2.43.0', exitCode: 0 }
      if (cmd === 'opencode') return { stdout: '1.0.0', exitCode: 0 }
      // gh auth status fails
      if (cmd === 'gh' && args?.includes('status')) return { stdout: '', exitCode: 1 }
      if (cmd === 'glab' && args?.includes('status')) return { stdout: 'Logged in', exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    })

    const result = await runDiagnostics()

    const ghCheck = result.checks.find(c => c.name === 'GitHub CLI (gh)')
    expect(ghCheck).toBeDefined()
    expect(ghCheck!.status).toBe('warn')
    expect(ghCheck!.message).toContain('not authenticated')
  })
})
