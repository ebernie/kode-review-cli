/**
 * Tests for prompts.ts — buildFeatureReviewPrompt assembles a deterministic
 * user-prompt body around a feature record + capped file contents.
 *
 * Uses real tmpdir + real files so the file-read path is exercised.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFeatureReviewPrompt, FEATURE_REVIEW_MODE_SUFFIX } from '../prompts.js'
import type { FeatureRecord, TrustBoundary } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-prompts-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: 'pkg-foo',
    title: 'foo package',
    summary: 'A library that does foo.',
    kind: 'library',
    source: 'heuristic',
    confidence: 'high',
    entrypoints: [],
    ownedFiles: [],
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: 'pending',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

describe('FEATURE_REVIEW_MODE_SUFFIX', () => {
  it('mentions the user message sections it adapts', () => {
    expect(FEATURE_REVIEW_MODE_SUFFIX).toContain('owned_files')
    expect(FEATURE_REVIEW_MODE_SUFFIX).toContain('context_files')
  })

  it('reminds the model that tools are available', () => {
    expect(FEATURE_REVIEW_MODE_SUFFIX).toMatch(/tools|tool calls/i)
  })
})

describe('buildFeatureReviewPrompt — metadata header', () => {
  it('emits feature metadata in a structured block', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        featureId: 'pkg-bar',
        title: 'bar service',
        kind: 'service',
        summary: 'Handles bar requests.',
        trustBoundaries: ['user-input' as TrustBoundary, 'network' as TrustBoundary],
        tags: ['go', 'service'],
      }),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toContain('featureId: pkg-bar')
    expect(result.userPrompt).toContain('title: bar service')
    expect(result.userPrompt).toContain('kind: service')
    expect(result.userPrompt).toContain('summary: Handles bar requests.')
    expect(result.userPrompt).toContain('trust_boundaries: user-input, network')
    expect(result.userPrompt).toContain('tags: go, service')
  })

  it('renders entrypoints when present', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        entrypoints: [
          { path: 'cmd/foo/main.go', symbol: 'main', route: null, command: 'foo' },
        ],
      }),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toContain('cmd/foo/main.go')
    expect(result.userPrompt).toContain('symbol=main')
    expect(result.userPrompt).toContain('command=foo')
  })

  it('omits entrypoint/trust_boundaries/tags lines when empty', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature(),
      repoRoot: tmp,
    })
    expect(result.userPrompt).not.toContain('entrypoints:')
    expect(result.userPrompt).not.toContain('trust_boundaries:')
    expect(result.userPrompt).not.toContain('tags:')
  })
})

describe('buildFeatureReviewPrompt — owned files', () => {
  it('inlines owned files within the cap', async () => {
    await writeFileAt('src/foo.ts', 'export const x = 1\n')
    await writeFileAt('src/bar.ts', 'export const y = 2\n')
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        ownedFiles: [
          { path: 'src/foo.ts', reason: 'main impl' },
          { path: 'src/bar.ts', reason: 'helper' },
        ],
      }),
      repoRoot: tmp,
    })
    expect(result.inlinedFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(result.deferredFiles).toEqual([])
    expect(result.userPrompt).toContain('export const x = 1')
    expect(result.userPrompt).toContain('export const y = 2')
    expect(result.userPrompt).toContain('```typescript')
  })

  it('truncates owned files past maxOwnedFiles into a deferred list', async () => {
    const refs = []
    for (let i = 0; i < 15; i++) {
      await writeFileAt(`src/f${i}.ts`, `// ${i}\n`)
      refs.push({ path: `src/f${i}.ts`, reason: 'r' })
    }
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({ ownedFiles: refs }),
      repoRoot: tmp,
      maxOwnedFiles: 5,
    })
    expect(result.inlinedFiles).toHaveLength(5)
    expect(result.deferredFiles).toHaveLength(10)
    // First 5 are inlined; last 10 are listed as deferred
    expect(result.inlinedFiles).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts'])
    expect(result.userPrompt).toContain('Additional owned files (use read_file to view)')
    expect(result.userPrompt).toContain('src/f5.ts')
    expect(result.userPrompt).toContain('src/f14.ts')
  })

  it('marks files that cannot be read as deferred with a hint', async () => {
    // No file written for nonexistent.ts
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        ownedFiles: [{ path: 'nonexistent.ts', reason: 'missing' }],
      }),
      repoRoot: tmp,
    })
    expect(result.inlinedFiles).toEqual([])
    expect(result.deferredFiles).toEqual(['nonexistent.ts'])
    expect(result.userPrompt).toContain('nonexistent.ts')
    expect(result.userPrompt).toContain('deferred="true"')
  })

  it('renders the language hint from file extension', async () => {
    await writeFileAt('foo.py', 'def x(): pass\n')
    await writeFileAt('foo.go', 'package foo\n')
    await writeFileAt('foo.rs', 'fn main() {}\n')
    await writeFileAt('foo.ts', 'export const x = 1\n')
    await writeFileAt('foo.xyz', 'unknown\n')
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        ownedFiles: [
          { path: 'foo.py', reason: '' },
          { path: 'foo.go', reason: '' },
          { path: 'foo.rs', reason: '' },
          { path: 'foo.ts', reason: '' },
          { path: 'foo.xyz', reason: '' },
        ],
      }),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toContain('```python')
    expect(result.userPrompt).toContain('```go')
    expect(result.userPrompt).toContain('```rust')
    expect(result.userPrompt).toContain('```typescript')
    // Unknown extension: bare fence (no language hint after ```).
    expect(result.userPrompt).toMatch(/```\nunknown/)
  })
})

describe('buildFeatureReviewPrompt — context files and tests', () => {
  it('inlines context files separately from owned files', async () => {
    await writeFileAt('src/foo.ts', 'export const x = 1\n')
    await writeFileAt('src/foo.test.ts', 'test("x", () => {})\n')
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        ownedFiles: [{ path: 'src/foo.ts', reason: 'impl' }],
        contextFiles: [{ path: 'src/foo.test.ts', reason: 'tests' }],
      }),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toContain('## Owned Files')
    expect(result.userPrompt).toContain('## Context Files')
    expect(result.inlinedFiles).toContain('src/foo.test.ts')
  })

  it('renders tests in a list when present', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature({
        tests: [
          { path: 'src/foo.test.ts', command: 'vitest run src/foo' },
        ],
      }),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toContain('## Tests')
    expect(result.userPrompt).toContain('src/foo.test.ts')
    expect(result.userPrompt).toContain('vitest run src/foo')
  })

  it('omits the Tests section when none are present', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature(),
      repoRoot: tmp,
    })
    expect(result.userPrompt).not.toContain('## Tests')
  })
})

describe('buildFeatureReviewPrompt — output instructions', () => {
  it('includes the per-feature finding cap in the prompt body', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature(),
      repoRoot: tmp,
    })
    expect(result.userPrompt).toMatch(/Cap your output at \d+ findings/)
  })

  it('returns a non-empty system suffix', async () => {
    const result = await buildFeatureReviewPrompt({
      feature: makeFeature(),
      repoRoot: tmp,
    })
    expect(result.systemSuffix.length).toBeGreaterThan(50)
    expect(result.systemSuffix).toBe(FEATURE_REVIEW_MODE_SUFFIX)
  })
})
