import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}))

// Mock VCS detect
vi.mock('../../vcs/detect.js', () => ({
  isGitRepository: vi.fn(),
  getRepoRoot: vi.fn(),
}))

// Mock inquirer prompts
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  select: vi.fn(),
}))

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}))

// Import after mocks
import { initHooks, removeHooks } from '../init-hooks.js'
import { writeFile, readFile, access, mkdir, chmod } from 'node:fs/promises'
import { isGitRepository, getRepoRoot } from '../../vcs/detect.js'
import { confirm, select } from '@inquirer/prompts'

// Get mock references
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>
const mockAccess = access as unknown as ReturnType<typeof vi.fn>
const mockMkdir = mkdir as unknown as ReturnType<typeof vi.fn>
const mockChmod = chmod as unknown as ReturnType<typeof vi.fn>
const mockIsGitRepository = isGitRepository as unknown as ReturnType<typeof vi.fn>
const mockGetRepoRoot = getRepoRoot as unknown as ReturnType<typeof vi.fn>
const mockConfirm = confirm as unknown as ReturnType<typeof vi.fn>
const mockSelect = select as unknown as ReturnType<typeof vi.fn>

describe('initHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: valid git repo
    mockIsGitRepository.mockResolvedValue(true)
    mockGetRepoRoot.mockResolvedValue('/test/repo')
    // Default: no existing files
    mockAccess.mockRejectedValue(new Error('ENOENT'))
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockChmod.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws error when not in git repository', async () => {
    mockIsGitRepository.mockResolvedValue(false)

    await expect(initHooks()).rejects.toThrow('Not in a git repository')
  })

  it('creates pre-commit hook in .git/hooks directory', async () => {
    await initHooks({ interactive: false })

    expect(mockMkdir).toHaveBeenCalledWith('/test/repo/.git/hooks', { recursive: true })
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/test/repo/.git/hooks/pre-commit',
      expect.stringContaining('kode-review'),
      'utf-8'
    )
    expect(mockChmod).toHaveBeenCalledWith('/test/repo/.git/hooks/pre-commit', 0o755)
  })

  it('creates hook with correct format option', async () => {
    await initHooks({ interactive: false, format: 'json' })

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('--format json'),
      'utf-8'
    )
  })

  it('includes --quiet flag in hook', async () => {
    await initHooks({ interactive: false })

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('--quiet'),
      'utf-8'
    )
  })

  it('includes --scope local flag in hook', async () => {
    await initHooks({ interactive: false })

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('--scope local'),
      'utf-8'
    )
  })

  it('creates pre-push hook when hookType is pre-push', async () => {
    await initHooks({ interactive: false, hookType: 'pre-push' })

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/test/repo/.git/hooks/pre-push',
      expect.stringContaining('pre-push'),
      'utf-8'
    )
  })

  it('detects Husky and uses Husky-compatible format', async () => {
    // Mock Husky directory exists
    mockAccess.mockImplementation(async (path) => {
      if (typeof path === 'string' && path.includes('.husky/_/husky.sh')) {
        return undefined // File exists
      }
      throw new Error('ENOENT')
    })

    await initHooks({ interactive: false })

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/test/repo/.husky/pre-commit',
      expect.stringContaining('husky.sh'),
      'utf-8'
    )
  })

  it('makes hook executable with chmod 755', async () => {
    await initHooks({ interactive: false })

    expect(mockChmod).toHaveBeenCalledWith(
      expect.stringContaining('pre-commit'),
      0o755
    )
  })

  it('hook content includes exit status handling', async () => {
    await initHooks({ interactive: false })

    const writeCall = mockWriteFile.mock.calls[0]
    const content = writeCall[1] as string

    expect(content).toContain('exit $?')
  })

  it('creates hooks directory if it does not exist', async () => {
    await initHooks({ interactive: false })

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('hooks'),
      { recursive: true }
    )
  })
})

describe('initHooks with existing hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsGitRepository.mockResolvedValue(true)
    mockGetRepoRoot.mockResolvedValue('/test/repo')
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockChmod.mockResolvedValue(undefined)
  })

  it('warns in non-interactive mode when existing hook is not kode-review', async () => {
    // Mock existing hook file
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\n# Some other hook\necho "hello"')

    const { logger } = await import('../../utils/logger.js')

    await initHooks({ interactive: false })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Use interactive mode')
    )
    // Should NOT write file in non-interactive mode with existing non-kode-review hook
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('replaces existing kode-review hook in non-interactive mode', async () => {
    // Mock existing kode-review hook
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\n# kode-review hook\nkode-review --scope local')

    const { logger } = await import('../../utils/logger.js')

    await initHooks({ interactive: false })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Replacing existing kode-review')
    )
    expect(mockWriteFile).toHaveBeenCalled()
  })
})

describe('initHooks interactive mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsGitRepository.mockResolvedValue(true)
    mockGetRepoRoot.mockResolvedValue('/test/repo')
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockChmod.mockResolvedValue(undefined)
  })

  it('does not write when user declines replacing existing kode-review hook', async () => {
    // Existing kode-review hook
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\n# kode-review hook\nkode-review --scope local')
    mockConfirm.mockResolvedValue(false)

    await initHooks({ interactive: true })

    expect(mockConfirm).toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('writes when user confirms replacing existing kode-review hook', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\n# kode-review hook\nkode-review --scope local')
    mockConfirm.mockResolvedValue(true)

    await initHooks({ interactive: true })

    expect(mockConfirm).toHaveBeenCalled()
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it('appends to existing non-kode-review hook when user selects append', async () => {
    const existingContent = '#!/bin/sh\necho "existing hook"'
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(existingContent)
    mockSelect.mockResolvedValue('append')

    await initHooks({ interactive: true })

    expect(mockSelect).toHaveBeenCalled()
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('existing hook'),
      'utf-8'
    )
    // Should also contain the kode-review block
    const writtenContent = mockWriteFile.mock.calls[0][1] as string
    expect(writtenContent).toContain('kode-review')
  })

  it('replaces existing non-kode-review hook when user selects replace', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\necho "other hook"')
    mockSelect.mockResolvedValue('replace')

    await initHooks({ interactive: true })

    expect(mockSelect).toHaveBeenCalled()
    expect(mockWriteFile).toHaveBeenCalled()
    const writtenContent = mockWriteFile.mock.calls[0][1] as string
    expect(writtenContent).toContain('kode-review')
    expect(writtenContent).not.toContain('other hook')
  })

  it('does not write when user selects cancel on non-kode-review hook', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\necho "other hook"')
    mockSelect.mockResolvedValue('cancel')

    await initHooks({ interactive: true })

    expect(mockSelect).toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe('removeHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsGitRepository.mockResolvedValue(true)
    mockGetRepoRoot.mockResolvedValue('/test/repo')
  })

  it('throws when not in a git repository', async () => {
    mockIsGitRepository.mockResolvedValue(false)
    await expect(removeHooks()).rejects.toThrow('Not in a git repository')
  })

  it('throws when repo root cannot be determined', async () => {
    mockGetRepoRoot.mockResolvedValue(null)
    await expect(removeHooks()).rejects.toThrow('Could not determine repository root')
  })

  it('logs info when a kode-review hook is found', async () => {
    // First path (.git/hooks/pre-commit) exists and contains kode-review
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('#!/bin/sh\nkode-review --scope local --quiet')

    const { logger } = await import('../../utils/logger.js')

    await removeHooks()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Found kode-review hook')
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('delete or edit')
    )
  })

  it('does nothing when no hook files exist', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'))

    const { logger } = await import('../../utils/logger.js')

    await removeHooks()

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Found kode-review hook')
    )
  })
})
