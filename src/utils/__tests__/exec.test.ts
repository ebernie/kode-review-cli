import { afterEach, describe, expect, it, vi } from 'vitest'

const execaMock = vi.hoisted(() => vi.fn())

vi.mock('execa', () => ({
  execa: execaMock,
}))

const { exec } = await import('../exec.js')

describe('exec', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats signal-killed subprocesses with %s exitCode as failed', async (_label, exitCode) => {
    execaMock.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode,
      signal: 'SIGTERM',
    })

    const result = await exec('gh', ['auth', 'status'])

    expect(execaMock).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.objectContaining({
      reject: false,
    }))
    expect(result.exitCode).toBe(1)
  })

  it('preserves explicit zero and non-zero exit codes', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 2 })

    await expect(exec('true')).resolves.toMatchObject({ exitCode: 0 })
    await expect(exec('false')).resolves.toMatchObject({ exitCode: 2 })
  })
})
