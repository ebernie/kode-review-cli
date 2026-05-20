/**
 * Integration coverage for `resolveDefaultBase`.
 *
 * Background: the function previously returned the literal string `HEAD~20`
 * as its final fallback. In a repository with fewer than 20 commits, that
 * string is an invalid ref — `git log HEAD~20..HEAD` then fails with
 * "unknown revision", and `get_commits` returns an error instead of useful
 * history. The fix probes HEAD~20 before returning it and falls back to the
 * root commit otherwise.
 *
 * These tests use real on-disk git repos (tempdirs) rather than mocking
 * runProcess — runProcess is an internal helper of the SUT, and mocking it
 * would make these tests look right while bypassing the very ref-resolution
 * behavior they're meant to verify.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execaSync } from 'execa'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveDefaultBase } from '../pi-tools.js'

function git(repo: string, args: string[]): { stdout: string } {
  // execaSync uses execFile semantics under the hood — no shell, args are
  // never interpolated. Safe for hardcoded fixture commands.
  return execaSync('git', args, { cwd: repo })
}

function setupRepo(commitCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'kode-review-base-'))
  git(dir, ['init', '--initial-branch=main', '-q'])
  git(dir, ['config', 'user.email', 'test@local'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  for (let i = 0; i < commitCount; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `content ${i}`)
    git(dir, ['add', `file-${i}.txt`])
    git(dir, ['commit', '-m', `c${i}`, '-q'])
  }
  return dir
}

let repo: string

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

describe('resolveDefaultBase', () => {
  it('returns HEAD~20 when the repo has at least 21 commits', async () => {
    repo = setupRepo(25)

    const result = await resolveDefaultBase(repo)

    // No origin → falls through. HEAD~20 is a valid ref in this repo.
    expect(result).toBe('HEAD~20')
  })

  it('returns the root commit SHA in a small repo (<20 commits) instead of the invalid HEAD~20 string', async () => {
    repo = setupRepo(5)

    const result = await resolveDefaultBase(repo)

    // Critical regression assertion: must NOT be the literal "HEAD~20"
    // string in a repo without that ref. The old behavior returned this
    // string verbatim, causing downstream `git log HEAD~20..HEAD` to fail.
    expect(result).not.toBe('HEAD~20')

    // Should be a 40-char SHA matching the root commit.
    const rootSha = execaSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo }).stdout.trim()
    expect(result).toBe(rootSha)
    expect(result).toMatch(/^[a-f0-9]{40}$/)
  })

  it('returns a usable ref in a single-commit repo (root = HEAD)', async () => {
    repo = setupRepo(1)

    const result = await resolveDefaultBase(repo)

    // The root commit is also HEAD; the function should return that SHA.
    const headSha = execaSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim()
    expect(result).toBe(headSha)
  })

  it('verifies the returned ref against git: every fallback produces a ref git can resolve', async () => {
    // The whole point of the fix is that the returned string is usable as
    // a `git log <ref>..HEAD` base. Pin that contract directly.
    for (const commitCount of [1, 3, 19, 25]) {
      // Assign to the outer `repo` BEFORE entering the try block so a
      // throw inside setupRepo (which happens before the local `dir` is
      // even bound below) doesn't leak the tempdir — afterEach picks it up.
      repo = setupRepo(commitCount)
      try {
        const result = await resolveDefaultBase(repo)
        // execaSync throws on non-zero exit, so reaching the next line
        // means the ref resolved. This would have FAILED on (commitCount=1,
        // result='HEAD~20') with the old code.
        const out = execaSync('git', ['rev-parse', '--verify', result], { cwd: repo })
        expect(out.stdout.trim()).toMatch(/^[a-f0-9]{40}$/)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })
})
