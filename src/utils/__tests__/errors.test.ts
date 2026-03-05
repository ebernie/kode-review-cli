import { describe, it, expect } from 'vitest'
import {
  AppError,
  wrapError,
  formatError,
  categorizeError,
  getCategoryLabel,
  type ErrorCategory,
} from '../errors.js'

describe('AppError', () => {
  it('creates error with category', () => {
    const error = new AppError('Something went wrong', { category: 'network' })
    expect(error.message).toBe('Something went wrong')
    expect(error.category).toBe('network')
    expect(error.name).toBe('AppError')
  })

  it('creates error with cause', () => {
    const cause = new Error('Original error')
    const error = new AppError('Wrapped error', { category: 'network', cause })
    expect(error.cause).toBe(cause)
  })

  it('creates error with recovery hint', () => {
    const error = new AppError('Config missing', {
      category: 'config',
      recoveryHint: 'Run setup to create config',
    })
    expect(error.recoveryHint).toBe('Run setup to create config')
  })

  it('toJSON returns structured object', () => {
    const cause = new Error('Original error')
    const error = new AppError('Wrapped error', {
      category: 'network',
      cause,
      recoveryHint: 'Try again',
    })

    const json = error.toJSON()
    expect(json).toEqual({
      name: 'AppError',
      message: 'Wrapped error',
      category: 'network',
      recoveryHint: 'Try again',
      cause: 'Original error',
    })
  })
})

describe('categorizeError', () => {
  it('returns unknown for null', () => {
    expect(categorizeError(null)).toBe('unknown')
  })

  it('returns unknown for undefined', () => {
    expect(categorizeError(undefined)).toBe('unknown')
  })

  describe('network errors', () => {
    it('categorizes ECONNREFUSED as network', () => {
      const error = new Error('Connection refused') as NodeJS.ErrnoException
      error.code = 'ECONNREFUSED'
      expect(categorizeError(error)).toBe('network')
    })

    it('categorizes ECONNRESET as network', () => {
      const error = new Error('Connection reset') as NodeJS.ErrnoException
      error.code = 'ECONNRESET'
      expect(categorizeError(error)).toBe('network')
    })

    it('categorizes ETIMEDOUT as network', () => {
      const error = new Error('Connection timed out') as NodeJS.ErrnoException
      error.code = 'ETIMEDOUT'
      expect(categorizeError(error)).toBe('network')
    })

    it('categorizes fetch errors as network', () => {
      const error = new Error('fetch failed')
      expect(categorizeError(error)).toBe('network')
    })

    it('categorizes connection errors as network', () => {
      const error = new Error('connection interrupted')
      expect(categorizeError(error)).toBe('network')
    })

    it('categorizes timeout errors as network', () => {
      const error = new Error('Request timeout')
      expect(categorizeError(error)).toBe('network')
    })
  })

  describe('config errors', () => {
    it('categorizes ENOENT as config', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      expect(categorizeError(error)).toBe('config')
    })

    it('categorizes EACCES as config', () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      expect(categorizeError(error)).toBe('config')
    })

    it('categorizes configuration errors as config', () => {
      const error = new Error('Invalid configuration value')
      expect(categorizeError(error)).toBe('config')
    })
  })

  describe('vcs errors', () => {
    it('categorizes GitHub errors as vcs', () => {
      const error = new Error('GitHub API returned 404')
      expect(categorizeError(error)).toBe('vcs')
    })

    it('categorizes GitLab errors as vcs', () => {
      const error = new Error('GitLab MR not found')
      expect(categorizeError(error)).toBe('vcs')
    })

    it('categorizes gh command errors as vcs', () => {
      const error = new Error('gh auth login failed')
      expect(categorizeError(error)).toBe('vcs')
    })

    it('categorizes glab command errors as vcs', () => {
      const error = new Error('glab auth status check failed')
      expect(categorizeError(error)).toBe('vcs')
    })

    it('categorizes PR errors as vcs', () => {
      const error = new Error('Could not find PR #123')
      expect(categorizeError(error)).toBe('vcs')
    })

    it('categorizes MR errors as vcs', () => {
      const error = new Error('Could not find MR !456')
      expect(categorizeError(error)).toBe('vcs')
    })
  })

  describe('indexer errors', () => {
    it('categorizes docker errors as indexer', () => {
      const error = new Error('Docker daemon not running')
      expect(categorizeError(error)).toBe('indexer')
    })

    it('categorizes container errors as indexer', () => {
      const error = new Error('Container failed to start')
      expect(categorizeError(error)).toBe('indexer')
    })

    it('categorizes indexer errors as indexer', () => {
      const error = new Error('Indexer health check failed')
      expect(categorizeError(error)).toBe('indexer')
    })
  })

  describe('review errors', () => {
    it('categorizes diff errors as review', () => {
      const error = new Error('Failed to get diff')
      expect(categorizeError(error)).toBe('review')
    })

    it('categorizes model errors as review', () => {
      const error = new Error('Model not available')
      expect(categorizeError(error)).toBe('review')
    })

    it('categorizes API key errors as review', () => {
      const error = new Error('Invalid API key')
      expect(categorizeError(error)).toBe('review')
    })

    it('categorizes rate limit errors as review', () => {
      const error = new Error('Rate limit exceeded')
      expect(categorizeError(error)).toBe('review')
    })
  })

  it('returns unknown for unrecognized errors', () => {
    const error = new Error('Something unexpected happened')
    expect(categorizeError(error)).toBe('unknown')
  })
})

describe('wrapError', () => {
  it('returns AppError unchanged', () => {
    const appError = new AppError('Test', { category: 'network' })
    const result = wrapError(appError)
    expect(result).toBe(appError)
  })

  it('adds context to AppError when provided', () => {
    const appError = new AppError('Original message', { category: 'network' })
    const result = wrapError(appError, undefined, 'Context')
    expect(result.message).toBe('Context: Original message')
    expect(result.category).toBe('network')
  })

  it('wraps Error with auto-detected category', () => {
    const error = new Error('fetch failed')
    const result = wrapError(error)
    expect(result).toBeInstanceOf(AppError)
    expect(result.message).toBe('fetch failed')
    expect(result.category).toBe('network')
    expect(result.cause).toBe(error)
  })

  it('wraps Error with explicit category', () => {
    const error = new Error('Something went wrong')
    const result = wrapError(error, 'config')
    expect(result.category).toBe('config')
  })

  it('wraps string errors', () => {
    const result = wrapError('String error')
    expect(result.message).toBe('String error')
    expect(result.category).toBe('unknown')
    expect(result.cause).toBeUndefined()
  })

  it('adds context to wrapped error', () => {
    const error = new Error('Original')
    const result = wrapError(error, 'network', 'Additional context')
    expect(result.message).toBe('Additional context: Original')
  })

  it('provides recovery hint based on error', () => {
    const error = new Error('ECONNREFUSED') as NodeJS.ErrnoException
    error.code = 'ECONNREFUSED'
    const result = wrapError(error)
    expect(result.recoveryHint).toBeDefined()
  })
})

describe('formatError', () => {
  it('formats basic error message', () => {
    const error = new Error('Simple error')
    const result = formatError(error)
    expect(result).toBe('Simple error')
  })

  it('formats AppError with recovery hint', () => {
    const error = new AppError('Config missing', {
      category: 'config',
      recoveryHint: 'Run setup command',
    })
    const result = formatError(error)
    expect(result).toContain('Config missing')
    expect(result).toContain('Hint: Run setup command')
  })

  it('includes stack trace in verbose mode', () => {
    const error = new Error('Error with stack')
    const result = formatError(error, true)
    expect(result).toContain('Error with stack')
    expect(result).toContain('Stack trace:')
  })

  it('includes cause stack trace in verbose mode for AppError', () => {
    const cause = new Error('Root cause')
    const error = new AppError('Wrapped', { category: 'network', cause })
    const result = formatError(error, true)
    expect(result).toContain('Caused by:')
    expect(result).toContain('Root cause')
  })
})

describe('getCategoryLabel', () => {
  const categories: ErrorCategory[] = ['config', 'network', 'vcs', 'indexer', 'review', 'update', 'unknown']

  it('returns human-readable labels for all categories', () => {
    for (const category of categories) {
      const label = getCategoryLabel(category)
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('returns specific labels', () => {
    expect(getCategoryLabel('config')).toBe('Configuration Error')
    expect(getCategoryLabel('network')).toBe('Network Error')
    expect(getCategoryLabel('vcs')).toBe('VCS Error')
    expect(getCategoryLabel('indexer')).toBe('Indexer Error')
    expect(getCategoryLabel('review')).toBe('Review Error')
    expect(getCategoryLabel('update')).toBe('Update Error')
    expect(getCategoryLabel('unknown')).toBe('Error')
  })
})
