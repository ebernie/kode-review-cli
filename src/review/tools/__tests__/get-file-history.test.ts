import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execaSync } from 'execa'
import { getFileHistoryHandler } from '../get-file-history.js'

function git(cwd: string, ...args: string[]): void {
  execaSync('git', args, { cwd })
}

describe('getFileHistoryHandler', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kode-review-fh-'))
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'initial commit')
    writeFileSync(join(repo, 'a.txt'), 'two')
    git(repo, 'commit', '-q', '-am', 'feat: update a')
    writeFileSync(join(repo, 'b.txt'), 'b-content')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'chore: add b')
    writeFileSync(join(repo, 'a.txt'), 'three')
    git(repo, 'commit', '-q', '-am', 'fix: tweak a')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns commits that touched the requested file, newest first', async () => {
    const out = await getFileHistoryHandler({ filePath: 'a.txt' }, repo)
    expect(out.totalCount).toBeGreaterThan(0)
    expect(out.commits[0].subject).toBe('fix: tweak a')
    expect(out.commits.every((c) => c.subject !== 'chore: add b')).toBe(true)
  })

  it('respects limit (default 10, capped at 50)', async () => {
    const out = await getFileHistoryHandler({ filePath: 'a.txt', limit: 1 }, repo)
    expect(out.commits).toHaveLength(1)
    const capped = await getFileHistoryHandler({ filePath: 'a.txt', limit: 9999 }, repo)
    expect(capped.commits.length).toBeLessThanOrEqual(50)
  })

  it('returns empty for a path that never existed', async () => {
    const out = await getFileHistoryHandler({ filePath: 'never.txt' }, repo)
    expect(out.commits).toEqual([])
    expect(out.totalCount).toBe(0)
  })

  it('includes body when includeBody is set', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'feat: x', '-m', 'with body')
    writeFileSync(join(repo, 'a.txt'), 'four')
    git(repo, 'commit', '-q', '-am', 'feat: y', '-m', 'another body')
    const out = await getFileHistoryHandler({ filePath: 'a.txt', includeBody: true }, repo)
    expect(out.commits[0].body).toContain('another body')
  })
})
