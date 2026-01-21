import { exec, commandExists } from '../utils/exec.js'

export interface PrerequisiteCheck {
  dockerInstalled: boolean
  dockerRunning: boolean
  composeAvailable: boolean
  message: string
}

/**
 * Check if Docker is installed
 */
export async function isDockerAvailable(): Promise<boolean> {
  return await commandExists('docker')
}

/**
 * Check if Docker daemon is running
 */
export async function isDockerRunning(): Promise<boolean> {
  const result = await exec('docker', ['info'])
  return result.exitCode === 0
}

/**
 * Check if Docker Compose is available (v2 built into docker)
 */
export async function isComposeAvailable(): Promise<boolean> {
  const result = await exec('docker', ['compose', 'version'])
  return result.exitCode === 0
}

/**
 * Check all prerequisites for the indexer
 */
export async function checkIndexerPrerequisites(): Promise<PrerequisiteCheck> {
  const dockerInstalled = await isDockerAvailable()

  if (!dockerInstalled) {
    return {
      dockerInstalled: false,
      dockerRunning: false,
      composeAvailable: false,
      message: 'Docker is not installed. Please install Docker Desktop (macOS/Windows) or Docker Engine (Linux).',
    }
  }

  const dockerRunning = await isDockerRunning()

  if (!dockerRunning) {
    return {
      dockerInstalled: true,
      dockerRunning: false,
      composeAvailable: false,
      message: 'Docker is installed but not running. Please start Docker Desktop or the Docker daemon.',
    }
  }

  const composeAvailable = await isComposeAvailable()

  if (!composeAvailable) {
    return {
      dockerInstalled: true,
      dockerRunning: true,
      composeAvailable: false,
      message: 'Docker Compose is not available. Please ensure you have Docker Compose v2 installed.',
    }
  }

  return {
    dockerInstalled: true,
    dockerRunning: true,
    composeAvailable: true,
    message: 'All prerequisites met. Ready to set up the indexer.',
  }
}
