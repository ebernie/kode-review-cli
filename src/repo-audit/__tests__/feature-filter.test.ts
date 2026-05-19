/**
 * Tests for feature-filter.ts — `--since <ref>` reduces the feature set to
 * those whose owned files changed since the ref.
 *
 * Uses real git repos in tmp dirs so the git invocation contract is
 * actually exercised. Tests are slow (~real git per case) but anything
 * less would be testing a mock, not the integration.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec as runCommand } from '../../utils/exec.js'
import { filterFeaturesBySince, touchedFilesSince } from '../feature-filter.js'
import type { FeatureRecord } from '../types.js'

let tmp: string

async function git(args: string[]): Promise<void> {
  const result = await runCommand('git', args, { cwd: tmp })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

async function commit(message: string): Promise<string> {
  await git(['add', '-A'])
  await git(['commit', '-m', message])
  const result = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: tmp })
  return result.stdout.trim()
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-since-'))
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'commit.gpgsign', 'false'])
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeFeature(featureId: string, ownedFiles: string[]): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId,
    title: featureId,
    summary: 's',
    kind: 'library',
    source: 'heuristic',
    confidence: 'high',
    entrypoints: [],
    ownedFiles: ownedFiles.map((p) => ({ path: p, reason: '' })),
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: 'pending',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
  }
}

describe('touchedFilesSince', () => {
  it('returns files changed in <ref>...HEAD (three-dot)', async () => {
    await writeFileAt('a.ts', 'a\n')
    await writeFileAt('b.ts', 'b\n')
    const base = await commit('base')
    await writeFileAt('a.ts', 'a-modified\n')
    await writeFileAt('c.ts', 'c\n')
    await commit('change')

    const files = await touchedFilesSince(tmp, base)
    expect(files.sort()).toEqual(['a.ts', 'c.ts'])
  })

  it('returns an empty array when nothing changed', async () => {
    await writeFileAt('a.ts', 'a\n')
    const base = await commit('base')
    const files = await touchedFilesSince(tmp, base)
    expect(files).toEqual([])
  })

  it('throws a clear error on an unknown ref', async () => {
    await writeFileAt('a.ts', 'a\n')
    await commit('base')
    await expect(touchedFilesSince(tmp, 'no-such-ref')).rejects.toThrow(/git diff/)
  })

  it('handles paths with subdirectories', async () => {
    await writeFileAt('a.ts', 'a\n')
    const base = await commit('base')
    await writeFileAt('src/sub/dir/foo.ts', 'foo\n')
    await commit('add nested')

    const files = await touchedFilesSince(tmp, base)
    expect(files).toContain('src/sub/dir/foo.ts')
  })
})

describe('filterFeaturesBySince', () => {
  it('keeps features whose ownedFiles overlap the touched set', async () => {
    await writeFileAt('a.ts', 'a\n')
    await writeFileAt('b.ts', 'b\n')
    await writeFileAt('c.ts', 'c\n')
    const base = await commit('base')
    await writeFileAt('a.ts', 'a-modified\n')
    await commit('touch a')

    const features = [
      makeFeature('owns-a', ['a.ts']),
      makeFeature('owns-b', ['b.ts']),
      makeFeature('owns-a-and-c', ['a.ts', 'c.ts']),
    ]
    const result = await filterFeaturesBySince(features, tmp, base)
    expect(result.matched.map((f) => f.featureId).sort()).toEqual(['owns-a', 'owns-a-and-c'])
    expect(result.touchedFiles).toEqual(['a.ts'])
  })

  it('does NOT trigger on contextFile-only overlap', async () => {
    // Feature lists `b.ts` in contextFiles, not ownedFiles. Changing `b.ts`
    // should not cause this feature to be re-reviewed.
    await writeFileAt('a.ts', 'a\n')
    await writeFileAt('b.ts', 'b\n')
    const base = await commit('base')
    await writeFileAt('b.ts', 'b-modified\n')
    await commit('touch b')

    const feature: FeatureRecord = {
      ...makeFeature('owns-a', ['a.ts']),
      contextFiles: [{ path: 'b.ts', reason: 'tests' }],
    }
    const result = await filterFeaturesBySince([feature], tmp, base)
    expect(result.matched).toEqual([])
  })

  it('returns no matches when nothing changed since the ref', async () => {
    await writeFileAt('a.ts', 'a\n')
    const base = await commit('base')

    const features = [makeFeature('owns-a', ['a.ts'])]
    const result = await filterFeaturesBySince(features, tmp, base)
    expect(result.matched).toEqual([])
    expect(result.touchedFiles).toEqual([])
  })

  it('handles a feature with zero ownedFiles (never matches)', async () => {
    await writeFileAt('a.ts', 'a\n')
    const base = await commit('base')
    await writeFileAt('a.ts', 'a-modified\n')
    await commit('touch')

    const features = [makeFeature('empty', [])]
    const result = await filterFeaturesBySince(features, tmp, base)
    expect(result.matched).toEqual([])
  })

  it('handles a large change set (does not silently truncate)', async () => {
    // Sanity check that we don't lose features when many files change.
    const paths: string[] = []
    for (let i = 0; i < 50; i++) {
      paths.push(`f${i}.ts`)
      await writeFileAt(`f${i}.ts`, `// ${i}\n`)
    }
    const base = await commit('base')
    for (let i = 0; i < 50; i++) {
      await writeFileAt(`f${i}.ts`, `// ${i} modified\n`)
    }
    await commit('touch all')

    const features = paths.map((p) => makeFeature(p, [p]))
    const result = await filterFeaturesBySince(features, tmp, base)
    expect(result.matched).toHaveLength(50)
  })
})
