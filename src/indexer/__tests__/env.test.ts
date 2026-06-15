import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config/index.js', () => ({
  getConfigPath: vi.fn(() => '/tmp/kode-review-test-config.json'),
  getConfig: vi.fn(() => ({
    indexer: {
      apiPort: 9001,
      dbPort: 9002,
      embeddingModel: 'test-model',
    },
  })),
}))

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}))

import {
  INDEXER_ENV_FILE,
  buildIndexerDatabaseUrl,
  ensureIndexerEnv,
  parseEnvContent,
  readIndexerApiSecret,
  readIndexerDbPassword,
} from '../env.js'
import { logger } from '../../utils/logger.js'

describe('indexer env', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kr-indexer-env-'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('parses simple env files and ignores comments', () => {
    expect(parseEnvContent('\n# comment\nA=one\nB = two\nBROKEN\n')).toEqual({
      A: 'one',
      B: 'two',
    })
  })

  it('generates and persists a random DB password and API secret for new installs', () => {
    const otherTempDir = mkdtempSync(join(tmpdir(), 'kr-indexer-env-'))
    const env = ensureIndexerEnv(tempDir)
    const otherEnv = ensureIndexerEnv(otherTempDir)
    const content = readFileSync(join(tempDir, INDEXER_ENV_FILE), 'utf-8')
    const parsed = parseEnvContent(content)

    try {
      expect(env.apiPort).toBe(9001)
      expect(env.dbPort).toBe(9002)
      expect(env.embeddingModel).toBe('test-model')
      expect(env.dbPassword).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(env.apiSecret).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(env.dbPassword).toHaveLength(43)
      expect(env.apiSecret).toHaveLength(43)
      expect(env.dbPassword).not.toBe('cocoindex')
      expect(env.apiSecret).not.toBe('cocoindex')
      expect(otherEnv.dbPassword).not.toBe(env.dbPassword)
      expect(otherEnv.apiSecret).not.toBe(env.apiSecret)
      expect(parsed.KODE_REVIEW_DB_PASSWORD).toBe(env.dbPassword)
      expect(parsed.COCOINDEX_DATABASE_URL).toBe(buildIndexerDatabaseUrl(env.dbPassword))
      expect(parsed.KODE_REVIEW_INDEXER_API_SECRET).toBe(env.apiSecret)
      expect(readIndexerDbPassword(tempDir)).toBe(env.dbPassword)
      expect(readIndexerApiSecret(tempDir)).toBe(env.apiSecret)
      expect(env.credentialsUpgraded).toBe(true)
    } finally {
      rmSync(otherTempDir, { recursive: true, force: true })
    }
  })

  it('preserves existing generated secrets when rewriting ports and model', () => {
    writeFileSync(
      join(tempDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
        'KODE_REVIEW_DB_PASSWORD=existing-password',
        `COCOINDEX_DATABASE_URL=${buildIndexerDatabaseUrl('existing-password')}`,
        'KODE_REVIEW_INDEXER_API_SECRET=existing-secret',
      ].join('\n') + '\n'
    )

    const env = ensureIndexerEnv(tempDir)
    const parsed = parseEnvContent(readFileSync(join(tempDir, INDEXER_ENV_FILE), 'utf-8'))

    expect(env.apiPort).toBe(9001)
    expect(env.dbPort).toBe(9002)
    expect(env.embeddingModel).toBe('test-model')
    expect(env.dbPassword).toBe('existing-password')
    expect(env.apiSecret).toBe('existing-secret')
    expect(env.credentialsUpgraded).toBe(false)
    expect(parsed.KODE_REVIEW_DB_PASSWORD).toBe('existing-password')
    expect(parsed.COCOINDEX_DATABASE_URL).toBe(buildIndexerDatabaseUrl('existing-password'))
    expect(parsed.KODE_REVIEW_INDEXER_API_SECRET).toBe('existing-secret')
  })

  it('keeps legacy DB credentials for existing installs that lack new secret fields', () => {
    writeFileSync(
      join(tempDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
      ].join('\n') + '\n'
    )

    const env = ensureIndexerEnv(tempDir)

    expect(env.dbPassword).toBe('cocoindex')
    expect(env.apiSecret).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(env.credentialsUpgraded).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      'Existing indexer .env has no KODE_REVIEW_DB_PASSWORD; preserving the legacy database password. Run --index-reset to rotate credentials.',
    )
  })

  it('treats blank credential values as missing', () => {
    writeFileSync(
      join(tempDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
        'KODE_REVIEW_DB_PASSWORD=',
        'KODE_REVIEW_INDEXER_API_SECRET=   ',
      ].join('\n') + '\n'
    )

    const env = ensureIndexerEnv(tempDir)
    const parsed = parseEnvContent(readFileSync(join(tempDir, INDEXER_ENV_FILE), 'utf-8'))

    expect(env.dbPassword).toHaveLength(43)
    expect(env.dbPassword).not.toBe('cocoindex')
    expect(env.apiSecret).toHaveLength(43)
    expect(env.credentialsUpgraded).toBe(true)
    expect(parsed.KODE_REVIEW_DB_PASSWORD).toBe(env.dbPassword)
    expect(parsed.COCOINDEX_DATABASE_URL).toBe(buildIndexerDatabaseUrl(env.dbPassword))
    expect(parsed.KODE_REVIEW_INDEXER_API_SECRET).toBe(env.apiSecret)
  })

  it('encodes DB passwords for direct Docker helper URLs', () => {
    expect(buildIndexerDatabaseUrl('p@ss word')).toBe('postgresql://cocoindex:p%40ss%20word@db:5432/cocoindex')
  })
})
