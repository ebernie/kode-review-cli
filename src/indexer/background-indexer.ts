import { EventEmitter } from 'events'
import { logger } from '../utils/logger.js'
import { IndexingJobQueue } from './background-queue.js'
import { indexRepositoryIncremental } from './docker.js'
import type {
  IndexingJob,
  BackgroundIndexerConfig,
  BackgroundIndexingProgress,
  BackgroundIndexerEvent,
} from './types.js'

/**
 * Default configuration for the background indexer
 */
export const DEFAULT_BACKGROUND_INDEXER_CONFIG: BackgroundIndexerConfig = {
  enabled: true,
  autoQueueThreshold: 100,
  pollInterval: 5000,
  maxConcurrentJobs: 1,
}

/**
 * Background indexer service that processes indexing jobs asynchronously.
 *
 * This service runs in the background and processes indexing jobs from the queue.
 * It's designed to handle large repository re-indexing without blocking reviews.
 *
 * Features:
 * - Priority-based job processing
 * - Progress tracking and notifications
 * - Graceful shutdown handling
 * - Event emission for monitoring
 */
export class BackgroundIndexer extends EventEmitter {
  private queue: IndexingJobQueue
  private config: BackgroundIndexerConfig
  private isRunning = false
  private shuttingDown = false
  private currentJob: IndexingJob | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private completedCount = 0
  private failedCount = 0

  constructor(config?: Partial<BackgroundIndexerConfig>) {
    super()
    this.config = { ...DEFAULT_BACKGROUND_INDEXER_CONFIG, ...config }
    this.queue = new IndexingJobQueue()
  }

  /**
   * Start the background indexer
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Background indexer is already running')
      return
    }

    this.isRunning = true
    this.shuttingDown = false
    this.completedCount = 0
    this.failedCount = 0

    logger.info('Background indexer started')
    this.emitEvent({ type: 'indexer_started' })

    // Start the processing loop
    this.scheduleNextPoll()
  }

  /**
   * Stop the background indexer gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    logger.info('Stopping background indexer...')
    this.shuttingDown = true

    // Clear the poll timer
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    // Wait for current job to complete if processing
    if (this.currentJob) {
      logger.info('Waiting for current job to complete...')
      // The job will complete naturally, we just wait
      await new Promise<void>((resolve) => {
        const checkComplete = () => {
          if (!this.currentJob) {
            resolve()
          } else {
            setTimeout(checkComplete, 500)
          }
        }
        checkComplete()
      })
    }

    this.isRunning = false
    logger.info('Background indexer stopped')
    this.emitEvent({ type: 'indexer_stopped' })
  }

  /**
   * Enqueue a job for background indexing
   */
  enqueueJob(params: {
    repoUrl: string
    repoPath: string
    branch: string
    changedFiles?: string[]
    fileCount: number
  }): IndexingJob | null {
    // Check if a job already exists for this repo/branch
    if (this.queue.hasExistingJob(params.repoUrl, params.branch)) {
      logger.debug(
        `Skipping duplicate job for ${params.repoUrl}@${params.branch}`
      )
      return null
    }

    // Determine priority based on file count
    const priority = params.fileCount > 500 ? 'low' : 'normal'

    const job = this.queue.enqueue({
      ...params,
      priority,
    })

    logger.info(
      `Queued background indexing job for ${params.repoUrl}@${params.branch} ` +
        `(${params.fileCount} files, priority: ${priority})`
    )

    // If running, trigger immediate poll
    if (this.isRunning && !this.currentJob) {
      this.scheduleNextPoll(0)
    }

    return job
  }

  /**
   * Get current progress information
   */
  getProgress(): BackgroundIndexingProgress {
    return {
      currentJob: this.currentJob,
      pendingCount: this.queue.getPendingCount(),
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      isRunning: this.isRunning,
    }
  }

  /**
   * Get all jobs from the queue
   */
  getAllJobs(): IndexingJob[] {
    return this.queue.getAllJobs()
  }

  /**
   * Get pending jobs
   */
  getPendingJobs(): IndexingJob[] {
    return this.queue.getJobsByStatus('pending')
  }

  /**
   * Clear all jobs from the queue
   */
  clearQueue(): void {
    this.queue.clearAll()
    logger.info('Background indexing queue cleared')
  }

  /**
   * Schedule the next poll cycle
   */
  private scheduleNextPoll(delayMs?: number): void {
    if (this.shuttingDown) {
      return
    }

    const delay = delayMs ?? this.config.pollInterval

    this.pollTimer = setTimeout(() => {
      this.processNextJob()
    }, delay)
  }

  /**
   * Process the next job in the queue
   */
  private async processNextJob(): Promise<void> {
    if (this.shuttingDown) {
      return
    }

    // Check if we're at max concurrent jobs
    if (this.queue.getProcessingCount() >= this.config.maxConcurrentJobs) {
      this.scheduleNextPoll()
      return
    }

    // Get next pending job
    const job = this.queue.getNextPending()

    if (!job) {
      // No jobs to process, schedule next poll
      this.scheduleNextPoll()
      return
    }

    // Process the job
    this.currentJob = job
    this.queue.markProcessing(job.id)
    this.emitEvent({ type: 'job_started', job })

    logger.info(
      `Processing background indexing job: ${job.repoUrl}@${job.branch} (${job.fileCount} files)`
    )

    try {
      const result = await indexRepositoryIncremental(
        job.repoPath,
        job.repoUrl,
        job.branch,
        job.changedFiles ? { changedFiles: job.changedFiles } : undefined
      )

      // Mark as completed
      this.queue.markCompleted(job.id, {
        chunksAdded: result.chunksAdded,
        chunksRemoved: result.chunksRemoved,
        elapsedSeconds: result.elapsedSeconds,
      })

      // Update the job object with result
      job.status = 'completed'
      job.completedAt = new Date().toISOString()
      job.result = {
        chunksAdded: result.chunksAdded,
        chunksRemoved: result.chunksRemoved,
        elapsedSeconds: result.elapsedSeconds,
      }

      this.completedCount++
      this.emitEvent({ type: 'job_completed', job })

      logger.success(
        `Background indexing completed: ${job.repoUrl}@${job.branch} ` +
          `(+${result.chunksAdded}/-${result.chunksRemoved} chunks in ${result.elapsedSeconds.toFixed(1)}s)`
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Mark as failed
      this.queue.markFailed(job.id, errorMessage)

      // Update the job object
      job.status = 'failed'
      job.completedAt = new Date().toISOString()
      job.error = errorMessage

      this.failedCount++
      this.emitEvent({ type: 'job_failed', job, error: errorMessage })

      logger.error(
        `Background indexing failed: ${job.repoUrl}@${job.branch} - ${errorMessage}`
      )
    } finally {
      this.currentJob = null

      // Schedule next poll
      if (!this.shuttingDown) {
        this.scheduleNextPoll()
      }
    }
  }

  /**
   * Emit a typed event
   */
  private emitEvent(event: BackgroundIndexerEvent): void {
    this.emit(event.type, event)
    this.emit('event', event)
  }
}

// Singleton instance for global access
let globalBackgroundIndexer: BackgroundIndexer | null = null

/**
 * Get or create the global background indexer instance
 */
export function getBackgroundIndexer(
  config?: Partial<BackgroundIndexerConfig>
): BackgroundIndexer {
  if (!globalBackgroundIndexer) {
    globalBackgroundIndexer = new BackgroundIndexer(config)
  }
  return globalBackgroundIndexer
}

/**
 * Check if background indexing should be triggered based on file count
 */
export function shouldTriggerBackgroundIndexing(
  fileCount: number,
  threshold = DEFAULT_BACKGROUND_INDEXER_CONFIG.autoQueueThreshold
): boolean {
  return fileCount > threshold
}

/**
 * Enqueue a background indexing job if threshold is met.
 * Returns true if a job was enqueued, false otherwise.
 */
export function maybeEnqueueBackgroundIndexing(params: {
  repoUrl: string
  repoPath: string
  branch: string
  changedFiles?: string[]
  fileCount: number
  threshold?: number
}): { enqueued: boolean; job: IndexingJob | null } {
  const threshold = params.threshold ?? DEFAULT_BACKGROUND_INDEXER_CONFIG.autoQueueThreshold

  if (!shouldTriggerBackgroundIndexing(params.fileCount, threshold)) {
    return { enqueued: false, job: null }
  }

  const indexer = getBackgroundIndexer()
  const job = indexer.enqueueJob(params)

  return { enqueued: job !== null, job }
}

/**
 * Notify that background indexing has completed (for user notification)
 */
export function formatBackgroundIndexingNotification(job: IndexingJob): string {
  if (job.status === 'completed' && job.result) {
    return (
      `Background indexing completed for ${job.repoUrl}@${job.branch}: ` +
      `+${job.result.chunksAdded}/-${job.result.chunksRemoved} chunks ` +
      `in ${job.result.elapsedSeconds.toFixed(1)}s`
    )
  } else if (job.status === 'failed') {
    return (
      `Background indexing failed for ${job.repoUrl}@${job.branch}: ${job.error}`
    )
  }
  return `Background indexing ${job.status} for ${job.repoUrl}@${job.branch}`
}
