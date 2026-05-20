import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WatchStateManager } from '../state.js'
import type { Finding } from '../../review/finding-schema.js'

const finding: Finding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 't',
  file: 'a.ts',
  lineStart: 1,
  lineEnd: 2,
  evidence: 'e',
  problem: 'p',
  recommendation: 'r',
}

describe('WatchStateManager (extended)', () => {
  // Use a single store name per test so the second-instance read proves
  // we're hitting the same on-disk backing — not the in-memory state of
  // a Conf instance. Clean up at teardown so other test runs aren't
  // polluted.
  let storeName: string
  let mgr: WatchStateManager

  beforeEach(() => {
    storeName = 'kode-review-watch-test-' + Math.random().toString(36).slice(2)
    mgr = new WatchStateManager(storeName)
    mgr.clear()
  })

  afterEach(() => {
    // Best-effort cleanup — clear() drops everything Conf persisted to
    // disk under this projectName so subsequent runs start clean. The
    // try/catch guards against a test that left the store in a state
    // where clear() throws (Conf disk failure, manual mutation, etc.);
    // since the test bodies already verified the contract, swallowing
    // the cleanup error is safer than failing teardown.
    try {
      mgr.clear()
    } catch {
      // Intentional: teardown must not mask the test result.
    }
  })

  it('persists headRef and findings across WatchStateManager instances', () => {
    // Original instance writes the outcome.
    mgr.markReviewed({
      key: 'github:o/r:1',
      success: true,
      reviewedAt: new Date().toISOString(),
      headRef: 'abc123',
      findings: [finding],
    })

    // Drop the original reference and instantiate a fresh manager against
    // the same Conf projectName. If outcomes were only kept in-memory this
    // second read would miss them entirely. The auditor flagged the prior
    // version of this test for asserting only same-instance retrieval.
    const fresh = new WatchStateManager(storeName)
    const out = fresh.getOutcome('github:o/r:1')

    expect(out).toBeDefined()
    expect(out?.key).toBe('github:o/r:1')
    expect(out?.success).toBe(true)
    expect(out?.headRef).toBe('abc123')
    expect(out?.findings).toHaveLength(1)
    expect(out?.findings?.[0]).toMatchObject({
      severity: 'HIGH',
      category: 'security',
      title: 't',
      file: 'a.ts',
    })
    // Pin the cross-instance read to the fresh manager so hasBeenReviewed
    // (the production lookup path used by the watcher) also sees it.
    expect(fresh.hasBeenReviewed('github:o/r:1')).toBe(true)
  })

  it('reads back outcomes without headRef/findings (back-compat) across instances', () => {
    mgr.markReviewed({
      key: 'github:o/r:2',
      success: true,
      reviewedAt: new Date().toISOString(),
    })

    const fresh = new WatchStateManager(storeName)
    const out = fresh.getOutcome('github:o/r:2')
    expect(out).toBeDefined()
    expect(out?.success).toBe(true)
    expect(out?.headRef).toBeUndefined()
    expect(out?.findings).toBeUndefined()
  })
})
