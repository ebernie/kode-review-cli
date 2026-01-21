import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Create mock functions
const mockExec = vi.fn()
const mockCommandExists = vi.fn()

// Mock the exec module before importing the module under test
vi.mock('../../utils/exec.js', () => ({
  exec: mockExec,
  commandExists: mockCommandExists,
}))

// Import after mocking
import { checkIndexerPrerequisites } from '../detector.js'

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
