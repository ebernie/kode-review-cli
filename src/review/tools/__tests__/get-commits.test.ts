import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execaSync } from 'execa'
import { getCommitsHandler } from '../get-commits.js'
import { getMergeBase } from '../git-helpers.js'

function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd })
}

describe('getCommitsHandler', () => {
  let repo: string
  let defaultBase: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-commits-'))
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
    defaultBase = await getMergeBase(repo, 'main', 'HEAD')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns commits in the default range (merge-base..HEAD)', async () => {
    const out = await getCommitsHandler({}, repo, defaultBase)
    expect(out.commits).toHaveLength(1)
    expect(out.commits[0].subject).toBe('feat: bump value')
    expect(out.totalCount).toBe(1)
    expect(out.base).toBe(defaultBase)
    expect(out.head).toBe('HEAD')
  })

  it('respects the limit option', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: a')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: b')
    const out = await getCommitsHandler({ limit: 1 }, repo, defaultBase)
    expect(out.commits).toHaveLength(1)
  })

  it('caps the limit at MAX_LIMIT (100)', async () => {
    const out = await getCommitsHandler({ limit: 9999 }, repo, defaultBase)
    expect(out.commits.length).toBeLessThanOrEqual(100)
  })

  it('includes body when requested', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: x', '-m', 'detailed body')
    const out = await getCommitsHandler({ includeBody: true }, repo, defaultBase)
    expect(out.commits.find((c) => c.subject === 'feat: x')?.body).toContain('detailed body')
  })

  it('honours explicit base and head overrides', async () => {
    const initial = execaSync('git', ['rev-parse', 'main'], { cwd: repo }).stdout.toString().trim()
    const out = await getCommitsHandler({ base: initial, head: 'HEAD' }, repo, 'unused-default')
    expect(out.base).toBe(initial)
    expect(out.commits).toHaveLength(1)
  })
})
