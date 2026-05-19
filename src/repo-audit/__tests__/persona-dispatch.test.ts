/**
 * Tests for persona-dispatch.ts — trust-boundary + kind drive persona pick.
 *
 * Tests are scenario-driven: each test names a realistic feature shape and
 * asserts the expected persona set, including order.
 */
import { describe, expect, it } from 'vitest'
import { resolvePersonasWithOverride, selectPersonas } from '../persona-dispatch.js'
import type { FeatureRecord, TrustBoundary } from '../types.js'

function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: 'pkg-foo',
    title: 'foo',
    summary: 's',
    kind: 'unknown',
    source: 'heuristic',
    confidence: 'high',
    entrypoints: [],
    ownedFiles: [],
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: 'pending',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

describe('selectPersonas', () => {
  it('returns ["general"] for an internal helper feature with no boundaries and no tests', () => {
    expect(selectPersonas(makeFeature())).toEqual(['general'])
  })

  it('adds architect for library kinds', () => {
    const result = selectPersonas(makeFeature({ kind: 'library' }))
    expect(result).toEqual(['general', 'architect'])
  })

  it('adds architect for service kinds', () => {
    const result = selectPersonas(makeFeature({ kind: 'service' }))
    expect(result).toEqual(['general', 'architect'])
  })

  it('adds security when user-input boundary is present', () => {
    const result = selectPersonas(
      makeFeature({ trustBoundaries: ['user-input' as TrustBoundary] }),
    )
    expect(result).toContain('security')
    expect(result).toContain('general')
  })

  it('adds security when network boundary is present', () => {
    const result = selectPersonas(
      makeFeature({ trustBoundaries: ['network' as TrustBoundary] }),
    )
    expect(result).toContain('security')
  })

  it('adds security for each high-risk boundary individually', () => {
    const surfaces: TrustBoundary[] = [
      'user-input',
      'network',
      'serialization',
      'external-api',
      'auth',
      'permissions',
      'secrets',
    ]
    for (const b of surfaces) {
      const result = selectPersonas(makeFeature({ trustBoundaries: [b] }))
      expect(result, `surface ${b} should trigger security`).toContain('security')
    }
  })

  it('does NOT add security for low-risk boundaries (filesystem, database, etc.)', () => {
    const lowRisk: TrustBoundary[] = ['filesystem', 'database', 'process-exec', 'concurrency']
    for (const b of lowRisk) {
      const result = selectPersonas(makeFeature({ trustBoundaries: [b] }))
      expect(result, `boundary ${b} should not trigger security`).not.toContain('security')
    }
  })

  it('adds test-auditor when feature.kind is test-suite', () => {
    const result = selectPersonas(makeFeature({ kind: 'test-suite' }))
    expect(result).toContain('test-auditor')
  })

  it('adds test-auditor when tests are attached even on non-test-suite kind', () => {
    const result = selectPersonas(
      makeFeature({
        kind: 'library',
        tests: [{ path: 'src/foo.test.ts', command: null }],
      }),
    )
    expect(result).toContain('test-auditor')
  })

  it('NEVER auto-includes doc-reviewer', () => {
    // Try every combination that triggers all other personas.
    const result = selectPersonas(
      makeFeature({
        kind: 'service',
        trustBoundaries: ['user-input', 'network', 'auth'],
        tests: [{ path: 't.test.ts', command: null }],
      }),
    )
    expect(result).not.toContain('doc-reviewer')
  })

  it('returns personas in stable order: general → architect → security → test-auditor', () => {
    const result = selectPersonas(
      makeFeature({
        kind: 'service',
        trustBoundaries: ['user-input'],
        tests: [{ path: 't.test.ts', command: null }],
      }),
    )
    expect(result).toEqual(['general', 'architect', 'security', 'test-auditor'])
  })

  it('does not duplicate personas when multiple triggers overlap', () => {
    const result = selectPersonas(
      makeFeature({
        kind: 'test-suite',
        tests: [{ path: 't.test.ts', command: null }],
      }),
    )
    // test-suite kind AND tests > 0 — but test-auditor must appear once.
    const counts = new Map<string, number>()
    for (const p of result) counts.set(p, (counts.get(p) ?? 0) + 1)
    for (const [k, v] of counts) {
      expect(v, `persona ${k} duplicated`).toBe(1)
    }
  })
})

describe('resolvePersonasWithOverride', () => {
  it('uses auto-dispatch when override is empty', () => {
    const result = resolvePersonasWithOverride(
      makeFeature({ kind: 'service' }),
      [],
    )
    expect(result).toEqual(['general', 'architect'])
  })

  it('uses override verbatim when provided', () => {
    const result = resolvePersonasWithOverride(
      makeFeature({ kind: 'service', trustBoundaries: ['user-input'] }),
      ['doc-reviewer'],
    )
    expect(result).toEqual(['doc-reviewer'])
  })

  it('deduplicates override names while preserving first occurrence order', () => {
    const result = resolvePersonasWithOverride(
      makeFeature(),
      ['security', 'general', 'security', 'architect'],
    )
    expect(result).toEqual(['security', 'general', 'architect'])
  })
})
