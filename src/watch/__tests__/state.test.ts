import { describe, it, expect, beforeEach } from 'vitest'
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
  let mgr: WatchStateManager

  beforeEach(() => {
    mgr = new WatchStateManager('kode-review-watch-test-' + Math.random().toString(36).slice(2))
    mgr.clear()
  })

  it('persists headRef and findings when marking reviewed', () => {
    mgr.markReviewed({
      key: 'github:o/r:1',
      success: true,
      reviewedAt: new Date().toISOString(),
      headRef: 'abc123',
      findings: [finding],
    })
    const out = mgr.getOutcome('github:o/r:1')
    expect(out?.headRef).toBe('abc123')
    expect(out?.findings).toHaveLength(1)
  })

  it('reads back outcomes without headRef/findings (back-compat)', () => {
    mgr.markReviewed({
      key: 'github:o/r:2',
      success: true,
      reviewedAt: new Date().toISOString(),
    })
    const out = mgr.getOutcome('github:o/r:2')
    expect(out?.headRef).toBeUndefined()
    expect(out?.findings).toBeUndefined()
  })
})
