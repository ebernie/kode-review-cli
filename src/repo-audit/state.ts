/**
 * Local state for `--scope repo`: lives in `.kode-review/` at the repo root.
 *
 * Directory layout:
 *   .kode-review/
 *     findings/<findingId>.json       — RepoFindingRecord
 *     locks/<featureId>.lock          — acquired during review of a feature
 *     run-history.jsonl               — append-only audit log
 *
 * All writes are temp-write-rename for crash safety: if the process is killed
 * mid-write, a partial file is never observed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { logger } from '../utils/logger.js'
import { RepoFindingRecordSchema, type RepoFindingRecord } from './types.js'

export const STATE_DIR_NAME = '.kode-review'
export const FINDINGS_DIR = 'findings'
export const LOCKS_DIR = 'locks'
export const RUN_HISTORY_FILE = 'run-history.jsonl'

export function stateDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR_NAME)
}

export function findingsDir(repoRoot: string): string {
  return join(stateDir(repoRoot), FINDINGS_DIR)
}

export function locksDir(repoRoot: string): string {
  return join(stateDir(repoRoot), LOCKS_DIR)
}

/** Idempotent: ensures `.kode-review/{findings,locks}` exist. */
export async function ensureStateDirs(repoRoot: string): Promise<void> {
  await mkdir(findingsDir(repoRoot), { recursive: true })
  await mkdir(locksDir(repoRoot), { recursive: true })
}

/** Wipe all persistent state. Used by tests and reset. */
export async function resetState(repoRoot: string): Promise<void> {
  await rm(stateDir(repoRoot), { recursive: true, force: true })
}

/**
 * Stable id for a finding so re-runs don't produce duplicates. Derived from
 * the immutable evidence locator (feature + file + line + title).
 *
 * 24 hex chars (96 bits). LLM-generated titles cluster around common phrasings
 * ("Hardcoded secret", "Missing input validation"), shrinking the effective
 * collision space; 96 bits leaves a comfortable margin at any realistic scale.
 */
export function computeFindingId(
  featureId: string,
  file: string,
  lineStart: number,
  title: string,
): string {
  const h = createHash('sha1')
  h.update(featureId)
  h.update('\0')
  h.update(file)
  h.update('\0')
  h.update(String(lineStart))
  h.update('\0')
  h.update(title)
  return h.digest('hex').slice(0, 24)
}

/** Temp-write-rename so partial writes are never observed on disk. */
async function atomicWriteJson(path: string, payload: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`
  const body = JSON.stringify(payload, null, 2) + '\n'
  await writeFile(tmp, body, 'utf-8')
  await rename(tmp, path)
}

export async function writeFinding(
  repoRoot: string,
  record: RepoFindingRecord,
): Promise<string> {
  await ensureStateDirs(repoRoot)
  const path = join(findingsDir(repoRoot), `${record.findingId}.json`)
  await atomicWriteJson(path, record)
  return path
}

export async function readFinding(
  repoRoot: string,
  findingId: string,
): Promise<RepoFindingRecord | null> {
  const path = join(findingsDir(repoRoot), `${findingId}.json`)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return RepoFindingRecordSchema.parse(JSON.parse(raw))
}

export async function listFindings(repoRoot: string): Promise<RepoFindingRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(findingsDir(repoRoot))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: RepoFindingRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(findingsDir(repoRoot), entry)
    try {
      const raw = await readFile(path, 'utf-8')
      records.push(RepoFindingRecordSchema.parse(JSON.parse(raw)))
    } catch (err) {
      logger.warn(`Skipping malformed finding record at ${path}: ${(err as Error).message}`)
    }
  }
  return records
}

/** True if at least one finding exists for the given featureId. */
export async function hasFindingsForFeature(
  repoRoot: string,
  featureId: string,
): Promise<boolean> {
  const all = await listFindings(repoRoot)
  return all.some((r) => r.featureId === featureId)
}

// ── Lock management ──────────────────────────────────────────────────────

export interface LockInfo {
  featureId: string
  runId: string
  hostname: string
  pid: number
  acquiredAt: string
}

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000 // 30 min: longer than any plausible review

function lockStaleMs(): number {
  const env = process.env['KODE_REVIEW_LOCK_STALE_MS']
  if (env === undefined) return DEFAULT_LOCK_STALE_MS
  const parsed = parseInt(env, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LOCK_STALE_MS
  return parsed
}

/**
 * Acquire an exclusive lock on a feature. Returns null if another live process
 * holds it, or LockInfo on success.
 *
 * Two-step protocol that closes the TOCTOU window in stale-lock reclamation:
 *   1. Try `writeFile` with `flag: 'wx'` (O_EXCL). If it succeeds, we own it.
 *   2. On EEXIST, stat the existing file. If it's stale (older than
 *      lockStaleMs), atomically `rename` our temp lock over it. rename is
 *      atomic on POSIX even when the target exists, so two concurrent
 *      reclamation attempts cannot both succeed (the loser's temp file is
 *      orphaned but harmless).
 */
export async function acquireFeatureLock(
  repoRoot: string,
  featureId: string,
  runId: string,
): Promise<LockInfo | null> {
  await ensureStateDirs(repoRoot)
  const path = join(locksDir(repoRoot), `${encodeFeatureIdForFs(featureId)}.lock`)
  const info: LockInfo = {
    featureId,
    runId,
    hostname: hostname(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }
  const body = JSON.stringify(info, null, 2)

  // Step 1: try O_EXCL create.
  try {
    await writeFile(path, body, { encoding: 'utf-8', flag: 'wx' })
    return info
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // Step 2: lock exists. Check staleness.
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    // Lock vanished between EEXIST and stat (race with releaseFeatureLock).
    // Retry the wx create exactly once.
    try {
      await writeFile(path, body, { encoding: 'utf-8', flag: 'wx' })
      return info
    } catch {
      return null
    }
  }
  if (Date.now() - mtimeMs < lockStaleMs()) return null

  // Step 3: stale lock — atomic rename-over to reclaim.
  const tmp = `${path}.steal.${process.pid}.${randomUUID().slice(0, 8)}`
  try {
    await writeFile(tmp, body, { encoding: 'utf-8', flag: 'wx' })
    await rename(tmp, path)
    return info
  } catch {
    await unlink(tmp).catch(() => {})
    return null
  }
}

export async function releaseFeatureLock(
  repoRoot: string,
  featureId: string,
): Promise<void> {
  const path = join(locksDir(repoRoot), `${encodeFeatureIdForFs(featureId)}.lock`)
  await unlink(path).catch(() => {})
}

/**
 * Make a feature id safe for use as a filesystem component without losing
 * uniqueness. Strategy: replace each unsafe character with `_`, then append
 * a short hash of the *original* id so distinct inputs cannot collide on the
 * encoded output.
 *
 * Length is bounded so the final filename (including suffix and extension)
 * stays well under common filesystem limits (255 bytes on ext4/APFS). The
 * 8-char hash makes truncation safe — distinct long ids cannot collide on
 * the truncated `safe` prefix.
 */
const MAX_SAFE_PREFIX_LEN = 200
function encodeFeatureIdForFs(featureId: string): string {
  const safe = featureId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MAX_SAFE_PREFIX_LEN)
  const suffix = createHash('sha1').update(featureId).digest('hex').slice(0, 8)
  return `${safe}.${suffix}`
}

// ── Run history ──────────────────────────────────────────────────────────

export interface RunHistoryEntry {
  runId: string
  startedAt: string
  endedAt: string
  engine: 'kode-agent' | 'clawpatch'
  featuresReviewed: number
  findingsEmitted: number
  model?: string
  since?: string
}

export async function appendRunHistory(
  repoRoot: string,
  entry: RunHistoryEntry,
): Promise<void> {
  await ensureStateDirs(repoRoot)
  const path = join(stateDir(repoRoot), RUN_HISTORY_FILE)
  // Append mode: POSIX guarantees atomicity for single write() calls under
  // PIPE_BUF (~4 KiB). A single serialized JSON line easily fits; concurrent
  // appenders will not interleave their lines.
  await writeFile(path, JSON.stringify(entry) + '\n', { encoding: 'utf-8', flag: 'a' })
}

export function newRunId(): string {
  return `run-${Date.now()}-${randomUUID().slice(0, 8)}`
}
