/**
 * Tests for revalidation-prompts.ts — buildRevalidationPrompt assembles a
 * deterministic user prompt from a feature + open findings.
 *
 * Uses real tmpdir + real files so the file-read path is exercised end-to-end.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildRevalidationPrompt,
  REVALIDATION_MODE_SUFFIX,
} from '../revalidation-prompts.js'
import { REVALIDATIONS_FENCE_TAG } from '../revalidation-schema.js'
import { REPO_AUDIT_DEFAULTS, type FeatureRecord, type RepoFindingRecord } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-revalprompt-'))
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

function makeRecord(overrides: Partial<RepoFindingRecord> = {}): RepoFindingRecord {
  return {
    schemaVersion: 1,
    findingId: 'fid-a',
    featureId: 'pkg-foo',
    persona: 'security',
    status: 'open',
    finding: {
      severity: 'HIGH',
      category: 'security',
      confidence: 'HIGH',
      title: 'Hardcoded API key',
      file: 'src/auth.ts',
      lineStart: 42,
      lineEnd: 42,
      evidence: 'const apiKey = "sk-abc"',
      problem: 'Secret committed to source.',
      recommendation: 'Move to env var.',
    },
    createdByRunId: 'run-1',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('buildRevalidationPrompt — structure', () => {
  it('includes feature metadata, current file contents, and findings to revalidate', async () => {
    await writeFileAt('src/auth.ts', 'const apiKey = "sk-abc"\n')
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [makeRecord()],
      repoRoot: tmp,
    })

    expect(built.systemSuffix).toBe(REVALIDATION_MODE_SUFFIX)
    expect(built.userPrompt).toContain('## Revalidation Mode')
    expect(built.userPrompt).toContain('## Feature Under Review')
    expect(built.userPrompt).toContain('featureId: pkg-foo')
    expect(built.userPrompt).toContain('## Current File Contents')
    expect(built.userPrompt).toContain('<file path="src/auth.ts" status="present">')
    expect(built.userPrompt).toContain('const apiKey = "sk-abc"')
    expect(built.userPrompt).toContain('## Findings to Revalidate')
    expect(built.userPrompt).toContain('<finding id="fid-a" persona="security">')
    expect(built.userPrompt).toContain('originally cited: src/auth.ts:42-42')
    expect(built.userPrompt).toContain('problem: Secret committed to source.')
    expect(built.userPrompt).toContain('## Output Instructions')
    expect(built.userPrompt).toContain(REVALIDATIONS_FENCE_TAG)
    expect(built.inlinedFiles).toEqual(['src/auth.ts'])
    expect(built.missingFiles).toEqual([])
    expect(built.deferredFiles).toEqual([])
    // Below-cap case must not emit the deferred-files header.
    expect(built.userPrompt).not.toContain('Additional cited files not inlined')
  })

  it('emits status="missing" markers for files that no longer exist', async () => {
    // No src/auth.ts written — readFileForPrompt returns null.
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [makeRecord()],
      repoRoot: tmp,
    })
    expect(built.userPrompt).toContain('<file path="src/auth.ts" status="missing"/>')
    expect(built.userPrompt).not.toContain('status="present"')
    expect(built.missingFiles).toEqual(['src/auth.ts'])
    expect(built.inlinedFiles).toEqual([])
  })

  it('deduplicates files when multiple findings cite the same path', async () => {
    await writeFileAt('src/auth.ts', 'shared file body\n')
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [
        makeRecord({ findingId: 'fid-a' }),
        makeRecord({ findingId: 'fid-b' }),
        makeRecord({ findingId: 'fid-c' }),
      ],
      repoRoot: tmp,
    })
    // Three findings, but only one <file> wrapper for src/auth.ts.
    const occurrences = built.userPrompt.match(/<file path="src\/auth\.ts"/g) ?? []
    expect(occurrences).toHaveLength(1)
    expect(built.inlinedFiles).toEqual(['src/auth.ts'])
    // All three findings show up.
    expect(built.userPrompt).toContain('id="fid-a"')
    expect(built.userPrompt).toContain('id="fid-b"')
    expect(built.userPrompt).toContain('id="fid-c"')
  })

  it('sorts findings by findingId deterministically regardless of input order', async () => {
    await writeFileAt('src/x.ts', 'x\n')
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [
        makeRecord({ findingId: 'fid-zzz', finding: { ...makeRecord().finding, file: 'src/x.ts' } }),
        makeRecord({ findingId: 'fid-aaa', finding: { ...makeRecord().finding, file: 'src/x.ts' } }),
        makeRecord({ findingId: 'fid-mmm', finding: { ...makeRecord().finding, file: 'src/x.ts' } }),
      ],
      repoRoot: tmp,
    })
    const idxAaa = built.userPrompt.indexOf('id="fid-aaa"')
    const idxMmm = built.userPrompt.indexOf('id="fid-mmm"')
    const idxZzz = built.userPrompt.indexOf('id="fid-zzz"')
    expect(idxAaa).toBeGreaterThan(-1)
    expect(idxMmm).toBeGreaterThan(idxAaa)
    expect(idxZzz).toBeGreaterThan(idxMmm)
  })

  it('escapes XML-unsafe characters in findingId and persona attributes', async () => {
    await writeFileAt('src/x.ts', 'x\n')
    const record = makeRecord({
      findingId: 'fid<a>"b"&c',
      persona: 'evil"persona',
      finding: { ...makeRecord().finding, file: 'src/x.ts' },
    })
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [record],
      repoRoot: tmp,
    })
    // The raw unescaped form must not appear as an attribute value — the
    // injected quote/angle/amp characters would have terminated the attribute
    // and let downstream text be interpreted as XML, breaking the agent's
    // structured prompt.
    expect(built.userPrompt).not.toContain('id="fid<a>')
    // The fully-escaped attribute literal must appear verbatim — substring
    // checks of "&amp;" alone are weak because other legitimate metadata
    // could contain that escape coincidentally.
    expect(built.userPrompt).toContain(
      '<finding id="fid&lt;a&gt;&quot;b&quot;&amp;c" persona="evil&quot;persona">',
    )
  })

  it('does NOT inline files outside the repo via path traversal', async () => {
    // assertWithinRepo (inside readFileForPrompt) rejects '../foo' — the
    // prompt builder must treat such paths as missing rather than reading
    // outside the tree.
    const record = makeRecord({
      finding: { ...makeRecord().finding, file: '../etc-passwd' },
    })
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [record],
      repoRoot: tmp,
    })
    expect(built.userPrompt).toContain('status="missing"')
    expect(built.missingFiles).toEqual(['../etc-passwd'])
  })

  it('includes trust_boundaries in feature metadata when present', async () => {
    await writeFileAt('src/auth.ts', 'x\n')
    const built = await buildRevalidationPrompt({
      feature: makeFeature({ trustBoundaries: ['user-input', 'database'] }),
      openFindings: [makeRecord()],
      repoRoot: tmp,
    })
    expect(built.userPrompt).toContain('trust_boundaries: user-input, database')
  })

  it('output instructions reference the kode-revalidations fence tag', async () => {
    await writeFileAt('src/auth.ts', 'x\n')
    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: [makeRecord()],
      repoRoot: tmp,
    })
    expect(built.userPrompt).toContain('`kode-revalidations`')
    // The instructions must spell out the three verdict values verbatim so
    // the agent's structured-output schema isn't ambiguous.
    expect(built.userPrompt).toContain('"fixed"')
    expect(built.userPrompt).toContain('"still-present"')
    expect(built.userPrompt).toContain('"uncertain"')
  })
})

describe('buildRevalidationPrompt — file-count cap', () => {
  const CAP = REPO_AUDIT_DEFAULTS.MAX_REVALIDATION_FILES_IN_PROMPT

  it('caps inlined files at MAX_REVALIDATION_FILES_IN_PROMPT and defers overflow', async () => {
    // Build CAP + 5 distinct files, each cited by a unique finding. Without
    // the cap, all CAP + 5 file bodies would be inlined; with it, only the
    // first CAP appear as <file ...> blocks and the remaining 5 are listed
    // under "Additional cited files not inlined".
    const excess = 5
    const totalFiles = CAP + excess
    const records: RepoFindingRecord[] = []
    for (let i = 0; i < totalFiles; i += 1) {
      // Zero-padded ordinal so localeCompare sort matches numeric order.
      const ord = String(i).padStart(3, '0')
      const path = `src/f${ord}.ts`
      await writeFileAt(path, `// file ${ord}\n`)
      records.push(
        makeRecord({
          findingId: `fid-${ord}`,
          finding: { ...makeRecord().finding, file: path },
        }),
      )
    }

    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: records,
      repoRoot: tmp,
    })

    // Inlined count exactly equals the cap.
    expect(built.inlinedFiles).toHaveLength(CAP)
    expect(built.deferredFiles).toHaveLength(excess)

    // Inline / deferred partition is contiguous in sorted order: the first
    // CAP files are inlined, the last `excess` are deferred. This guards
    // against silent reordering bugs that would still pass a length-only
    // assertion.
    const expectedInlined = Array.from({ length: CAP }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`)
    const expectedDeferred = Array.from(
      { length: excess },
      (_, i) => `src/f${String(CAP + i).padStart(3, '0')}.ts`,
    )
    expect(built.inlinedFiles).toEqual(expectedInlined)
    expect(built.deferredFiles).toEqual(expectedDeferred)

    // Deferred-files header is emitted and lists every deferred path.
    expect(built.userPrompt).toContain('### Additional cited files not inlined')
    expect(built.userPrompt).toContain(
      'Use read_file / search_code tools to inspect these if needed:',
    )
    for (const p of expectedDeferred) {
      expect(built.userPrompt).toContain(`- ${p}`)
    }

    // Deferred files MUST NOT appear as inlined <file path="X" status="present">
    // wrappers — that's the failure mode the cap exists to prevent.
    for (const p of expectedDeferred) {
      expect(built.userPrompt).not.toContain(`<file path="${p}" status="present">`)
    }

    // Inlined files DO appear with the present wrapper — sanity check that
    // the cap didn't accidentally drop the entire inline section.
    for (const p of expectedInlined) {
      expect(built.userPrompt).toContain(`<file path="${p}" status="present">`)
    }

    // All findings are still listed under "Findings to Revalidate" — the cap
    // only restricts file inlining, not which findings the agent verdicts.
    for (let i = 0; i < totalFiles; i += 1) {
      expect(built.userPrompt).toContain(`id="fid-${String(i).padStart(3, '0')}"`)
    }
  })

  it('does NOT emit the deferred-files header when distinctFiles count equals the cap exactly', async () => {
    // Exactly CAP distinct files: filesToInline = all, deferredFiles = [].
    // The deferred-files header must be suppressed entirely.
    const records: RepoFindingRecord[] = []
    for (let i = 0; i < CAP; i += 1) {
      const ord = String(i).padStart(3, '0')
      const path = `src/exact${ord}.ts`
      await writeFileAt(path, `// exact ${ord}\n`)
      records.push(
        makeRecord({
          findingId: `fid-${ord}`,
          finding: { ...makeRecord().finding, file: path },
        }),
      )
    }

    const built = await buildRevalidationPrompt({
      feature: makeFeature(),
      openFindings: records,
      repoRoot: tmp,
    })

    expect(built.inlinedFiles).toHaveLength(CAP)
    expect(built.deferredFiles).toEqual([])
    // Critical assertion: at-cap must behave identically to under-cap for
    // the deferred section. A naive `if (distinctFiles.length > 0)` would
    // emit the header here and is the regression this guards against.
    expect(built.userPrompt).not.toContain('Additional cited files not inlined')
  })
})
