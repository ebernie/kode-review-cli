import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the registry so the test doesn't depend on the actual filesystem
// contents of the built-in templates dir or the user's ~/.config/.
vi.mock('../../reviewers/registry.js', () => ({
  listAvailableReviewers: vi.fn(),
}))

import { printReviewerList } from '../../index.js'
import { listAvailableReviewers } from '../../reviewers/registry.js'

const FIXTURE_REVIEWERS = [
  { name: 'general', description: 'General-purpose code review', builtin: true, templatePath: '/builtin/general.md' },
  { name: 'security', description: 'Security-focused review', builtin: true, templatePath: '/builtin/security.md' },
  { name: 'myteam', description: 'Custom team reviewer', builtin: false, templatePath: '/home/u/.config/kode-review/reviewers/myteam.md' },
]

describe('printReviewerList', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.mocked(listAvailableReviewers).mockReturnValue(FIXTURE_REVIEWERS)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.clearAllMocks()
  })

  describe('format=json', () => {
    it('emits exactly one console.log call (no human-readable preamble or footer)', () => {
      printReviewerList('json')
      expect(logSpy).toHaveBeenCalledOnce()
      const out = logSpy.mock.calls[0][0]
      expect(typeof out).toBe('string')
      const parsed = JSON.parse(out as string)
      expect(Array.isArray(parsed)).toBe(true)
      // Pretty-printed (2-space indent) — pinned so a switch to compact
      // JSON.stringify breaks this test rather than silently changing the
      // user-visible format.
      expect(out as string).toMatch(/\n {4}"name":/)
    })

    it('serializes every reviewer with name, description, builtin, and templatePath', () => {
      printReviewerList('json')
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
      expect(parsed).toEqual(FIXTURE_REVIEWERS)
    })

    it('preserves input order', () => {
      printReviewerList('json')
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string)
      expect(parsed.map((r: { name: string }) => r.name)).toEqual(['general', 'security', 'myteam'])
    })

    it('emits a valid JSON array even when there are no reviewers', () => {
      vi.mocked(listAvailableReviewers).mockReturnValue([])
      printReviewerList('json')
      expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual([])
    })
  })

  describe('format=text', () => {
    it('prints a header, footer with usage hints, and one line per reviewer', () => {
      printReviewerList('text')
      expect(logSpy.mock.calls.length).toBeGreaterThan(3)
      const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(all).toContain('Available reviewers:')
      expect(all).toContain('general')
      expect(all).toContain('security')
      expect(all).toContain('myteam')
      expect(all).toContain('kode-review --reviewer <name>')
      expect(all).toContain('~/.config/kode-review/reviewers/')
    })

    it('tags built-in vs user reviewers distinctly', () => {
      printReviewerList('text')
      const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(all).toContain('[builtin]')
      expect(all).toContain('[user]')
    })
  })

  describe('format=markdown', () => {
    it('falls through to text rendering (markdown not specifically supported by this helper)', () => {
      printReviewerList('markdown')
      const all = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(all).toContain('Available reviewers:')
    })
  })
})
