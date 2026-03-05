import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IndexingJobQueue } from '../background-queue.js'
import { unlinkSync } from 'fs'

describe('IndexingJobQueue', () => {
  let queue: IndexingJobQueue
  const testStoreName = 'kode-review-test-queue'

  beforeEach(() => {
    queue = new IndexingJobQueue(testStoreName)
    queue.clearAll()
  })

  afterEach(() => {
    queue.clearAll()
    try {
      unlinkSync(queue.getPath())
    } catch {
      // Ignore if file doesn't exist
    }
  })

  describe('enqueue', () => {
    it('should add a job to the queue', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 150,
      })

      expect(job.id).toBeDefined()
      expect(job.repoUrl).toBe('https://github.com/test/repo')
      expect(job.branch).toBe('main')
      expect(job.fileCount).toBe(150)
      expect(job.status).toBe('pending')
      expect(job.priority).toBe('normal')
    })

    it('should set low priority for large file counts', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 150,
        priority: 'low',
      })

      expect(job.priority).toBe('low')
    })
  })

  describe('getNextPending', () => {
    it('should return null when queue is empty', () => {
      const job = queue.getNextPending()
      expect(job).toBeNull()
    })

    it('should return jobs in priority order', () => {
      queue.enqueue({
        repoUrl: 'https://github.com/test/repo1',
        repoPath: '/path/to/repo1',
        branch: 'main',
        fileCount: 100,
        priority: 'low',
      })

      queue.enqueue({
        repoUrl: 'https://github.com/test/repo2',
        repoPath: '/path/to/repo2',
        branch: 'main',
        fileCount: 100,
        priority: 'high',
      })

      queue.enqueue({
        repoUrl: 'https://github.com/test/repo3',
        repoPath: '/path/to/repo3',
        branch: 'main',
        fileCount: 100,
        priority: 'normal',
      })

      const first = queue.getNextPending()
      expect(first?.repoUrl).toBe('https://github.com/test/repo2') // high priority

      queue.markCompleted(first!.id)

      const second = queue.getNextPending()
      expect(second?.repoUrl).toBe('https://github.com/test/repo3') // normal priority
    })
  })

  describe('status updates', () => {
    it('should mark job as processing', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      queue.markProcessing(job.id)

      const updated = queue.getJob(job.id)
      expect(updated?.status).toBe('processing')
      expect(updated?.startedAt).toBeDefined()
    })

    it('should mark job as completed with result', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      queue.markCompleted(job.id, {
        chunksAdded: 50,
        chunksRemoved: 10,
        elapsedSeconds: 5.5,
      })

      const updated = queue.getJob(job.id)
      expect(updated?.status).toBe('completed')
      expect(updated?.completedAt).toBeDefined()
      expect(updated?.result?.chunksAdded).toBe(50)
      expect(updated?.result?.chunksRemoved).toBe(10)
      expect(updated?.result?.elapsedSeconds).toBe(5.5)
    })

    it('should mark job as failed with error', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      queue.markFailed(job.id, 'Docker container crashed')

      const updated = queue.getJob(job.id)
      expect(updated?.status).toBe('failed')
      expect(updated?.error).toBe('Docker container crashed')
    })
  })

  describe('hasExistingJob', () => {
    it('should detect existing pending job', () => {
      queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      expect(queue.hasExistingJob('https://github.com/test/repo', 'main')).toBe(true)
      expect(queue.hasExistingJob('https://github.com/test/repo', 'develop')).toBe(false)
      expect(queue.hasExistingJob('https://github.com/other/repo', 'main')).toBe(false)
    })

    it('should not detect completed jobs', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      queue.markCompleted(job.id)

      expect(queue.hasExistingJob('https://github.com/test/repo', 'main')).toBe(false)
    })
  })

  describe('getAllJobs', () => {
    it('returns all enqueued jobs', () => {
      queue.enqueue({ repoUrl: 'https://github.com/a/repo', repoPath: '/a', branch: 'main', fileCount: 10 })
      queue.enqueue({ repoUrl: 'https://github.com/b/repo', repoPath: '/b', branch: 'main', fileCount: 20 })

      const all = queue.getAllJobs()
      expect(all).toHaveLength(2)
    })

    it('returns empty array when no jobs', () => {
      expect(queue.getAllJobs()).toHaveLength(0)
    })
  })

  describe('getJobsByStatus', () => {
    it('filters jobs by status', () => {
      const job1 = queue.enqueue({ repoUrl: 'https://github.com/a/repo', repoPath: '/a', branch: 'main', fileCount: 10 })
      queue.enqueue({ repoUrl: 'https://github.com/b/repo', repoPath: '/b', branch: 'main', fileCount: 20 })
      queue.markProcessing(job1.id)

      expect(queue.getJobsByStatus('pending')).toHaveLength(1)
      expect(queue.getJobsByStatus('processing')).toHaveLength(1)
      expect(queue.getJobsByStatus('completed')).toHaveLength(0)
    })
  })

  describe('getPendingCount / getProcessingCount', () => {
    it('returns correct counts', () => {
      const job1 = queue.enqueue({ repoUrl: 'https://github.com/a/repo', repoPath: '/a', branch: 'main', fileCount: 10 })
      queue.enqueue({ repoUrl: 'https://github.com/b/repo', repoPath: '/b', branch: 'main', fileCount: 20 })

      expect(queue.getPendingCount()).toBe(2)
      expect(queue.getProcessingCount()).toBe(0)

      queue.markProcessing(job1.id)

      expect(queue.getPendingCount()).toBe(1)
      expect(queue.getProcessingCount()).toBe(1)
    })
  })

  describe('removeJob', () => {
    it('removes a job from the queue', () => {
      const job = queue.enqueue({ repoUrl: 'https://github.com/a/repo', repoPath: '/a', branch: 'main', fileCount: 10 })

      queue.removeJob(job.id)

      expect(queue.getJob(job.id)).toBeNull()
      expect(queue.getAllJobs()).toHaveLength(0)
    })
  })

  describe('cleanup', () => {
    it('should remove old completed jobs', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      // Mark as completed with old timestamp
      queue.updateStatus(job.id, 'completed', {
        completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
      })

      const removed = queue.cleanupOldJobs(24 * 60 * 60 * 1000) // 1 day max age
      expect(removed).toBe(1)
      expect(queue.getJob(job.id)).toBeNull()
    })

    it('should remove old failed jobs', () => {
      const job = queue.enqueue({
        repoUrl: 'https://github.com/test/repo',
        repoPath: '/path/to/repo',
        branch: 'main',
        fileCount: 100,
      })

      queue.updateStatus(job.id, 'failed', {
        completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      })

      const removed = queue.cleanupOldJobs(24 * 60 * 60 * 1000)
      expect(removed).toBe(1)
      expect(queue.getJob(job.id)).toBeNull()
    })
  })
})
