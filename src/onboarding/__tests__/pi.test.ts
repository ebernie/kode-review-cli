import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
  commandExists: vi.fn(),
}))

import { exec, commandExists } from '../../utils/exec.js'
import { isPiInstalled, piHasUsableModel } from '../pi.js'

const mockExec = exec as unknown as ReturnType<typeof vi.fn>
const mockCommandExists = commandExists as unknown as ReturnType<typeof vi.fn>

describe('isPiInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when pi is on PATH', async () => {
    mockCommandExists.mockResolvedValue(true)
    expect(await isPiInstalled()).toBe(true)
    expect(mockCommandExists).toHaveBeenCalledWith('pi')
  })

  it('returns false when pi is not on PATH', async () => {
    mockCommandExists.mockResolvedValue(false)
    expect(await isPiInstalled()).toBe(false)
  })
})

describe('piHasUsableModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when pi --list-models reports no models', async () => {
    mockExec.mockResolvedValue({
      stdout: 'No models available. Use /login to log into a provider via OAuth or API key.',
      stderr: '',
      exitCode: 0,
    })
    expect(await piHasUsableModel()).toBe(false)
  })

  it('returns true when pi --list-models lists at least one model', async () => {
    mockExec.mockResolvedValue({
      stdout: 'anthropic/claude-sonnet-4-6\nanthropic/claude-opus-4-5\n',
      stderr: '',
      exitCode: 0,
    })
    expect(await piHasUsableModel()).toBe(true)
  })

  it('returns false when the pi command exits non-zero', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'pi: command not found', exitCode: 127 })
    expect(await piHasUsableModel()).toBe(false)
  })

  it('returns false on empty stdout (defensive)', async () => {
    mockExec.mockResolvedValue({ stdout: '   \n', stderr: '', exitCode: 0 })
    expect(await piHasUsableModel()).toBe(false)
  })
})
