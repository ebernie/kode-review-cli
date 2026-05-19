/**
 * Tests for features.ts — reading .clawpatch/features/*.json into
 * FeatureRecord[] with graceful handling of malformed files and schema
 * version drift.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clawpatchFeaturesDir, pendingFeatures, readFeatures } from '../features.js'
import { logger } from '../../utils/logger.js'
import type { FeatureRecord } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-features-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeFeatureJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    featureId: 'pkg-foo',
    title: 'foo',
    summary: 's',
    kind: 'library',
    source: 'heuristic',
    confidence: 'high',
    entrypoints: [],
    ownedFiles: [{ path: 'src/foo.ts', reason: 'source' }],
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: 'pending',
    lock: null,
    findingIds: [],
    patchAttemptIds: [],
    analysisHistory: [],
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

async function writeFeatureFile(name: string, payload: unknown): Promise<void> {
  const dir = clawpatchFeaturesDir(tmp)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify(payload, null, 2))
}

describe('readFeatures', () => {
  it('returns empty arrays when .clawpatch/features/ does not exist', async () => {
    const result = await readFeatures(tmp)
    expect(result.features).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('parses a well-formed feature file', async () => {
    await writeFeatureFile('pkg-foo.json', makeFeatureJson())
    const result = await readFeatures(tmp)
    expect(result.features).toHaveLength(1)
    expect(result.features[0]?.featureId).toBe('pkg-foo')
    expect(result.features[0]?.ownedFiles).toHaveLength(1)
    expect(result.skipped).toEqual([])
  })

  it('parses multiple features and returns them sorted by featureId', async () => {
    await writeFeatureFile('zeta.json', makeFeatureJson({ featureId: 'zeta' }))
    await writeFeatureFile('alpha.json', makeFeatureJson({ featureId: 'alpha' }))
    await writeFeatureFile('mid.json', makeFeatureJson({ featureId: 'mid' }))
    const result = await readFeatures(tmp)
    expect(result.features.map((f) => f.featureId)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('ignores non-.json entries', async () => {
    await writeFeatureFile('pkg-foo.json', makeFeatureJson())
    await mkdir(clawpatchFeaturesDir(tmp), { recursive: true })
    await writeFile(join(clawpatchFeaturesDir(tmp), 'README.md'), '# notes')
    const result = await readFeatures(tmp)
    expect(result.features).toHaveLength(1)
    expect(result.skipped).toEqual([])
  })

  it('skips malformed JSON with a warning, does not abort the run', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await writeFeatureFile('good.json', makeFeatureJson({ featureId: 'good' }))
      await mkdir(clawpatchFeaturesDir(tmp), { recursive: true })
      await writeFile(join(clawpatchFeaturesDir(tmp), 'bad.json'), '{ not valid json')
      const result = await readFeatures(tmp)
      expect(result.features.map((f) => f.featureId)).toEqual(['good'])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toMatch(/invalid JSON/)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('skips records with a schema mismatch (e.g., unknown kind) with a warning', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await writeFeatureFile('bad-kind.json', makeFeatureJson({ kind: 'not-a-real-kind' }))
      const result = await readFeatures(tmp)
      expect(result.features).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('accepts a future schemaVersion but logs a warning about possible drift', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await writeFeatureFile('future.json', makeFeatureJson({ schemaVersion: 2 }))
      const result = await readFeatures(tmp)
      expect(result.features).toHaveLength(1)
      expect(result.features[0]?.schemaVersion).toBe(2)
      // The warning should mention the schemaVersion mismatch.
      const warnings = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(warnings.some((m) => /schemaVersion=2/.test(m))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('rejects schemaVersion=0 (non-positive) outright via the schema', async () => {
    // SUPPORTED_FEATURE_SCHEMA_VERSION = 1 but the schema requires a positive
    // integer. A 0 should be a hard rejection (skipped + warned), not a
    // soft warn-and-accept, because it indicates a malformed record rather
    // than a downgrade.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await writeFeatureFile('zero.json', makeFeatureJson({ schemaVersion: 0 }))
      const result = await readFeatures(tmp)
      expect(result.features).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('returns a stable result on re-read (no in-place mutation)', async () => {
    await writeFeatureFile('a.json', makeFeatureJson({ featureId: 'a' }))
    await writeFeatureFile('b.json', makeFeatureJson({ featureId: 'b' }))
    const r1 = await readFeatures(tmp)
    const r2 = await readFeatures(tmp)
    expect(r1.features.map((f) => f.featureId)).toEqual(r2.features.map((f) => f.featureId))
  })
})

describe('pendingFeatures', () => {
  function makeRec(status: FeatureRecord['status'], id = 'x'): FeatureRecord {
    return {
      schemaVersion: 1,
      featureId: id,
      title: id,
      summary: 's',
      kind: 'library',
      source: 'heuristic',
      confidence: 'high',
      entrypoints: [],
      ownedFiles: [],
      contextFiles: [],
      tests: [],
      tags: [],
      trustBoundaries: [],
      status,
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
  }

  it('keeps features with status "pending"', () => {
    const all = [makeRec('pending', 'a'), makeRec('reviewed', 'b')]
    expect(pendingFeatures(all).map((f) => f.featureId)).toEqual(['a'])
  })

  it('also keeps features with status "error" so transient failures retry', () => {
    const all = [makeRec('pending', 'a'), makeRec('error', 'b'), makeRec('reviewed', 'c')]
    expect(pendingFeatures(all).map((f) => f.featureId).sort()).toEqual(['a', 'b'])
  })

  it('drops every other status', () => {
    const all = [
      makeRec('claimed', 'a'),
      makeRec('reviewed', 'b'),
      makeRec('needs-fix', 'c'),
      makeRec('fixing', 'd'),
      makeRec('fixed', 'e'),
      makeRec('revalidated', 'f'),
      makeRec('skipped', 'g'),
    ]
    expect(pendingFeatures(all)).toEqual([])
  })
})
