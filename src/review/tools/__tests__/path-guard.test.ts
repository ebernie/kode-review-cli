import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertWithinRepo } from '../path-guard.js'

const REPO = join(tmpdir(), 'kode-review-path-guard-root')

describe('assertWithinRepo', () => {
  it('returns the normalized relative path for a valid in-repo file', () => {
    expect(assertWithinRepo(REPO, 'src/a.ts')).toBe(join('src', 'a.ts'))
  })

  it('rejects ../ traversal', () => {
    expect(() => assertWithinRepo(REPO, '../etc/passwd')).toThrow(/Path traversal/)
  })

  it('rejects deeply nested ../ traversal', () => {
    expect(() => assertWithinRepo(REPO, 'a/../../../../etc/shadow')).toThrow(/Path traversal/)
  })

  it('rejects absolute paths outside repo', () => {
    expect(() => assertWithinRepo(REPO, '/etc/passwd')).toThrow(/Path traversal/)
  })

  it('accepts absolute paths that resolve inside repo', () => {
    expect(assertWithinRepo(REPO, join(REPO, 'src/a.ts'))).toBe(join('src', 'a.ts'))
  })

  it('rejects empty or non-string input', () => {
    expect(() => assertWithinRepo(REPO, '')).toThrow(/Path is required/)
    expect(() => assertWithinRepo(REPO, undefined as unknown as string)).toThrow(/Path is required/)
  })
})
