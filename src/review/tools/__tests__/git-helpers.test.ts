import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execaSync } from 'execa'
import {
  getCommitsInRange,
  getFileHistory,
  getMergeBase,
} from '../git-helpers.js'

function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd })
}

describe('git-helpers', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-git-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'initial commit')
    git(repo, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'two')
    git(repo, 'commit', '-q', '-am', 'feat: bump value')
    writeFileSync(join(repo, 'a.txt'), 'three')
    git(repo, 'commit', '-q', '-am', 'fix: bump again')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns commits in <base>..HEAD with subject, author, sha', async () => {
    const commits = await getCommitsInRange(repo, 'main', 'HEAD')
    expect(commits).toHaveLength(2)
    expect(commits[0].subject).toBe('fix: bump again')
    expect(commits[1].subject).toBe('feat: bump value')
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commits[0].author).toBe('Test')
    expect(commits[0].authorEmail).toBe('test@example.com')
    expect(commits[0].shortSha).toMatch(/^[0-9a-f]{7,}$/)
    expect(commits[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('omits body when includeBody is not set', async () => {
    const commits = await getCommitsInRange(repo, 'main', 'HEAD')
    expect(commits[0].body).toBeUndefined()
  })

  it('includes full body when requested', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: x', '-m', 'long body here')
    const commits = await getCommitsInRange(repo, 'main', 'HEAD', { includeBody: true })
    expect(commits[0].body).toContain('long body here')
  })

  it('returns file history limited to N entries', async () => {
    const history = await getFileHistory(repo, 'a.txt', { limit: 1 })
    expect(history).toHaveLength(1)
    expect(history[0].subject).toBe('fix: bump again')
  })

  it('only returns commits that touched the named file', async () => {
    writeFileSync(join(repo, 'other.txt'), 'unrelated')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'chore: add other')
    const history = await getFileHistory(repo, 'a.txt')
    expect(history.every((c) => c.subject !== 'chore: add other')).toBe(true)
  })

  it('computes merge-base between two refs (matches initial commit SHA)', async () => {
    const initialSha = execaSync('git', ['rev-parse', 'main'], { cwd: repo }).stdout.toString().trim()
    const base = await getMergeBase(repo, 'main', 'HEAD')
    expect(base).toMatch(/^[0-9a-f]{40}$/)
    expect(base).toBe(initialSha)
  })

  it('returns an empty array for an empty range', async () => {
    const commits = await getCommitsInRange(repo, 'HEAD', 'HEAD')
    expect(commits).toEqual([])
  })

  it('throws a clear error when merge-base targets are invalid', async () => {
    await expect(getMergeBase(repo, 'main', 'no-such-ref')).rejects.toThrow(/merge-base/)
  })

  it('throws when getCommitsInRange is given an invalid ref', async () => {
    await expect(getCommitsInRange(repo, 'no-such-ref', 'HEAD')).rejects.toThrow(/git log/)
  })

  it('returns [] for getFileHistory on a file that never existed', async () => {
    const history = await getFileHistory(repo, 'never-existed.txt')
    expect(history).toEqual([])
  })
})
