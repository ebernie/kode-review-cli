/**
 * Tests for the FeatureRecord schema — verifies we correctly parse clawpatch's
 * actual JSON output (subset we depend on) and ignore extra fields.
 */
import { describe, expect, it } from 'vitest'
import { FeatureRecordSchema, RepoFindingRecordSchema } from '../types.js'

describe('FeatureRecordSchema parses clawpatch JSON', () => {
  it('accepts a realistic clawpatch feature record', () => {
    const sample = {
      schemaVersion: 1,
      featureId: 'pkg-foo',
      title: 'foo package',
      summary: 'Renders the foo CLI command.',
      kind: 'cli-command',
      source: 'heuristic',
      confidence: 'high',
      entrypoints: [
        { path: 'cmd/foo/main.go', symbol: 'main', route: null, command: 'foo' },
      ],
      ownedFiles: [{ path: 'cmd/foo/main.go', reason: 'package source' }],
      contextFiles: [{ path: 'cmd/foo/foo_test.go', reason: 'tests' }],
      tests: [{ path: 'cmd/foo/foo_test.go', command: 'go test ./cmd/foo' }],
      tags: ['go', 'cli'],
      trustBoundaries: ['user-input', 'filesystem', 'process-exec', 'network'],
      status: 'pending',
      // Fields kode-review doesn't consume but clawpatch always emits:
      lock: null,
      findingIds: [],
      patchAttemptIds: [],
      analysisHistory: [],
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
    const parsed = FeatureRecordSchema.parse(sample)
    expect(parsed.featureId).toBe('pkg-foo')
    expect(parsed.kind).toBe('cli-command')
    expect(parsed.trustBoundaries).toContain('user-input')
    expect(parsed.ownedFiles[0]?.path).toBe('cmd/foo/main.go')
  })

  it('is lenient when optional array fields are missing (forward-compat cushion)', () => {
    // clawpatch currently emits ownedFiles/contextFiles/etc. as required `[]`
    // arrays. The .default([]) on our schema is a deliberate cushion: if a
    // future clawpatch version drops an empty field, we degrade to "no files"
    // rather than abort the whole audit.
    const minimal = {
      schemaVersion: 1,
      featureId: 'pkg-bar',
      title: 'bar',
      summary: 's',
      kind: 'library',
      source: 'heuristic',
      confidence: 'medium',
      status: 'pending',
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
    const parsed = FeatureRecordSchema.parse(minimal)
    expect(parsed.ownedFiles).toEqual([])
    expect(parsed.contextFiles).toEqual([])
    expect(parsed.trustBoundaries).toEqual([])
  })

  it('accepts a future schemaVersion (caller decides whether to skip)', () => {
    // Hard-failing on a schema bump would break the run; let the orchestrator
    // decide whether to skip-with-warning or upgrade. SUPPORTED_FEATURE_SCHEMA_VERSION
    // is exported for that comparison.
    const future = {
      schemaVersion: 2,
      featureId: 'pkg-bar',
      title: 'bar',
      summary: 's',
      kind: 'library',
      source: 'heuristic',
      confidence: 'medium',
      status: 'pending',
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
    const parsed = FeatureRecordSchema.parse(future)
    expect(parsed.schemaVersion).toBe(2)
  })

  it('rejects records with an unknown kind enum value', () => {
    const bad = {
      schemaVersion: 1,
      featureId: 'pkg-foo',
      title: 'foo',
      summary: 's',
      kind: 'not-a-real-kind',
      source: 'heuristic',
      confidence: 'high',
      status: 'pending',
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
    expect(() => FeatureRecordSchema.parse(bad)).toThrow()
  })

  it('rejects records with a non-positive schemaVersion', () => {
    const bad = {
      schemaVersion: 0,
      featureId: 'pkg-foo',
      title: 'foo',
      summary: 's',
      kind: 'library',
      source: 'heuristic',
      confidence: 'high',
      status: 'pending',
      createdAt: '2026-05-18T10:00:00.000Z',
      updatedAt: '2026-05-18T10:00:00.000Z',
    }
    expect(() => FeatureRecordSchema.parse(bad)).toThrow()
  })
})

describe('RepoFindingRecordSchema', () => {
  it('round-trips through JSON', () => {
    const record = {
      schemaVersion: 1 as const,
      findingId: 'abc123',
      featureId: 'pkg-foo',
      persona: 'security',
      status: 'open' as const,
      finding: {
        severity: 'CRITICAL' as const,
        category: 'security' as const,
        confidence: 'HIGH' as const,
        title: 'SQL injection',
        file: 'src/db.ts',
        lineStart: 10,
        lineEnd: 12,
        evidence: 'db.query(`SELECT * FROM users WHERE id = ${userId}`)',
        problem: 'Untrusted input concatenated into SQL.',
        recommendation: 'Use parameterized queries.',
      },
      createdByRunId: 'run-1',
      createdAt: '2026-05-19T10:00:00.000Z',
      updatedAt: '2026-05-19T10:00:00.000Z',
    }
    const json = JSON.parse(JSON.stringify(record))
    const parsed = RepoFindingRecordSchema.parse(json)
    expect(parsed).toEqual(record)
  })

  it('rejects when lineEnd < lineStart (refine on inner FindingSchema)', () => {
    const bad = {
      schemaVersion: 1,
      findingId: 'a',
      featureId: 'f',
      persona: 'general',
      status: 'open',
      finding: {
        severity: 'LOW',
        category: 'other',
        confidence: 'LOW',
        title: 't',
        file: 'f.ts',
        lineStart: 10,
        lineEnd: 5,
        evidence: 'x',
        problem: 'x',
        recommendation: 'x',
      },
      createdByRunId: 'run-1',
      createdAt: '2026-05-19T10:00:00.000Z',
      updatedAt: '2026-05-19T10:00:00.000Z',
    }
    expect(() => RepoFindingRecordSchema.parse(bad)).toThrow()
  })
})
