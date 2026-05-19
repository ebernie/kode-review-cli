/**
 * Tests for clawpatch-cli.ts — the thin execa wrappers.
 *
 * Mocks the exec utility so we can assert subprocess argv without launching
 * clawpatch. The SUT is the argv construction, not the underlying spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('../../utils/exec.js', () => ({ exec: execMock }))

import {
  runClawpatch,
  runClawpatchDoctor,
  runClawpatchMap,
} from '../clawpatch-cli.js'

beforeEach(() => {
  execMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runClawpatchMap', () => {
  it('invokes `clawpatch map` with cwd at repoRoot', async () => {
    execMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })
    const result = await runClawpatchMap('/tmp/repo')
    expect(execMock).toHaveBeenCalledWith('clawpatch', ['map'], { cwd: '/tmp/repo' })
    expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' })
  })

  it('passes --force when options.force is true', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await runClawpatchMap('/tmp/repo', { force: true })
    expect(execMock).toHaveBeenCalledWith('clawpatch', ['map', '--force'], { cwd: '/tmp/repo' })
  })

  it('does not pass --force when options.force is false or undefined', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await runClawpatchMap('/tmp/repo', { force: false })
    expect(execMock).toHaveBeenLastCalledWith('clawpatch', ['map'], { cwd: '/tmp/repo' })
  })

  it('preserves the exit code (non-zero is not thrown)', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: 'fail', exitCode: 2 })
    const result = await runClawpatchMap('/tmp/repo')
    expect(result.exitCode).toBe(2)
  })
})

describe('runClawpatchDoctor', () => {
  it('invokes `clawpatch doctor --json`', async () => {
    execMock.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 })
    await runClawpatchDoctor('/tmp/repo')
    expect(execMock).toHaveBeenCalledWith('clawpatch', ['doctor', '--json'], { cwd: '/tmp/repo' })
  })

  it('appends --provider and --model when supplied', async () => {
    execMock.mockResolvedValue({ stdout: '{}', stderr: '', exitCode: 0 })
    await runClawpatchDoctor('/tmp/repo', { provider: 'pi', model: 'anthropic/claude-sonnet-4-6' })
    expect(execMock).toHaveBeenCalledWith(
      'clawpatch',
      ['doctor', '--json', '--provider', 'pi', '--model', 'anthropic/claude-sonnet-4-6'],
      { cwd: '/tmp/repo' },
    )
  })

  it('parses the JSON payload from stdout', async () => {
    execMock.mockResolvedValue({
      stdout: '{"provider":"pi","providerVersion":"0.70.2"}',
      stderr: '',
      exitCode: 0,
    })
    const result = await runClawpatchDoctor('/tmp/repo')
    expect(result.payload).toEqual({ provider: 'pi', providerVersion: '0.70.2' })
    expect(result.exitCode).toBe(0)
  })

  it('returns payload: null when stdout is not valid JSON', async () => {
    execMock.mockResolvedValue({ stdout: 'broken', stderr: '', exitCode: 0 })
    const result = await runClawpatchDoctor('/tmp/repo')
    expect(result.payload).toBeNull()
    expect(result.raw).toContain('broken')
  })
})

describe('runClawpatch (passthrough)', () => {
  it('forwards user args verbatim with cwd', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await runClawpatch('/tmp/repo', ['report', '--json'])
    expect(execMock).toHaveBeenCalledWith('clawpatch', ['report', '--json'], { cwd: '/tmp/repo' })
  })

  it('does not prepend anything to the args array (caller owns argv shape)', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await runClawpatch('/tmp/repo', ['review', '--limit', '3'])
    const argv = execMock.mock.calls[0]?.[1]
    expect(argv?.[0]).toBe('review')
  })
})
