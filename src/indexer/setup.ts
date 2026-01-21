import { confirm } from '@inquirer/prompts'
import ora from 'ora'
import { checkIndexerPrerequisites } from './detector.js'
import { startIndexer, stopIndexer, getIndexerStatus, getIndexerApiUrl, cleanupIndexer } from './docker.js'
import { updateConfig, getConfig } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { green, cyan, yellow, red } from '../cli/colors.js'

/**
 * Interactive setup wizard for the indexer
 */
export async function setupIndexer(): Promise<void> {
  console.log('')
  console.log(cyan('========================================'))
  console.log(cyan('       Code Indexer Setup Wizard        '))
  console.log(cyan('========================================'))
  console.log('')

  // Check prerequisites
  const spinner = ora('Checking prerequisites...').start()
  const prereqs = await checkIndexerPrerequisites()
  spinner.stop()

  if (!prereqs.dockerInstalled || !prereqs.dockerRunning || !prereqs.composeAvailable) {
    console.log(red('Prerequisites not met:'))
    console.log(yellow(prereqs.message))
    console.log('')
    console.log('Please install Docker and try again.')
    console.log('  - macOS/Windows: https://www.docker.com/products/docker-desktop/')
    console.log('  - Linux: https://docs.docker.com/engine/install/')
    return
  }

  console.log(green('All prerequisites met.'))
  console.log('')

  // Explain what will be set up
  console.log('The indexer enables semantic code search for better reviews.')
  console.log('It runs as a Docker container with:')
  console.log('  - PostgreSQL with pgvector for storage')
  console.log('  - SentenceTransformer for embeddings')
  console.log('  - FastAPI server on port 8321 (configurable)')
  console.log('')

  const proceed = await confirm({
    message: 'Set up the code indexer?',
    default: true,
  })

  if (!proceed) {
    console.log('Setup cancelled.')
    return
  }

  console.log('')

  // Start the indexer
  const startSpinner = ora('Building and starting indexer containers...').start()

  try {
    const apiUrl = await startIndexer()
    startSpinner.succeed('Indexer started successfully')

    // Update config
    updateConfig({
      indexer: {
        ...getConfig().indexer,
        enabled: true,
      },
    })

    console.log('')
    console.log(green('Setup complete.'))
    console.log('')
    console.log('Next steps:')
    console.log(`  1. Index your repository: ${cyan('kode-review --index')}`)
    console.log(`  2. Run a review with context: ${cyan('kode-review --with-context')}`)
    console.log('')
    console.log(`Indexer API running at: ${cyan(apiUrl)}`)
    console.log('')
    console.log('Other commands:')
    console.log(`  - Check status: ${cyan('kode-review --index-status')}`)
    console.log(`  - Re-index: ${cyan('kode-review --index')}`)
    console.log(`  - Reset index: ${cyan('kode-review --index-reset')}`)
  } catch (error) {
    startSpinner.fail('Failed to start indexer')
    const message = error instanceof Error ? error.message : String(error)
    logger.error(message)
    console.log('')
    console.log('Troubleshooting:')
    console.log('  - Ensure Docker has enough resources (CPU, memory)')
    console.log('  - Check if ports 8321 and 5436 are available')
    console.log('  - Try running: docker compose logs')
  }
}

/**
 * Show the current status of the indexer
 */
export async function showIndexerStatus(): Promise<void> {
  const spinner = ora('Checking indexer status...').start()

  try {
    const status = await getIndexerStatus()
    const config = getConfig()
    spinner.stop()

    console.log('')
    console.log(cyan('========================================'))
    console.log(cyan('          Indexer Status                '))
    console.log(cyan('========================================'))
    console.log('')

    // Feature status
    console.log(`Feature enabled: ${config.indexer.enabled ? green('Yes') : yellow('No')}`)
    console.log('')

    // Container status
    console.log('Container Status:')
    const apiStatusColor = status.containerStatus === 'running' ? green : status.containerStatus === 'stopped' ? yellow : red
    const dbStatusColor = status.dbStatus === 'running' ? green : status.dbStatus === 'stopped' ? yellow : red

    console.log(`  API: ${apiStatusColor(status.containerStatus)}`)
    console.log(`  Database: ${dbStatusColor(status.dbStatus)}`)
    console.log('')

    // Health status
    if (status.running) {
      console.log(`Health: ${status.healthy ? green('Healthy') : red('Unhealthy')}`)
      console.log(`API URL: ${cyan(status.apiUrl || getIndexerApiUrl())}`)
    } else {
      console.log(`Health: ${yellow('Not running')}`)
    }
    console.log('')

    // Configuration
    console.log('Configuration:')
    console.log(`  API Port: ${config.indexer.apiPort}`)
    console.log(`  DB Port: ${config.indexer.dbPort}`)
    console.log(`  Embedding Model: ${config.indexer.embeddingModel}`)
    console.log(`  Chunk Size: ${config.indexer.chunkSize}`)
    console.log(`  Top-K Results: ${config.indexer.topK}`)
    console.log('')

    // Actions
    if (!status.running) {
      console.log(yellow('The indexer is not running.'))
      console.log(`Start it with: ${cyan('kode-review --setup-indexer')}`)
    } else if (!config.indexer.enabled) {
      console.log(yellow('The indexer is running but the feature is disabled.'))
      console.log(`Enable it by running: ${cyan('kode-review --setup-indexer')}`)
    }
  } catch (error) {
    spinner.fail('Failed to get status')
    const message = error instanceof Error ? error.message : String(error)
    logger.error(message)
  }
}

/**
 * Handle stopping the indexer
 */
export async function handleStopIndexer(): Promise<void> {
  const status = await getIndexerStatus()

  if (!status.running) {
    logger.info('Indexer is not running')
    return
  }

  const confirmed = await confirm({
    message: 'Stop the indexer containers?',
    default: false,
  })

  if (!confirmed) {
    return
  }

  await stopIndexer()
}

/**
 * Handle complete cleanup of the indexer
 */
export async function handleCleanupIndexer(): Promise<void> {
  console.log('')
  console.log(yellow('========================================'))
  console.log(yellow('       Indexer Cleanup                  '))
  console.log(yellow('========================================'))
  console.log('')

  console.log('This will permanently remove:')
  console.log(red('  - All Docker containers for the indexer'))
  console.log(red('  - All Docker volumes (including indexed data)'))
  console.log(red('  - Docker images built for the indexer'))
  console.log(red('  - Configuration files in ~/.config/kode-review/indexer/'))
  console.log('')

  const confirmed = await confirm({
    message: 'Are you sure you want to remove the indexer completely?',
    default: false,
  })

  if (!confirmed) {
    console.log('Cleanup cancelled.')
    return
  }

  // Double confirmation for destructive operation
  const doubleConfirmed = await confirm({
    message: 'This action cannot be undone. Proceed?',
    default: false,
  })

  if (!doubleConfirmed) {
    console.log('Cleanup cancelled.')
    return
  }

  console.log('')

  const spinner = ora('Cleaning up indexer...').start()

  try {
    await cleanupIndexer()

    // Update config to disable indexer
    updateConfig({
      indexer: {
        ...getConfig().indexer,
        enabled: false,
      },
    })

    spinner.succeed('Indexer completely removed')

    console.log('')
    console.log(green('Cleanup complete.'))
    console.log('')
    console.log('To set up the indexer again in the future, run:')
    console.log(`  ${cyan('kode-review --setup-indexer')}`)
    console.log('')
  } catch (error) {
    spinner.fail('Cleanup failed')
    const message = error instanceof Error ? error.message : String(error)
    logger.error(message)
  }
}
