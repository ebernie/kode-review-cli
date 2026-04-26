import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mocks must be declared before module imports that consume them.
vi.mock('../../config/index.js', () => ({
  hasOldSchema: vi.fn(),
  readLegacyComposeProject: vi.fn(),
  resetConfig: vi.fn(),
  getConfigPath: vi.fn(() => '/tmp/fake-config/config.json'),
}))

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
  commandExists: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  rm: vi.fn(),
}))

import {
  hasOldSchema,
  readLegacyComposeProject,
  resetConfig,
} from '../../config/index.js'
import { exec, commandExists } from '../../utils/exec.js'
import { rm } from 'node:fs/promises'
import { runMigration, needsMigration } from '../migration.js'

const mockHasOld = hasOldSchema as unknown as ReturnType<typeof vi.fn>
const mockReadCompose = readLegacyComposeProject as unknown as ReturnType<typeof vi.fn>
const mockResetConfig = resetConfig as unknown as ReturnType<typeof vi.fn>
const mockExec = exec as unknown as ReturnType<typeof vi.fn>
const mockCommandExists = commandExists as unknown as ReturnType<typeof vi.fn>
const mockRm = rm as unknown as ReturnType<typeof vi.fn>

describe('migration', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.KODE_REVIEW_MIGRATE_YES
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  describe('needsMigration', () => {
    it('returns true when the on-disk config has the legacy schema marker', () => {
      mockHasOld.mockReturnValue(true)
      expect(needsMigration()).toBe(true)
    })

    it('returns false when the on-disk config is the current schema', () => {
      mockHasOld.mockReturnValue(false)
      expect(needsMigration()).toBe(false)
    })
  })

  describe('runMigration', () => {
    it('is a no-op when no old schema is present', async () => {
      mockHasOld.mockReturnValue(false)
      const result = await runMigration({ skipConfirm: true })
      expect(result).toEqual({ performed: false, skipReason: 'no-old-schema' })
      expect(mockResetConfig).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
    })

    it('aborts when the typed confirmation does not match "wipe"', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(true)
      const result = await runMigration({ readLine: async () => 'no' })
      expect(result).toEqual({ performed: false, skipReason: 'aborted' })
      expect(mockResetConfig).not.toHaveBeenCalled()
      expect(mockExec).not.toHaveBeenCalled()
      expect(mockRm).not.toHaveBeenCalled()
    })

    it('proceeds when user types exactly "wipe"', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(true)
      mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      mockRm.mockResolvedValue(undefined)

      const result = await runMigration({ readLine: async () => 'wipe' })

      expect(result).toEqual({ performed: true })
      expect(mockExec).toHaveBeenCalledWith('docker', ['compose', '-p', 'kode-review-indexer', 'down', '-v'])
      // Verify rm was invoked on the watch-config directory (not, say, the
      // main config path) so a regression that swaps directories is caught.
      expect(mockRm).toHaveBeenCalledTimes(1)
      const rmPath = mockRm.mock.calls[0][0] as string
      expect(rmPath).toContain('kode-review-watch')
      expect(mockRm).toHaveBeenCalledWith(rmPath, { recursive: true, force: true })
      expect(mockResetConfig).toHaveBeenCalledTimes(1)
    })

    it('--migrate-yes / skipConfirm bypasses the prompt', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('my-custom-project')
      mockCommandExists.mockResolvedValue(true)
      mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      mockRm.mockResolvedValue(undefined)

      const result = await runMigration({ skipConfirm: true })

      expect(result).toEqual({ performed: true })
      expect(mockExec).toHaveBeenCalledWith('docker', ['compose', '-p', 'my-custom-project', 'down', '-v'])
      expect(mockResetConfig).toHaveBeenCalled()
    })

    it('honors KODE_REVIEW_MIGRATE_YES env var', async () => {
      process.env.KODE_REVIEW_MIGRATE_YES = '1'
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(true)
      mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      mockRm.mockResolvedValue(undefined)

      const result = await runMigration()
      expect(result).toEqual({ performed: true })
      expect(mockResetConfig).toHaveBeenCalled()
    })

    it('reads composeProject from legacy config BEFORE wiping', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('legacy-project-name')
      mockCommandExists.mockResolvedValue(true)
      mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      mockRm.mockResolvedValue(undefined)

      const callOrder: string[] = []
      mockReadCompose.mockImplementation(() => {
        callOrder.push('readCompose')
        return 'legacy-project-name'
      })
      mockResetConfig.mockImplementation(() => {
        callOrder.push('resetConfig')
      })

      await runMigration({ skipConfirm: true })

      expect(callOrder.indexOf('readCompose')).toBeLessThan(callOrder.indexOf('resetConfig'))
      expect(mockExec).toHaveBeenCalledWith('docker', ['compose', '-p', 'legacy-project-name', 'down', '-v'])
    })

    it('continues with config wipe even when docker tear-down fails', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(true)
      mockExec.mockResolvedValue({ stdout: '', stderr: 'no such project', exitCode: 1 })
      mockRm.mockResolvedValue(undefined)

      const result = await runMigration({ skipConfirm: true })
      expect(result).toEqual({ performed: true })
      expect(mockResetConfig).toHaveBeenCalled()
    })

    it('skips docker tear-down when docker command is unavailable', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(false)
      mockRm.mockResolvedValue(undefined)

      const result = await runMigration({ skipConfirm: true })
      expect(result).toEqual({ performed: true })
      expect(mockExec).not.toHaveBeenCalled()
      expect(mockResetConfig).toHaveBeenCalled()
    })

    it('aborts with skipReason="no-tty" when stdin is not a TTY and no readLine override is supplied', async () => {
      mockHasOld.mockReturnValue(true)
      mockReadCompose.mockReturnValue('kode-review-indexer')
      mockCommandExists.mockResolvedValue(true)

      // Force isTTY to falsy for the duration of the test.
      const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
      try {
        const result = await runMigration({})
        expect(result).toEqual({ performed: false, skipReason: 'no-tty' })
        expect(mockResetConfig).not.toHaveBeenCalled()
        expect(mockExec).not.toHaveBeenCalled()
        expect(mockRm).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(process.stdin, 'isTTY', original)
      }
    })
  })
})
