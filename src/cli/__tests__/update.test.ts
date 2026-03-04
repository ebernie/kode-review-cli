import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Hoisted mocks ---
const { mockExec, mockExecInteractive, mockGetConfig, mockUpdateConfig, mockConfirm } =
  vi.hoisted(() => ({
    mockExec: vi.fn(),
    mockExecInteractive: vi.fn(),
    mockGetConfig: vi.fn(),
    mockUpdateConfig: vi.fn(),
    mockConfirm: vi.fn(),
  }))

vi.mock('../../utils/exec.js', () => ({
  exec: mockExec,
  execInteractive: mockExecInteractive,
}))

vi.mock('../../config/index.js', () => ({
  getConfig: mockGetConfig,
  updateConfig: mockUpdateConfig,
}))

vi.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
}))

// Import the module under test — pure functions and public API
import {
  parseVersion,
  isNewerVersion,
  parseLatestTag,
  runUpdate,
  checkForUpdateNotification,
} from '../update.js'

// --- Pure function tests (no mocking needed) ---

describe('parseVersion', () => {
  it('parses a valid semver string', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('strips leading v prefix', () => {
    expect(parseVersion('v0.2.0')).toEqual([0, 2, 0])
  })

  it('returns null for non-semver strings', () => {
    expect(parseVersion('not-a-version')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('1.2.3.4')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })

  it('returns null for strings with non-numeric parts', () => {
    expect(parseVersion('1.2.beta')).toBeNull()
    expect(parseVersion('a.b.c')).toBeNull()
  })

  it('returns null for negative numbers', () => {
    expect(parseVersion('1.-2.3')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('detects newer major version', () => {
    expect(isNewerVersion('2.0.0', '1.0.0')).toBe(true)
  })

  it('detects newer minor version', () => {
    expect(isNewerVersion('1.3.0', '1.2.0')).toBe(true)
  })

  it('detects newer patch version', () => {
    expect(isNewerVersion('1.2.4', '1.2.3')).toBe(true)
  })

  it('returns false for same version', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
  })

  it('returns false for older version', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false)
    expect(isNewerVersion('1.1.0', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false)
  })

  it('handles v prefix on both inputs', () => {
    expect(isNewerVersion('v2.0.0', 'v1.0.0')).toBe(true)
    expect(isNewerVersion('v1.0.0', 'v2.0.0')).toBe(false)
  })

  it('returns false for invalid inputs', () => {
    expect(isNewerVersion('invalid', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', 'invalid')).toBe(false)
  })
})

describe('parseLatestTag', () => {
  it('parses git ls-remote output with refs', () => {
    const output = [
      'abc123\trefs/tags/v0.1.0',
      'def456\trefs/tags/v0.2.0',
      'ghi789\trefs/tags/v0.3.0',
    ].join('\n')

    expect(parseLatestTag(output)).toBe('0.3.0')
  })

  it('parses plain git tag list output', () => {
    const output = 'v0.1.0\nv0.2.0\nv0.3.0'
    expect(parseLatestTag(output)).toBe('0.3.0')
  })

  it('returns highest version regardless of order', () => {
    const output = 'v0.3.0\nv0.1.0\nv0.10.0\nv0.2.0'
    expect(parseLatestTag(output)).toBe('0.10.0')
  })

  it('ignores non-semver and pre-release tags', () => {
    const output = [
      'abc123\trefs/tags/v0.1.0',
      'def456\trefs/tags/latest',
      'ghi789\trefs/tags/v0.3.0-beta.1',
      'jkl012\trefs/tags/v0.2.0',
    ].join('\n')

    // v0.3.0-beta.1 is rejected (pre-release), 'latest' is rejected (non-semver)
    // Only v0.1.0 and v0.2.0 match, so v0.2.0 is latest
    expect(parseLatestTag(output)).toBe('0.2.0')
  })

  it('returns null for empty output', () => {
    expect(parseLatestTag('')).toBeNull()
  })

  it('returns null for output with no semver tags', () => {
    expect(parseLatestTag('abc123\trefs/tags/latest\ndef456\trefs/tags/stable')).toBeNull()
  })
})

// --- Integration tests requiring mocks ---

describe('runUpdate', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    mockUpdateConfig.mockReturnValue({})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.clearAllMocks()
  })

  function setupGitLsRemote(tags: string[]) {
    const lsRemoteOutput = tags
      .map((t, i) => `abc${i}\trefs/tags/${t}`)
      .join('\n')

    mockExec.mockImplementation((_cmd: string, args: string[]) => {
      // git ls-remote
      if (args.includes('ls-remote')) {
        return Promise.resolve({ stdout: lsRemoteOutput, stderr: '', exitCode: 0 })
      }
      // git rev-parse --show-toplevel
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ stdout: '/fake/install/dir', stderr: '', exitCode: 0 })
      }
      // git fetch --tags
      if (args.includes('fetch')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
      }
      // git log (changelog)
      if (args.includes('log')) {
        return Promise.resolve({
          stdout: 'abc1234 feat: new feature\ndef5678 fix: bug fix',
          stderr: '',
          exitCode: 0,
        })
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    })
  }

  it('shows update available and changelog when newer version exists', async () => {
    setupGitLsRemote(['v99.0.0', 'v0.2.0', 'v0.1.0'])
    mockConfirm.mockResolvedValue(true)
    mockExecInteractive.mockResolvedValue(0) // all steps succeed

    await runUpdate()

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('v99.0.0')
    expect(output).toContain("What's new")
    expect(output).toContain('feat: new feature')
    expect(output).toContain('Updated to v99.0.0')
  })

  it('reports already on latest version when no newer version', async () => {
    // PKG_VERSION is current version via vitest.config.ts define; v0.1.0 is strictly older
    setupGitLsRemote(['v0.1.0', 'v0.0.1'])

    await runUpdate()

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('latest version')
    expect(mockExecInteractive).not.toHaveBeenCalled()
  })

  it('aborts update when user declines confirmation', async () => {
    setupGitLsRemote(['v99.0.0']) // Definitely newer than any current version
    mockConfirm.mockResolvedValue(false)

    await runUpdate()

    // execInteractive (update steps) should not have been called
    expect(mockExecInteractive).not.toHaveBeenCalled()
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('cancelled')
  })

  it('throws AppError when git ls-remote fails', async () => {
    // Install dir resolves OK, but ls-remote fails
    mockExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ stdout: '/fake/install/dir', stderr: '', exitCode: 0 })
      }
      return Promise.resolve({ stdout: '', stderr: 'network error', exitCode: 128 })
    })

    await expect(runUpdate()).rejects.toThrow('Could not fetch latest version')
  })

  it('throws AppError when install dir cannot be resolved', async () => {
    // --show-toplevel fails — ls-remote should never be reached
    mockExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ stdout: '', stderr: 'not a git repo', exitCode: 128 })
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    })

    await expect(runUpdate()).rejects.toThrow('installation directory')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('throws AppError when a build step fails', async () => {
    setupGitLsRemote(['v99.0.0'])
    mockConfirm.mockResolvedValue(true)
    // First step (git pull) fails
    mockExecInteractive.mockResolvedValue(1)

    await expect(runUpdate()).rejects.toThrow('Update failed')
  })

  it('persists update check result in config after successful update', async () => {
    setupGitLsRemote(['v99.0.0'])
    mockConfirm.mockResolvedValue(true)
    mockExecInteractive.mockResolvedValue(0)

    await runUpdate()

    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        updater: expect.objectContaining({
          latestKnownVersion: '99.0.0',
        }),
      }),
    )
  })
})

describe('checkForUpdateNotification', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockUpdateConfig.mockReturnValue({})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  /** Helper: mock exec to resolve install dir + ls-remote with given tag output */
  function setupAutoCheck(lsRemoteOutput: string, lsRemoteExitCode = 0) {
    mockExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ stdout: '/fake/install/dir', stderr: '', exitCode: 0 })
      }
      if (args.includes('ls-remote')) {
        return Promise.resolve({ stdout: lsRemoteOutput, stderr: '', exitCode: lsRemoteExitCode })
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    })
  }

  it('skips check when last check was within 24 hours', async () => {
    mockGetConfig.mockReturnValue({
      updater: {
        lastCheckedAt: new Date().toISOString(), // just now
        latestKnownVersion: '',
      },
    })

    await checkForUpdateNotification()

    // No exec calls should have happened
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('performs check when last check was more than 24 hours ago', async () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: yesterday, latestKnownVersion: '' },
    })
    setupAutoCheck('abc\trefs/tags/v99.0.0')

    await checkForUpdateNotification()

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['ls-remote']),
      expect.any(Object),
    )
  })

  it('performs check when lastCheckedAt is empty', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    setupAutoCheck('abc\trefs/tags/v99.0.0')

    await checkForUpdateNotification()

    expect(mockExec).toHaveBeenCalled()
  })

  it('prints update notification when newer version is available', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    setupAutoCheck('abc\trefs/tags/v99.0.0')

    await checkForUpdateNotification()

    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('Update available')
    expect(output).toContain('kode-review --update')
  })

  it('stores lastCheckedAt immediately to prevent parallel runs', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    setupAutoCheck('abc\trefs/tags/v0.1.0')

    await checkForUpdateNotification()

    // First updateConfig call should be the immediate timestamp set
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        updater: expect.objectContaining({
          lastCheckedAt: expect.any(String),
        }),
      }),
    )
  })

  it('never throws even when git commands fail', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    mockExec.mockRejectedValue(new Error('git crashed'))

    // Must not throw
    await expect(checkForUpdateNotification()).resolves.toBeUndefined()
  })

  it('never throws even when config read fails', async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error('config corrupt')
    })

    // Must not throw
    await expect(checkForUpdateNotification()).resolves.toBeUndefined()
  })

  it('silently exits when install dir cannot be resolved', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    mockExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ stdout: '', stderr: 'not a git repo', exitCode: 128 })
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    })

    await checkForUpdateNotification()

    // No notification should be shown
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).not.toContain('Update available')
  })

  it('silently exits when git ls-remote returns non-zero exit code', async () => {
    mockGetConfig.mockReturnValue({
      updater: { lastCheckedAt: '', latestKnownVersion: '' },
    })
    setupAutoCheck('', 128)

    await checkForUpdateNotification()

    // No notification should be shown
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).not.toContain('Update available')
  })
})
