import { describe, it, expect } from 'vitest'
import { classifyTrustBoundaries, summarizeBoundariesForFiles, TRUST_BOUNDARIES } from '../trust-boundaries.js'

describe('classifyTrustBoundaries', () => {
  it('flags routes and api handlers as network + user-input', () => {
    expect(classifyTrustBoundaries('src/routes/users.ts')).toEqual(
      expect.arrayContaining(['network', 'user-input']),
    )
    expect(classifyTrustBoundaries('app/api/login/route.ts')).toEqual(
      expect.arrayContaining(['network', 'user-input']),
    )
    expect(classifyTrustBoundaries('internal/handlers/webhook.go')).toEqual(
      expect.arrayContaining(['network']),
    )
  })

  it('flags auth/session/crypto as auth + secrets', () => {
    expect(classifyTrustBoundaries('src/auth/session.ts')).toEqual(
      expect.arrayContaining(['auth', 'secrets']),
    )
    expect(classifyTrustBoundaries('lib/crypto/jwt.ts')).toEqual(
      expect.arrayContaining(['secrets']),
    )
  })

  it('flags db/migration/model as database', () => {
    expect(classifyTrustBoundaries('src/db/users.ts')).toEqual(
      expect.arrayContaining(['database']),
    )
    expect(classifyTrustBoundaries('migrations/001_users.sql')).toEqual(
      expect.arrayContaining(['database']),
    )
    expect(classifyTrustBoundaries('app/models/user.rb')).toEqual(
      expect.arrayContaining(['database']),
    )
  })

  it('flags shell/exec/spawn paths as process-exec', () => {
    expect(classifyTrustBoundaries('src/utils/exec.ts')).toEqual(
      expect.arrayContaining(['process-exec']),
    )
  })

  it('flags filesystem helpers as filesystem', () => {
    expect(classifyTrustBoundaries('src/utils/fs.ts')).toEqual(
      expect.arrayContaining(['filesystem']),
    )
  })

  it('returns empty for unremarkable paths', () => {
    expect(classifyTrustBoundaries('src/cli/colors.ts')).toEqual([])
    expect(classifyTrustBoundaries('README.md')).toEqual([])
  })

  it('deduplicates when multiple patterns hit', () => {
    const out = classifyTrustBoundaries('src/auth/db/sessions.ts')
    expect(new Set(out).size).toBe(out.length)
  })

  it('exposes the full boundary set', () => {
    expect(TRUST_BOUNDARIES).toContain('network')
    expect(TRUST_BOUNDARIES).toContain('user-input')
    expect(TRUST_BOUNDARIES).toContain('database')
    expect(TRUST_BOUNDARIES).toContain('secrets')
    expect(TRUST_BOUNDARIES).toContain('auth')
    expect(TRUST_BOUNDARIES).toContain('process-exec')
    expect(TRUST_BOUNDARIES).toContain('filesystem')
    expect(TRUST_BOUNDARIES).toContain('serialization')
    expect(TRUST_BOUNDARIES).toContain('external-api')
  })
})

describe('summarizeBoundariesForFiles', () => {
  it('groups files by boundary', () => {
    const summary = summarizeBoundariesForFiles([
      'src/routes/users.ts',
      'src/auth/session.ts',
      'src/utils/colors.ts',
    ])
    expect(summary.get('network')).toContain('src/routes/users.ts')
    expect(summary.get('auth')).toContain('src/auth/session.ts')
    expect(summary.has('filesystem')).toBe(false)
  })

  it('returns an empty map when no files match', () => {
    expect(summarizeBoundariesForFiles(['README.md']).size).toBe(0)
  })
})
