import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the exec module before importing the module under test
vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
  commandExists: vi.fn(),
}))

// Import after mocking
import {
  checkIndexerPrerequisites,
  isDockerAvailable,
  isDockerRunning,
  isComposeAvailable,
} from '../detector.js'
import { exec, commandExists } from '../../utils/exec.js'

// Get mock references
const mockExec = exec as unknown as ReturnType<typeof vi.fn>
const mockCommandExists = commandExists as unknown as ReturnType<typeof vi.fn>

describe('checkIndexerPrerequisites', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('returns failure when Docker is not installed', async () => {
    mockCommandExists.mockResolvedValueOnce(false)

    const result = await checkIndexerPrerequisites()

    expect(result.dockerInstalled).toBe(false)
    expect(result.dockerRunning).toBe(false)
    expect(result.composeAvailable).toBe(false)
    expect(result.message).toContain('Docker is not installed')
  })

  it('returns failure when Docker is installed but not running', async () => {
    mockCommandExists.mockResolvedValueOnce(true) // docker exists
    mockExec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'Cannot connect to Docker daemon' })

    const result = await checkIndexerPrerequisites()

    expect(result.dockerInstalled).toBe(true)
    expect(result.dockerRunning).toBe(false)
    expect(result.composeAvailable).toBe(false)
    expect(result.message).toContain('Docker is installed but not running')
  })

  it('returns failure when Docker Compose is not available', async () => {
    mockCommandExists.mockResolvedValueOnce(true) // docker exists
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // docker info
    mockExec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'compose not found' }) // docker compose version

    const result = await checkIndexerPrerequisites()

    expect(result.dockerInstalled).toBe(true)
    expect(result.dockerRunning).toBe(true)
    expect(result.composeAvailable).toBe(false)
    expect(result.message).toContain('Docker Compose is not available')
  })

  it('returns success when all prerequisites are met', async () => {
    mockCommandExists.mockResolvedValueOnce(true) // docker exists
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // docker info
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Compose version v2.24.0', stderr: '' }) // docker compose version

    const result = await checkIndexerPrerequisites()

    expect(result.dockerInstalled).toBe(true)
    expect(result.dockerRunning).toBe(true)
    expect(result.composeAvailable).toBe(true)
    expect(result.message).toContain('All prerequisites met')
  })
})

describe('isDockerAvailable', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns true when docker command exists', async () => {
    mockCommandExists.mockResolvedValueOnce(true)
    expect(await isDockerAvailable()).toBe(true)
    expect(mockCommandExists).toHaveBeenCalledWith('docker')
  })

  it('returns false when docker command does not exist', async () => {
    mockCommandExists.mockResolvedValueOnce(false)
    expect(await isDockerAvailable()).toBe(false)
  })
})

describe('isDockerRunning', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns true when docker info exits with 0', async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    expect(await isDockerRunning()).toBe(true)
    expect(mockExec).toHaveBeenCalledWith('docker', ['info'])
  })

  it('returns false when docker info exits with non-zero', async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'Cannot connect' })
    expect(await isDockerRunning()).toBe(false)
  })
})

describe('isComposeAvailable', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns true when docker compose version exits with 0', async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: 'v2.24.0', stderr: '' })
    expect(await isComposeAvailable()).toBe(true)
    expect(mockExec).toHaveBeenCalledWith('docker', ['compose', 'version'])
  })

  it('returns false when docker compose version exits with non-zero', async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
    expect(await isComposeAvailable()).toBe(false)
  })
})
