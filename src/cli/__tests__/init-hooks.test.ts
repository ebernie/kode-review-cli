import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Create module-level mocks
const mockWriteFile = vi.fn()
const mockReadFile = vi.fn()
const mockAccess = vi.fn()
const mockMkdir = vi.fn()
const mockChmod = vi.fn()
const mockIsGitRepository = vi.fn()
const mockGetRepoRoot = vi.fn()

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  access: mockAccess,
  mkdir: mockMkdir,
  chmod: mockChmod,
}))

// Mock VCS detect
vi.mock('../../vcs/detect.js', () => ({
  isGitRepository: mockIsGitRepository,
  getRepoRoot: mockGetRepoRoot,
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
import { initHooks } from '../init-hooks.js'

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
