/**
 * Tests for resolveAgenticRepoUrl — the diff-scope agentic review's remote
 * resolution. Regression guard: a remoteless repo must NOT hard-fail the
 * review anymore. Previously this path threw "Ensure you have a git remote
 * configured."; now it coalesces to '' and degrades gracefully, matching the
 * repo-scope audit path.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

// `src/index.ts` invokes main() at module-load. Under vitest, process.argv is
// vitest's own argv, which parseArgs() rejects — that throws inside main and
// triggers process.exit(1). ESM imports hoist above plain statements, so we
// set a benign argv inside vi.hoisted() which runs before any imports.
vi.hoisted(() => {
  process.argv = ['node', 'kode-review', '--show-config']
})

vi.mock('../vcs/index.js', () => ({
  getRepoUrl: vi.fn(),
  // Other vcs symbols are imported by index.ts but unused at module-load;
  // leaving them as undefined is fine (they are never called during --show-config).
  getRepoRoot: vi.fn(),
  detectPlatform: vi.fn(),
  getCurrentBranch: vi.fn(),
  isGitRepository: vi.fn(),
}))
vi.mock('../indexer/index.js', () => ({
  getIndexerStatus: vi.fn(async () => ({ running: false, apiUrl: null })),
}))

import { resolveAgenticRepoUrl } from '../index.js'
import { getRepoUrl } from '../vcs/index.js'
import { logger } from '../utils/logger.js'

describe('resolveAgenticRepoUrl', () => {
  let warnSpy: MockInstance<(msg: string) => void>
  let infoSpy: MockInstance<(msg: string) => void>

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.mocked(getRepoUrl).mockReset()
  })

  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('returns the remote URL unchanged when one exists, with no warning', async () => {
    vi.mocked(getRepoUrl).mockResolvedValue('https://example.com/foo.git')
    const url = await resolveAgenticRepoUrl('http://localhost:7700')
    expect(url).toBe('https://example.com/foo.git')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('coalesces a missing remote to empty string instead of throwing (indexer off → info)', async () => {
    vi.mocked(getRepoUrl).mockResolvedValue(null)
    // The core regression: this used to throw. It must now resolve to ''.
    await expect(resolveAgenticRepoUrl(undefined)).resolves.toBe('')
    expect(infoSpy).toHaveBeenCalledOnce()
    // Verify the diagnostic content, not just the call count — guards against a
    // swap to logger.debug or an unrelated info message slipping through.
    expect(infoSpy.mock.calls[0][0]).toMatch(/No git remote configured/)
    expect(infoSpy.mock.calls[0][0]).toMatch(/filesystem-backed tools/)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns (not just informs) about degraded scoping when the indexer is running and no remote exists', async () => {
    vi.mocked(getRepoUrl).mockResolvedValue(null)
    const url = await resolveAgenticRepoUrl('http://localhost:7700')
    expect(url).toBe('')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toMatch(/indexer-backed tools cannot scope/)
  })

  it('treats an empty-string remote the same as no remote', async () => {
    vi.mocked(getRepoUrl).mockResolvedValue('')
    await expect(resolveAgenticRepoUrl(undefined)).resolves.toBe('')
    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy.mock.calls[0][0]).toMatch(/No git remote configured/)
  })
})
