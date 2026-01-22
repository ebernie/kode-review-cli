import Conf from 'conf'
import { randomUUID } from 'crypto'
import type {
  IndexingJob,
  IndexingJobPriority,
  IndexingJobStatus,
} from './types.js'

/**
 * Schema for the job queue state
 */
interface QueueState {
  jobs: Record<string, IndexingJob>
  lastUpdated: string
}

/**
 * Manages persistent queue of background indexing jobs.
 * Uses Conf for persistence to ~/.config/kode-review-indexer-queue/
 */
export class IndexingJobQueue {
  private store: Conf<QueueState>

  constructor(storeName = 'kode-review-indexer-queue') {
    this.store = new Conf<QueueState>({
      projectName: storeName,
      defaults: {
        jobs: {},
        lastUpdated: new Date().toISOString(),
      },
    })
  }

  /**
   * Enqueue a new indexing job
   */
  enqueue(params: {
    repoUrl: string
    repoPath: string
    branch: string
    changedFiles?: string[]
    fileCount: number
    priority?: IndexingJobPriority
  }): IndexingJob {
    const job: IndexingJob = {
      id: randomUUID(),
      repoUrl: params.repoUrl,
      repoPath: params.repoPath,
      branch: params.branch,
      changedFiles: params.changedFiles,
      fileCount: params.fileCount,
      priority: params.priority || 'normal',
      status: 'pending',
      enqueuedAt: new Date().toISOString(),
    }

    const jobs = this.store.get('jobs')
    jobs[job.id] = job
    this.store.set('jobs', jobs)
    this.store.set('lastUpdated', new Date().toISOString())

    return job
  }

  /**
   * Get the next pending job to process (respects priority)
   */
  getNextPending(): IndexingJob | null {
    const jobs = this.store.get('jobs')
    const pendingJobs = Object.values(jobs).filter(
      (job) => job.status === 'pending'
    )

    if (pendingJobs.length === 0) {
      return null
    }

    // Sort by priority (high > normal > low) then by enqueue time
    const priorityOrder: Record<IndexingJobPriority, number> = {
      high: 0,
      normal: 1,
      low: 2,
    }

    pendingJobs.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
      if (priorityDiff !== 0) return priorityDiff
      return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime()
    })

    return pendingJobs[0]
  }

  /**
   * Update job status
   */
  updateStatus(
    jobId: string,
    status: IndexingJobStatus,
    updates?: Partial<Pick<IndexingJob, 'startedAt' | 'completedAt' | 'error' | 'result'>>
  ): void {
    const jobs = this.store.get('jobs')
    const job = jobs[jobId]

    if (!job) {
      throw new Error(`Job not found: ${jobId}`)
    }

    job.status = status
    if (updates) {
      Object.assign(job, updates)
    }

    jobs[jobId] = job
    this.store.set('jobs', jobs)
    this.store.set('lastUpdated', new Date().toISOString())
  }

  /**
   * Mark job as processing
   */
  markProcessing(jobId: string): void {
    this.updateStatus(jobId, 'processing', {
      startedAt: new Date().toISOString(),
    })
  }

  /**
   * Mark job as completed
   */
  markCompleted(
    jobId: string,
    result?: { chunksAdded: number; chunksRemoved: number; elapsedSeconds: number }
  ): void {
    this.updateStatus(jobId, 'completed', {
      completedAt: new Date().toISOString(),
      result,
    })
  }

  /**
   * Mark job as failed
   */
  markFailed(jobId: string, error: string): void {
    this.updateStatus(jobId, 'failed', {
      completedAt: new Date().toISOString(),
      error,
    })
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): IndexingJob | null {
    const jobs = this.store.get('jobs')
    return jobs[jobId] || null
  }

  /**
   * Get all jobs
   */
  getAllJobs(): IndexingJob[] {
    const jobs = this.store.get('jobs')
    return Object.values(jobs)
  }

  /**
   * Get jobs by status
   */
  getJobsByStatus(status: IndexingJobStatus): IndexingJob[] {
    const jobs = this.store.get('jobs')
    return Object.values(jobs).filter((job) => job.status === status)
  }

  /**
   * Get pending job count
   */
  getPendingCount(): number {
    return this.getJobsByStatus('pending').length
  }

  /**
   * Get processing job count
   */
  getProcessingCount(): number {
    return this.getJobsByStatus('processing').length
  }

  /**
   * Check if a job already exists for this repo/branch
   */
  hasExistingJob(repoUrl: string, branch: string): boolean {
    const jobs = this.store.get('jobs')
    return Object.values(jobs).some(
      (job) =>
        job.repoUrl === repoUrl &&
        job.branch === branch &&
        (job.status === 'pending' || job.status === 'processing')
    )
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const jobs = this.store.get('jobs')
    delete jobs[jobId]
    this.store.set('jobs', jobs)
    this.store.set('lastUpdated', new Date().toISOString())
  }

  /**
   * Clear completed and failed jobs older than specified age
   */
  cleanupOldJobs(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const jobs = this.store.get('jobs')
    const now = Date.now()
    let removed = 0

    for (const [id, job] of Object.entries(jobs)) {
      if (job.status === 'completed' || job.status === 'failed') {
        const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0
        if (now - completedAt > maxAgeMs) {
          delete jobs[id]
          removed++
        }
      }
    }

    if (removed > 0) {
      this.store.set('jobs', jobs)
      this.store.set('lastUpdated', new Date().toISOString())
    }

    return removed
  }

  /**
   * Clear all jobs
   */
  clearAll(): void {
    this.store.set('jobs', {})
    this.store.set('lastUpdated', new Date().toISOString())
  }

  /**
   * Get the file path of the queue store
   */
  getPath(): string {
    return this.store.path
  }
}
