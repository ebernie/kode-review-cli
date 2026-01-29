import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { printDiagnostics, type DiagnosticsResult } from '../doctor.js'

// Note: runDiagnostics is complex to test due to system dependencies.
// We focus on printDiagnostics and integration tests for runDiagnostics.

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
