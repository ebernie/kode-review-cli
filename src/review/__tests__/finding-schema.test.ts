import { describe, it, expect } from 'vitest'
import {
  FindingSchema,
  FindingsBlockSchema,
  type Finding,
  SEVERITIES,
  CATEGORIES,
  CONFIDENCES,
} from '../finding-schema.js'

describe('FindingSchema', () => {
  const valid: Finding = {
    severity: 'HIGH',
    category: 'security',
    confidence: 'HIGH',
    title: 'SQL injection in user query',
    file: 'src/db/users.ts',
    lineStart: 42,
    lineEnd: 48,
    evidence: 'const q = `SELECT * FROM users WHERE id = ${id}`',
    problem: 'Untrusted input concatenated into a SQL string.',
    recommendation: 'Use a parameterised query.',
  }

  it('accepts a fully-populated finding', () => {
    expect(FindingSchema.parse(valid)).toEqual(valid)
  })

  it('rejects missing evidence', () => {
    const bad: any = { ...valid }
    delete bad.evidence
    expect(() => FindingSchema.parse(bad)).toThrow()
  })

  it('rejects empty evidence string', () => {
    expect(() => FindingSchema.parse({ ...valid, evidence: '   ' })).toThrow()
  })

  it('rejects unknown severity', () => {
    expect(() => FindingSchema.parse({ ...valid, severity: 'NIT' })).toThrow()
  })

  it('rejects unknown category', () => {
    expect(() => FindingSchema.parse({ ...valid, category: 'vibes' })).toThrow()
  })

  it('rejects lineEnd before lineStart', () => {
    expect(() => FindingSchema.parse({ ...valid, lineStart: 50, lineEnd: 42 })).toThrow()
  })

  it('rejects non-positive line numbers', () => {
    expect(() => FindingSchema.parse({ ...valid, lineStart: 0 })).toThrow()
  })

  it('exposes the canonical severity/category/confidence sets', () => {
    expect(SEVERITIES).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
    expect(CATEGORIES).toContain('security')
    expect(CATEGORIES).toContain('correctness')
    expect(CONFIDENCES).toEqual(['HIGH', 'MEDIUM', 'LOW'])
  })

  it('FindingsBlockSchema parses an array', () => {
    const parsed = FindingsBlockSchema.parse({ findings: [valid] })
    expect(parsed.findings).toHaveLength(1)
  })

  it('FindingsBlockSchema accepts empty findings list', () => {
    expect(FindingsBlockSchema.parse({ findings: [] }).findings).toEqual([])
  })
})
