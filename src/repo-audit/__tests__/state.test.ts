/**
 * Tests for src/repo-audit/state.ts — local state under .kode-review/.
 *
 * These exercise the real filesystem under a temp dir (no mocks) because the
 * temp-write-rename atomicity guarantee is the whole point and a mock would
 * defeat the test.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireFeatureLock,
  appendRunHistory,
  computeFindingId,
  ensureStateDirs,
  findingsDir,
  hasFindingsForFeature,
  listFindings,
  locksDir,
  newRunId,
  readFinding,
  releaseFeatureLock,
  resetState,
  stateDir,
  writeFinding,
} from '../state.js'
import { logger } from '../../utils/logger.js'
import type { RepoFindingRecord } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-state-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeRecord(overrides: Partial<RepoFindingRecord> = {}): RepoFindingRecord {
  const base: RepoFindingRecord = {
    schemaVersion: 1,
    findingId: 'abc123',
    featureId: 'feat-1',
    persona: 'general',
    status: 'open',
    finding: {
      severity: 'HIGH',
      category: 'security',
      confidence: 'HIGH',
      title: 'Hardcoded API key',
      file: 'src/auth.ts',
      lineStart: 42,
      lineEnd: 42,
      evidence: 'const apiKey = "sk-abc"',
      problem: 'Secret committed to source.',
      recommendation: 'Move to env var.',
    },
    createdByRunId: 'run-1',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
  }
  return { ...base, ...overrides }
}

describe('state directory layout', () => {
  it('places findings under <root>/.kode-review/findings', () => {
    expect(stateDir(tmp)).toBe(join(tmp, '.kode-review'))
    expect(findingsDir(tmp)).toBe(join(tmp, '.kode-review', 'findings'))
    expect(locksDir(tmp)).toBe(join(tmp, '.kode-review', 'locks'))
  })

  it('ensureStateDirs is idempotent', async () => {
    await ensureStateDirs(tmp)
    await ensureStateDirs(tmp)
    expect(existsSync(findingsDir(tmp))).toBe(true)
    expect(existsSync(locksDir(tmp))).toBe(true)
  })

  it('resetState wipes the directory', async () => {
    await writeFinding(tmp, makeRecord())
    expect(existsSync(stateDir(tmp))).toBe(true)
    await resetState(tmp)
    expect(existsSync(stateDir(tmp))).toBe(false)
  })
})

describe('computeFindingId', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeFindingId('feat-1', 'src/auth.ts', 42, 'Hardcoded key')
    const b = computeFindingId('feat-1', 'src/auth.ts', 42, 'Hardcoded key')
    expect(a).toBe(b)
  })

  it('differs when any input changes', () => {
    const base = computeFindingId('feat-1', 'src/auth.ts', 42, 'Hardcoded key')
    expect(computeFindingId('feat-2', 'src/auth.ts', 42, 'Hardcoded key')).not.toBe(base)
    expect(computeFindingId('feat-1', 'src/other.ts', 42, 'Hardcoded key')).not.toBe(base)
    expect(computeFindingId('feat-1', 'src/auth.ts', 43, 'Hardcoded key')).not.toBe(base)
    expect(computeFindingId('feat-1', 'src/auth.ts', 42, 'Different title')).not.toBe(base)
  })

  it('returns a 24-char hex string (96 bits)', () => {
    const id = computeFindingId('feat-1', 'src/auth.ts', 42, 'X')
    expect(id).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('writeFinding / readFinding round-trip', () => {
  it('writes and reads the same record', async () => {
    const record = makeRecord()
    await writeFinding(tmp, record)
    const back = await readFinding(tmp, record.findingId)
    expect(back).toEqual(record)
  })

  it('returns null for an unknown findingId', async () => {
    expect(await readFinding(tmp, 'nope')).toBeNull()
  })

  it('overwrites an existing finding with the same id', async () => {
    const first = makeRecord({ status: 'open' })
    await writeFinding(tmp, first)
    const second = makeRecord({ status: 'fixed', updatedAt: '2026-05-20T10:00:00.000Z' })
    await writeFinding(tmp, second)
    const back = await readFinding(tmp, first.findingId)
    expect(back?.status).toBe('fixed')
    expect(back?.updatedAt).toBe('2026-05-20T10:00:00.000Z')
  })

  it('parses pre-revalidate records (no lastRevalidatedAt / revalidationVerdict fields)', async () => {
    // Backwards compat: any record written before --revalidate landed must
    // still round-trip cleanly through the schema. We write a JSON blob
    // missing the new fields and verify readFinding deserializes it.
    const record = makeRecord()
    // Serialize WITHOUT the optional fields (they are simply absent in
    // pre-revalidate records on disk).
    await ensureStateDirs(tmp)
    await writeFile(
      join(findingsDir(tmp), `${record.findingId}.json`),
      JSON.stringify({
        schemaVersion: record.schemaVersion,
        findingId: record.findingId,
        featureId: record.featureId,
        persona: record.persona,
        status: record.status,
        finding: record.finding,
        createdByRunId: record.createdByRunId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    )
    const back = await readFinding(tmp, record.findingId)
    expect(back).not.toBeNull()
    expect(back?.lastRevalidatedAt).toBeUndefined()
    expect(back?.revalidationVerdict).toBeUndefined()
    expect(back?.revalidationRunId).toBeUndefined()
  })

  it('round-trips a record with revalidation fields populated', async () => {
    const record = makeRecord({
      status: 'fixed',
      lastRevalidatedAt: '2026-05-20T10:00:00.000Z',
      revalidationVerdict: 'fixed',
      revalidationRunId: 'run-revalidate-1',
    })
    await writeFinding(tmp, record)
    const back = await readFinding(tmp, record.findingId)
    expect(back).toEqual(record)
  })

  it('removes tmp files after a successful write', async () => {
    // The atomic write contract (no observer ever sees a partial file) is
    // not directly assertable in-process without injecting a crash between
    // writeFile and rename. This test verifies the cleanup half: after a
    // successful write, no `.tmp.*` siblings remain.
    await writeFinding(tmp, makeRecord())
    const entries = await readdir(findingsDir(tmp))
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([])
  })

  it('warns and skips malformed JSON files in listFindings rather than throwing', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await writeFinding(tmp, makeRecord({ findingId: 'good' }))
      await writeFile(join(findingsDir(tmp), 'bad.json'), '{ not valid json')
      const all = await listFindings(tmp)
      expect(all).toHaveLength(1)
      expect(all[0]?.findingId).toBe('good')
      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy.mock.calls[0]?.[0]).toContain('bad.json')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('listFindings returns [] when state dir does not exist', async () => {
    const all = await listFindings(tmp)
    expect(all).toEqual([])
  })
})

describe('hasFindingsForFeature', () => {
  it('returns true when at least one finding belongs to the feature', async () => {
    await writeFinding(tmp, makeRecord({ findingId: 'a', featureId: 'feat-1' }))
    await writeFinding(tmp, makeRecord({ findingId: 'b', featureId: 'feat-2' }))
    expect(await hasFindingsForFeature(tmp, 'feat-1')).toBe(true)
    expect(await hasFindingsForFeature(tmp, 'feat-3')).toBe(false)
  })
})

describe('feature locks', () => {
  it('held-lock fast path: sequential second acquisition returns null', async () => {
    const a = await acquireFeatureLock(tmp, 'feat-1', 'run-1')
    expect(a).not.toBeNull()
    const b = await acquireFeatureLock(tmp, 'feat-1', 'run-2')
    expect(b).toBeNull()
  })

  it('concurrent race: exactly one of N parallel acquisitions wins', async () => {
    // The whole point of the O_EXCL `wx` flag is to defend the create race
    // where multiple callers all pass the existence check before any of
    // them writes. Fire several in parallel and assert exactly one wins.
    const racers = Array.from({ length: 8 }, (_, i) =>
      acquireFeatureLock(tmp, 'feat-race', `run-${i}`),
    )
    const results = await Promise.all(racers)
    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
  })

  it('releasing allows re-acquisition', async () => {
    await acquireFeatureLock(tmp, 'feat-1', 'run-1')
    await releaseFeatureLock(tmp, 'feat-1')
    const again = await acquireFeatureLock(tmp, 'feat-1', 'run-2')
    expect(again).not.toBeNull()
  })

  it('locks different features independently', async () => {
    const a = await acquireFeatureLock(tmp, 'feat-1', 'run-1')
    const b = await acquireFeatureLock(tmp, 'feat-2', 'run-1')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  it('does not collide on feature ids that differ only in unsafe characters', async () => {
    // `feat/foo` and `feat_foo` would map to the same encoded filename if we
    // simply replaced unsafe chars; the disambiguating hash suffix prevents
    // the lock from being shared across logically-distinct features.
    const a = await acquireFeatureLock(tmp, 'feat/foo', 'run-1')
    const b = await acquireFeatureLock(tmp, 'feat_foo', 'run-2')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    const entries = await readdir(locksDir(tmp))
    expect(entries).toHaveLength(2)
    for (const e of entries) {
      expect(e).not.toContain('/')
      expect(e).not.toContain(':')
    }
  })

  it('reclaims a stale lock (older than the stale threshold)', async () => {
    process.env['KODE_REVIEW_LOCK_STALE_MS'] = '60000' // 60s threshold
    try {
      const first = await acquireFeatureLock(tmp, 'feat-stale', 'run-1')
      expect(first).not.toBeNull()
      // Backdate the lock file by 2 hours so it falls past the threshold.
      const entries = await readdir(locksDir(tmp))
      const lockPath = join(locksDir(tmp), entries[0]!)
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(lockPath, past, past)
      // Same featureId, different runId — should reclaim and return non-null.
      const reclaimed = await acquireFeatureLock(tmp, 'feat-stale', 'run-2')
      expect(reclaimed).not.toBeNull()
      expect(reclaimed?.runId).toBe('run-2')
    } finally {
      delete process.env['KODE_REVIEW_LOCK_STALE_MS']
    }
  })

  it('records process and run identity in the lock', async () => {
    const info = await acquireFeatureLock(tmp, 'feat-1', 'run-1')
    expect(info?.featureId).toBe('feat-1')
    expect(info?.runId).toBe('run-1')
    expect(info?.pid).toBe(process.pid)
  })
})

describe('run history', () => {
  it('appends entries as newline-delimited JSON', async () => {
    await appendRunHistory(tmp, {
      runId: 'run-1',
      startedAt: '2026-05-19T10:00:00.000Z',
      endedAt: '2026-05-19T10:05:00.000Z',
      engine: 'kode-agent',
      featuresReviewed: 3,
      findingsEmitted: 7,
    })
    await appendRunHistory(tmp, {
      runId: 'run-2',
      startedAt: '2026-05-19T11:00:00.000Z',
      endedAt: '2026-05-19T11:05:00.000Z',
      engine: 'clawpatch',
      featuresReviewed: 0,
      findingsEmitted: 0,
    })
    const raw = await readFile(join(stateDir(tmp), 'run-history.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).runId).toBe('run-1')
    expect(JSON.parse(lines[1]!).engine).toBe('clawpatch')
  })

  it('newRunId yields unique values', () => {
    const ids = new Set(Array.from({ length: 50 }, newRunId))
    expect(ids.size).toBe(50)
  })
})
