import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigPath, getConfig } from '../config/index.js'
import { logger } from '../utils/logger.js'

const LEGACY_DB_PASSWORD = 'cocoindex'

export const INDEXER_API_SECRET_HEADER = 'x-kode-review-indexer-secret'
export const INDEXER_ENV_FILE = '.env'

export interface IndexerEnv {
  apiPort: number
  dbPort: number
  embeddingModel: string
  dbPassword: string
  apiSecret: string
  credentialsUpgraded: boolean
}

export function getIndexerConfigDir(): string {
  const configPath = getConfigPath()
  const configDir = dirname(configPath)
  const indexerDir = join(configDir, 'indexer')

  if (!existsSync(indexerDir)) {
    mkdirSync(indexerDir, { recursive: true })
  }

  return indexerDir
}

export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function readExistingEnv(configDir: string): Record<string, string> {
  const envPath = join(configDir, INDEXER_ENV_FILE)
  if (!existsSync(envPath)) return {}
  return parseEnvContent(readFileSync(envPath, 'utf-8'))
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function buildIndexerDatabaseUrl(dbPassword: string): string {
  return `postgresql://cocoindex:${encodeURIComponent(dbPassword)}@db:5432/cocoindex`
}

export function ensureIndexerEnv(configDir: string = getIndexerConfigDir()): IndexerEnv {
  const config = getConfig()
  const envPath = join(configDir, INDEXER_ENV_FILE)
  const hasExistingEnv = existsSync(envPath)
  const existing = readExistingEnv(configDir)
  const existingDbPassword = nonBlank(existing.KODE_REVIEW_DB_PASSWORD)
  const existingApiSecret = nonBlank(existing.KODE_REVIEW_INDEXER_API_SECRET)
  const hasDbPasswordKey = Object.prototype.hasOwnProperty.call(existing, 'KODE_REVIEW_DB_PASSWORD')

  const dbPassword = existingDbPassword ?? (hasExistingEnv && !hasDbPasswordKey ? LEGACY_DB_PASSWORD : randomSecret())
  const apiSecret = existingApiSecret ?? randomSecret()
  const databaseUrl = buildIndexerDatabaseUrl(dbPassword)
  const credentialsUpgraded =
    existingDbPassword !== dbPassword ||
    existingApiSecret !== apiSecret ||
    nonBlank(existing.COCOINDEX_DATABASE_URL) !== databaseUrl

  if (!existingDbPassword && hasExistingEnv && !hasDbPasswordKey) {
    logger.warn(
      'Existing indexer .env has no KODE_REVIEW_DB_PASSWORD; preserving the legacy database password. Run --index-reset to rotate credentials.',
    )
  } else if (!existingDbPassword && hasExistingEnv) {
    logger.warn(
      'Existing indexer .env has a blank KODE_REVIEW_DB_PASSWORD; generated a new database password. Run --index-reset if the existing Postgres volume was initialized with another password.',
    )
  }

  const env: IndexerEnv = {
    apiPort: config.indexer.apiPort,
    dbPort: config.indexer.dbPort,
    embeddingModel: config.indexer.embeddingModel,
    dbPassword,
    apiSecret,
    credentialsUpgraded,
  }

  const envContent = [
    `KODE_REVIEW_API_PORT=${env.apiPort}`,
    `KODE_REVIEW_DB_PORT=${env.dbPort}`,
    `KODE_REVIEW_EMBEDDING_MODEL=${env.embeddingModel}`,
    `KODE_REVIEW_DB_PASSWORD=${env.dbPassword}`,
    `COCOINDEX_DATABASE_URL=${databaseUrl}`,
    `KODE_REVIEW_INDEXER_API_SECRET=${env.apiSecret}`,
  ].join('\n') + '\n'

  writeFileSync(envPath, envContent, { mode: 0o600 })
  chmodSync(envPath, 0o600)
  return env
}

export function readIndexerApiSecret(configDir: string = getIndexerConfigDir()): string | undefined {
  const env = readExistingEnv(configDir)
  return nonBlank(env.KODE_REVIEW_INDEXER_API_SECRET)
}

export function readIndexerDbPassword(configDir: string = getIndexerConfigDir()): string {
  const env = readExistingEnv(configDir)
  return nonBlank(env.KODE_REVIEW_DB_PASSWORD) ?? LEGACY_DB_PASSWORD
}
