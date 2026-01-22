import { exec, execInteractive } from '../utils/exec.js'
import { getConfig, getConfigPath } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { IndexerClient } from './client.js'
import type { IndexerStatus } from './types.js'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs'

// Get the path to the bundled docker assets
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Get the path to the docker assets directory.
 * Searches multiple locations to handle both development and production.
 */
function getDockerAssetsPath(): string {
  const possiblePaths = [
    // After build: dist/indexer/docker/ (tsup copies assets here)
    join(__dirname, 'indexer', 'docker'),
    // After build: relative to dist/index.js
    join(__dirname, '..', 'dist', 'indexer', 'docker'),
    // Development: src/indexer/docker/
    join(__dirname, 'docker'),
    // Development: from dist back to src
    join(__dirname, '..', 'src', 'indexer', 'docker'),
    // Package root: look for src/indexer/docker from package root
    join(process.cwd(), 'src', 'indexer', 'docker'),
    join(process.cwd(), 'dist', 'indexer', 'docker'),
  ]

  for (const path of possiblePaths) {
    if (existsSync(join(path, 'compose.yaml'))) {
      return path
    }
  }

  // Log paths checked for debugging
  logger.debug(`Docker assets not found. Checked paths: ${possiblePaths.join(', ')}`)
  throw new Error('Docker assets not found. Please reinstall kode-review.')
}

/**
 * Get the config directory for indexer data
 */
function getIndexerConfigDir(): string {
  const configPath = getConfigPath()
  const configDir = dirname(configPath)
  const indexerDir = join(configDir, 'indexer')

  if (!existsSync(indexerDir)) {
    mkdirSync(indexerDir, { recursive: true })
  }

  return indexerDir
}

/**
 * Ensure docker assets are copied to config directory
 */
function ensureDockerAssets(): string {
  const configDir = getIndexerConfigDir()
  const assetsDir = getDockerAssetsPath()

  // Include all necessary files for ephemeral container use and CocoIndex flow
  const files = [
    'compose.yaml',
    'Dockerfile',
    'main.py',
    'indexer.py',
    'incremental.py',
    'cocoindex_flow.py',
    'ast_chunker.py',
    'migrate.py',
    'schema.sql',
    'requirements.txt',
    'verify_export.py',
    'import_graph.py',
    'hybrid.py',
    'bm25.py',
    'call_graph.py',
    'config_parser.py',
    '.env.template',
  ]

  for (const file of files) {
    const src = join(assetsDir, file)
    const dest = join(configDir, file)

    if (existsSync(src)) {
      copyFileSync(src, dest)
    }
  }

  return configDir
}

/**
 * Get the Compose project name from config
 */
function getComposeProject(): string {
  return getConfig().indexer.composeProject
}

/**
 * Get the API URL for the indexer
 */
export function getIndexerApiUrl(): string {
  const config = getConfig()
  return `http://localhost:${config.indexer.apiPort}`
}

/**
 * Write environment file for Docker Compose (API server only, no repo mount)
 */
function writeEnvFile(configDir: string): void {
  const config = getConfig()
  const envContent = `
KODE_REVIEW_API_PORT=${config.indexer.apiPort}
KODE_REVIEW_DB_PORT=${config.indexer.dbPort}
KODE_REVIEW_EMBEDDING_MODEL=${config.indexer.embeddingModel}
`.trim()

  writeFileSync(join(configDir, '.env'), envContent)
}

/**
 * Run a docker compose command
 */
/**
 * Get environment variables for Docker commands.
 * Removes DOCKER_DEFAULT_PLATFORM to ensure native architecture is used.
 */
function getDockerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  // Copy all env vars except DOCKER_DEFAULT_PLATFORM
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'DOCKER_DEFAULT_PLATFORM' && value !== undefined) {
      env[key] = value
    }
  }
  return env
}

async function dockerCompose(
  args: string[],
  options?: { cwd?: string; interactive?: boolean }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const configDir = options?.cwd || ensureDockerAssets()
  const project = getComposeProject()

  const fullArgs = [
    'compose',
    '-f', join(configDir, 'compose.yaml'),
    '-p', project,
    ...args,
  ]

  if (options?.interactive) {
    const exitCode = await execInteractive('docker', fullArgs, { cwd: configDir, env: getDockerEnv(), extendEnv: false })
    return { exitCode, stdout: '', stderr: '' }
  }

  return await exec('docker', fullArgs, { cwd: configDir, env: getDockerEnv(), extendEnv: false })
}

/**
 * Get the Docker network name for the indexer project
 */
function getDockerNetwork(): string {
  const project = getComposeProject()
  return `${project}_default`
}

/**
 * Get the indexer image name
 */
function getIndexerImage(): string {
  const project = getComposeProject()
  return `${project}-api`
}

/**
 * Start the indexer containers (PostgreSQL + API server)
 *
 * Note: This only starts the always-running services.
 * Indexing is done via ephemeral containers.
 */
export async function startIndexer(): Promise<string> {
  const configDir = ensureDockerAssets()
  writeEnvFile(configDir)

  logger.info('Starting indexer containers...')

  // Build and start containers
  const result = await dockerCompose(['up', '-d', '--build'], { cwd: configDir })

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start indexer: ${result.stderr}`)
  }

  // Wait for health check
  logger.info('Waiting for indexer to be ready...')

  const apiUrl = getIndexerApiUrl()
  const client = new IndexerClient(apiUrl)

  // Poll for health
  const maxAttempts = 30
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000))

    try {
      const healthy = await client.health()
      if (healthy) {
        logger.success('Indexer is ready')
        return apiUrl
      }
    } catch {
      // Still starting up
    }
  }

  throw new Error('Indexer failed to become healthy within timeout')
}

/**
 * Stop the indexer containers
 */
export async function stopIndexer(): Promise<void> {
  logger.info('Stopping indexer containers...')

  const configDir = getIndexerConfigDir()
  const result = await dockerCompose(['down'], { cwd: configDir })

  if (result.exitCode !== 0) {
    throw new Error(`Failed to stop indexer: ${result.stderr}`)
  }

  logger.success('Indexer stopped')
}

/**
 * Check if the indexer is currently running
 */
export async function isIndexerRunning(): Promise<boolean> {
  const project = getComposeProject()
  const result = await exec('docker', ['compose', '-p', project, 'ps', '-q'])

  if (result.exitCode !== 0) {
    return false
  }

  // If there's output, containers are running
  return result.stdout.trim().length > 0
}

/**
 * Get the status of the indexer
 */
export async function getIndexerStatus(): Promise<IndexerStatus> {
  const project = getComposeProject()
  const apiUrl = getIndexerApiUrl()

  // Check if containers exist
  const psResult = await exec('docker', ['compose', '-p', project, 'ps', '--format', 'json'])

  if (psResult.exitCode !== 0 || !psResult.stdout.trim()) {
    return {
      running: false,
      apiUrl: null,
      healthy: false,
      containerStatus: 'not_found',
      dbStatus: 'not_found',
    }
  }

  // Parse container status
  let apiStatus: 'running' | 'stopped' | 'not_found' = 'not_found'
  let dbStatus: 'running' | 'stopped' | 'not_found' = 'not_found'

  try {
    // Docker compose ps --format json outputs one JSON per line
    const lines = psResult.stdout.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      const container = JSON.parse(line)
      const name = container.Name || container.Service || ''
      const state = container.State || ''

      if (name.includes('api')) {
        apiStatus = state === 'running' ? 'running' : 'stopped'
      } else if (name.includes('db')) {
        dbStatus = state === 'running' ? 'running' : 'stopped'
      }
    }
  } catch {
    // Failed to parse, check if any containers are running
    const qResult = await exec('docker', ['compose', '-p', project, 'ps', '-q'])
    if (qResult.stdout.trim()) {
      apiStatus = 'running'
      dbStatus = 'running'
    }
  }

  const running = apiStatus === 'running' && dbStatus === 'running'

  // Check health if running
  let healthy = false
  if (running) {
    try {
      const client = new IndexerClient(apiUrl)
      healthy = await client.health()
    } catch {
      healthy = false
    }
  }

  return {
    running,
    apiUrl: running ? apiUrl : null,
    healthy,
    containerStatus: apiStatus,
    dbStatus,
  }
}

/**
 * Index a repository using an ephemeral container
 *
 * This spawns a short-lived container that:
 * 1. Mounts the repository directory
 * 2. Connects to the shared PostgreSQL database
 * 3. Runs the indexer script
 * 4. Exits when complete
 *
 * @param repoPath - Path to the repository
 * @param repoUrl - Repository URL
 * @param branch - Branch to index (optional, defaults to current branch or 'main')
 */
export async function indexRepository(
  repoPath: string,
  repoUrl: string,
  branch?: string
): Promise<void> {
  const config = getConfig()

  // Resolve to absolute path
  const absoluteRepoPath = resolve(repoPath)

  // Ensure indexer services are running (PostgreSQL + API)
  const status = await getIndexerStatus()
  if (!status.running) {
    await startIndexer()
  }

  const effectiveBranch = branch || 'main'
  logger.info(`Indexing repository: ${repoUrl}`)
  logger.info(`Branch: ${effectiveBranch}`)
  logger.info(`Path: ${absoluteRepoPath}`)

  // Build the ephemeral container command
  const network = getDockerNetwork()
  const image = getIndexerImage()
  const dbUrl = 'postgresql://cocoindex:cocoindex@db:5432/cocoindex'

  const dockerArgs = [
    'run',
    '--rm',                                    // Remove container after exit
    '--network', network,                      // Connect to indexer network
    '-v', `${absoluteRepoPath}:/repo:ro`,     // Mount repo read-only
    '-e', `COCOINDEX_DATABASE_URL=${dbUrl}`,
    '-e', `REPO_URL=${repoUrl}`,
    '-e', `REPO_BRANCH=${effectiveBranch}`,
    '-e', `REPO_PATH=/repo`,
    '-e', `EMBEDDING_MODEL=${config.indexer.embeddingModel}`,
    '-e', `CHUNK_SIZE=${config.indexer.chunkSize}`,
    '-e', `CHUNK_OVERLAP=${config.indexer.chunkOverlap}`,
    image,
    'python', 'indexer.py'
  ]

  logger.info('Starting indexer container...')

  // Run the ephemeral container with clean env to ensure native architecture
  const result = await exec('docker', dockerArgs, { timeout: 600000, env: getDockerEnv(), extendEnv: false }) // 10 minute timeout

  if (result.exitCode !== 0) {
    logger.error(`Indexer output:\n${result.stdout}`)
    logger.error(`Indexer errors:\n${result.stderr}`)
    throw new Error(`Indexing failed with exit code ${result.exitCode}`)
  }

  // Parse the result from the output
  const outputLines = result.stdout.split('\n')
  let resultJson: { status: string; files?: number; chunks?: number; error?: string } | null = null

  for (const line of outputLines) {
    if (line.startsWith('__RESULT__:')) {
      try {
        resultJson = JSON.parse(line.substring('__RESULT__:'.length))
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (resultJson?.status === 'success') {
    logger.success(`Indexing complete: ${resultJson.chunks} chunks from ${resultJson.files} files`)
  } else if (resultJson?.status === 'error') {
    throw new Error(`Indexing failed: ${resultJson.error}`)
  } else {
    // No structured result, but command succeeded
    logger.success('Indexing complete')
  }
}

/**
 * Result from incremental indexing operation
 */
export interface IncrementalIndexResult {
  status: string
  repoUrl: string
  repoId: string
  branch: string
  changedFiles: number
  addedFiles: number
  modifiedFiles: number
  deletedFiles: number
  chunksAdded: number
  chunksRemoved: number
  relationshipsInvalidated: number
  cacheHits: number
  cacheMisses: number
  elapsedSeconds: number
  error?: string
}

/**
 * Index a repository incrementally using git diff.
 *
 * This is much faster than full indexing for typical PR scenarios:
 * 1. Detects changed files using git diff or explicit file list
 * 2. Only re-indexes changed files
 * 3. Invalidates relationships when source files change
 * 4. Updates file metadata
 *
 * Performance target: < 5s for typical PR with 10 changed files.
 *
 * @param repoPath - Path to the repository
 * @param repoUrl - Repository URL
 * @param branch - Branch to index (optional, defaults to current branch or 'main')
 * @param options - Incremental indexing options
 */
export async function indexRepositoryIncremental(
  repoPath: string,
  repoUrl: string,
  branch?: string,
  options?: {
    /** Git reference to diff against (default: HEAD~1) */
    baseRef?: string
    /** Explicit list of changed files (alternative to git diff) */
    changedFiles?: string[]
  }
): Promise<IncrementalIndexResult> {
  const config = getConfig()

  // Resolve to absolute path
  const absoluteRepoPath = resolve(repoPath)

  // Ensure indexer services are running (PostgreSQL + API)
  const status = await getIndexerStatus()
  if (!status.running) {
    await startIndexer()
  }

  const effectiveBranch = branch || 'main'
  const baseRef = options?.baseRef || 'HEAD~1'

  logger.info(`Incremental indexing: ${repoUrl}`)
  logger.info(`Branch: ${effectiveBranch}`)
  logger.info(`Base ref: ${baseRef}`)
  logger.info(`Path: ${absoluteRepoPath}`)

  // Build the ephemeral container command
  const network = getDockerNetwork()
  const image = getIndexerImage()
  const dbUrl = 'postgresql://cocoindex:cocoindex@db:5432/cocoindex'

  const envVars = [
    '-e', `COCOINDEX_DATABASE_URL=${dbUrl}`,
    '-e', `REPO_URL=${repoUrl}`,
    '-e', `REPO_BRANCH=${effectiveBranch}`,
    '-e', `REPO_PATH=/repo`,
    '-e', `EMBEDDING_MODEL=${config.indexer.embeddingModel}`,
    '-e', `BASE_REF=${baseRef}`,
  ]

  // Add changed files list if provided
  if (options?.changedFiles && options.changedFiles.length > 0) {
    const changedFilesStr = options.changedFiles.join(',')
    envVars.push('-e', `CHANGED_FILES=${changedFilesStr}`)
  }

  // Note: Uses exec from utils/exec.js which safely uses execa (no shell injection)
  const dockerArgs = [
    'run',
    '--rm',
    '--network', network,
    '-v', `${absoluteRepoPath}:/repo:ro`,
    ...envVars,
    image,
    'python', 'incremental.py'
  ]

  logger.info('Starting incremental indexer container...')

  // Run the ephemeral container with shorter timeout (incremental should be fast)
  const result = await exec('docker', dockerArgs, { timeout: 120000, env: getDockerEnv(), extendEnv: false }) // 2 minute timeout

  if (result.exitCode !== 0) {
    logger.error(`Indexer output:\n${result.stdout}`)
    logger.error(`Indexer errors:\n${result.stderr}`)
    throw new Error(`Incremental indexing failed with exit code ${result.exitCode}`)
  }

  // Parse the result from the output
  const outputLines = result.stdout.split('\n')
  let resultJson: {
    status: string
    repo_url?: string
    repo_id?: string
    branch?: string
    changed_files?: number
    added_files?: number
    modified_files?: number
    deleted_files?: number
    chunks_added?: number
    chunks_removed?: number
    relationships_invalidated?: number
    cache_hits?: number
    cache_misses?: number
    elapsed_seconds?: number
    error?: string
  } | null = null

  for (const line of outputLines) {
    if (line.startsWith('__RESULT__:')) {
      try {
        resultJson = JSON.parse(line.substring('__RESULT__:'.length))
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (resultJson?.status === 'success') {
    logger.success(
      `Incremental indexing complete in ${resultJson.elapsed_seconds?.toFixed(2)}s: ` +
      `${resultJson.chunks_added} chunks added, ${resultJson.chunks_removed} removed`
    )

    return {
      status: 'success',
      repoUrl: resultJson.repo_url || repoUrl,
      repoId: resultJson.repo_id || '',
      branch: resultJson.branch || effectiveBranch,
      changedFiles: resultJson.changed_files || 0,
      addedFiles: resultJson.added_files || 0,
      modifiedFiles: resultJson.modified_files || 0,
      deletedFiles: resultJson.deleted_files || 0,
      chunksAdded: resultJson.chunks_added || 0,
      chunksRemoved: resultJson.chunks_removed || 0,
      relationshipsInvalidated: resultJson.relationships_invalidated || 0,
      cacheHits: resultJson.cache_hits || 0,
      cacheMisses: resultJson.cache_misses || 0,
      elapsedSeconds: resultJson.elapsed_seconds || 0,
    }
  } else if (resultJson?.status === 'error') {
    throw new Error(`Incremental indexing failed: ${resultJson.error}`)
  }

  // No structured result, but command succeeded
  logger.success('Incremental indexing complete')
  return {
    status: 'success',
    repoUrl,
    repoId: '',
    branch: effectiveBranch,
    changedFiles: 0,
    addedFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    chunksAdded: 0,
    chunksRemoved: 0,
    relationshipsInvalidated: 0,
    cacheHits: 0,
    cacheMisses: 0,
    elapsedSeconds: 0,
  }
}

/**
 * Reset the index for a repository
 *
 * @param repoUrl - Repository URL
 * @param branch - Optional branch. If not provided, deletes ALL branches for this repo.
 */
export async function resetIndex(repoUrl: string, branch?: string): Promise<void> {
  const status = await getIndexerStatus()

  if (!status.running) {
    throw new Error('Indexer is not running. Start it first with --setup-indexer.')
  }

  const client = new IndexerClient(status.apiUrl!)

  if (branch) {
    logger.info(`Resetting index for: ${repoUrl}@${branch}`)
  } else {
    logger.info(`Resetting index for: ${repoUrl} (all branches)`)
  }

  const result = await client.deleteIndex(repoUrl, branch)
  logger.success(`Index reset complete. ${result.deleted_chunks ?? 0} chunks deleted.`)
}

/**
 * List all indexed repositories with their branches and stats
 */
export async function listIndexedRepos(): Promise<void> {
  const status = await getIndexerStatus()

  if (!status.running) {
    throw new Error('Indexer is not running. Start it first with --setup-indexer.')
  }

  const client = new IndexerClient(status.apiUrl!)

  const repos = await client.listRepos()

  if (repos.length === 0) {
    logger.info('No repositories indexed yet.')
    logger.info('Run "kode-review --index" in a repository to start indexing.')
    return
  }

  console.log('')
  console.log('Indexed Repositories:')
  console.log('=' .repeat(60))

  for (const repo of repos) {
    console.log('')
    console.log(`Repository: ${repo.repoUrl}`)
    console.log(`  ID: ${repo.repoId}`)
    console.log(`  Branches: ${repo.branches.join(', ')}`)
    console.log(`  Total Files: ${repo.totalFiles}`)
    console.log(`  Total Chunks: ${repo.totalChunks}`)
  }

  console.log('')
  console.log('=' .repeat(60))
  console.log(`Total: ${repos.length} repository(ies)`)
}

/**
 * Completely remove the indexer - containers, volumes, images, and config files
 */
export async function cleanupIndexer(): Promise<void> {
  const project = getComposeProject()
  const configDir = getIndexerConfigDir()

  logger.info('Stopping and removing indexer containers...')

  // Stop containers and remove volumes
  const downResult = await exec('docker', [
    'compose',
    '-p', project,
    'down',
    '--volumes',      // Remove named volumes
    '--remove-orphans', // Remove orphan containers
  ])

  if (downResult.exitCode !== 0) {
    // May fail if containers don't exist, that's okay
    logger.debug(`docker compose down result: ${downResult.stderr}`)
  }

  // Remove images built for this project
  logger.info('Removing indexer images...')
  const images = [
    `${project}-api`,
    `${project}_api`,
  ]

  for (const image of images) {
    const rmiResult = await exec('docker', ['rmi', '-f', image])
    if (rmiResult.exitCode === 0) {
      logger.debug(`Removed image: ${image}`)
    }
  }

  // Clean up config directory files
  logger.info('Removing indexer configuration files...')
  const filesToRemove = [
    'compose.yaml',
    'Dockerfile',
    'main.py',
    'indexer.py',
    'incremental.py',
    'cocoindex_flow.py',
    'ast_chunker.py',
    'migrate.py',
    'schema.sql',
    'requirements.txt',
    'verify_export.py',
    'import_graph.py',
    'hybrid.py',
    'bm25.py',
    '.env',
  ]

  for (const file of filesToRemove) {
    const filePath = join(configDir, file)
    if (existsSync(filePath)) {
      const { unlinkSync } = await import('fs')
      unlinkSync(filePath)
      logger.debug(`Removed: ${filePath}`)
    }
  }

  // Try to remove the indexer directory if empty
  try {
    const { rmdirSync } = await import('fs')
    rmdirSync(configDir)
    logger.debug(`Removed directory: ${configDir}`)
  } catch {
    // Directory not empty or doesn't exist, that's fine
  }

  logger.success('Indexer cleanup complete')
}

/**
 * Run the CocoIndex file ingestion flow.
 *
 * This uses the CocoIndex CLI to execute the file ingestion flow,
 * which reads repository files and detects their programming language.
 *
 * @param repoPath - Path to the repository
 * @param repoUrl - Repository URL
 * @param branch - Branch being indexed (optional, defaults to 'main')
 * @param options - Additional options for flow execution
 */
export async function runCocoIndexFlow(
  repoPath: string,
  repoUrl: string,
  branch?: string,
  options?: {
    /** Force setup before update */
    setup?: boolean
    /** Enable live update mode (watch for changes) */
    live?: boolean
    /** Force re-export all data */
    reexport?: boolean
  }
): Promise<void> {
  const config = getConfig()

  // Resolve to absolute path
  const absoluteRepoPath = resolve(repoPath)

  // Ensure indexer services are running (PostgreSQL + API)
  const status = await getIndexerStatus()
  if (!status.running) {
    await startIndexer()
  }

  const effectiveBranch = branch || 'main'
  logger.info(`Running CocoIndex flow for: ${repoUrl}`)
  logger.info(`Branch: ${effectiveBranch}`)
  logger.info(`Path: ${absoluteRepoPath}`)

  // Build the ephemeral container command
  const network = getDockerNetwork()
  const image = getIndexerImage()
  const dbUrl = 'postgresql://cocoindex:cocoindex@db:5432/cocoindex'

  // Build CocoIndex CLI arguments
  const cocoindexArgs = ['update']

  if (options?.setup) {
    cocoindexArgs.push('--setup')
  }

  if (options?.live) {
    cocoindexArgs.push('-L')
  }

  if (options?.reexport) {
    cocoindexArgs.push('--reexport')
  }

  cocoindexArgs.push('cocoindex_flow.py')

  // Note: Using execa via the exec wrapper which safely escapes arguments
  // to prevent command injection (no shell involved)
  const dockerArgs = [
    'run',
    '--rm',                                    // Remove container after exit
    '--network', network,                      // Connect to indexer network
    '-v', `${absoluteRepoPath}:/repo:ro`,     // Mount repo read-only
    '-e', `COCOINDEX_DATABASE_URL=${dbUrl}`,
    '-e', `REPO_URL=${repoUrl}`,
    '-e', `REPO_BRANCH=${effectiveBranch}`,
    '-e', `REPO_PATH=/repo`,
    '-e', `EMBEDDING_MODEL=${config.indexer.embeddingModel}`,
    image,
    'cocoindex',
    ...cocoindexArgs,
  ]

  logger.info('Starting CocoIndex flow container...')

  // Run the ephemeral container with clean env to ensure native architecture
  const timeout = options?.live ? 0 : 600000 // No timeout for live mode, 10 min otherwise
  const result = await exec('docker', dockerArgs, { timeout, env: getDockerEnv(), extendEnv: false })

  if (result.exitCode !== 0) {
    logger.error(`CocoIndex output:\n${result.stdout}`)
    logger.error(`CocoIndex errors:\n${result.stderr}`)
    throw new Error(`CocoIndex flow failed with exit code ${result.exitCode}`)
  }

  logger.info(result.stdout)
  logger.success('CocoIndex flow completed successfully')

  // Run relationship extraction after the main flow
  if (!options?.live) {
    await extractRelationships(repoUrl, effectiveBranch)
  }
}

/**
 * Extract relationships between code chunks.
 *
 * This runs the relationship extraction script which analyzes
 * chunks in the database and creates relationship records based on
 * imports, exports, and symbol references.
 *
 * @param repoUrl - Repository URL
 * @param branch - Branch being indexed
 */
export async function extractRelationships(
  repoUrl: string,
  branch: string
): Promise<void> {
  const status = await getIndexerStatus()
  if (!status.running) {
    throw new Error('Indexer is not running')
  }

  const network = getDockerNetwork()
  const image = getIndexerImage()
  const dbUrl = 'postgresql://cocoindex:cocoindex@db:5432/cocoindex'

  logger.info('Extracting relationships between code chunks...')

  // Note: Using exec wrapper from utils which uses execa (no shell, safe from injection)
  const dockerArgs = [
    'run',
    '--rm',
    '--network', network,
    '-e', `COCOINDEX_DATABASE_URL=${dbUrl}`,
    '-e', `REPO_URL=${repoUrl}`,
    '-e', `REPO_BRANCH=${branch}`,
    image,
    'python', 'cocoindex_flow.py', '--extract-relationships',
  ]

  const result = await exec('docker', dockerArgs, { timeout: 300000, env: getDockerEnv(), extendEnv: false }) // 5 minute timeout

  if (result.exitCode !== 0) {
    logger.warn(`Relationship extraction warning: ${result.stderr}`)
    // Don't fail the whole indexing if relationship extraction fails
    return
  }

  logger.info(result.stdout.trim())
}

/**
 * Verify that data was exported correctly to Postgres.
 *
 * This runs the verification script to check:
 * - Chunks table has embeddings
 * - Relationships table is populated
 * - Vector search works
 *
 * @param repoUrl - Repository URL
 * @param branch - Branch being verified
 */
export async function verifyExport(
  repoUrl: string,
  branch: string
): Promise<boolean> {
  const status = await getIndexerStatus()
  if (!status.running) {
    throw new Error('Indexer is not running')
  }

  const network = getDockerNetwork()
  const image = getIndexerImage()
  const dbUrl = 'postgresql://cocoindex:cocoindex@db:5432/cocoindex'

  logger.info('Verifying export to Postgres...')

  // Note: Using exec wrapper from utils which uses execa (no shell, safe from injection)
  const dockerArgs = [
    'run',
    '--rm',
    '--network', network,
    '-e', `COCOINDEX_DATABASE_URL=${dbUrl}`,
    '-e', `REPO_URL=${repoUrl}`,
    '-e', `REPO_BRANCH=${branch}`,
    image,
    'python', 'verify_export.py', '--skip-search',
  ]

  const result = await exec('docker', dockerArgs, { timeout: 60000, env: getDockerEnv(), extendEnv: false })

  logger.info(result.stdout)

  if (result.exitCode !== 0) {
    logger.error('Verification failed')
    return false
  }

  logger.success('Verification passed')
  return true
}
