/**
 * Tests for orchestrator-revalidate.ts — runRevalidate drives the
 * load-findings → filter → group → lock → verdict → persist loop.
 *
 * Mocks `revalidateFeatureGroupWithAgent` so we don't shell out to pi; uses
 * real `.kode-review/findings/` storage on tmpfs so the persist/read paths
 * are exercised.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks — the orchestrator imports these from sibling modules.
const mocks = vi.hoisted(() => ({
  revalidateFeatureGroupWithAgent: vi.fn(),
  filterFeaturesBySince: vi.fn(),
}))

vi.mock('../engines/kode-agent-revalidate.js', () => ({
  revalidateFeatureGroupWithAgent: mocks.revalidateFeatureGroupWithAgent,
}))

vi.mock('../feature-filter.js', () => ({
  filterFeaturesBySince: mocks.filterFeaturesBySince,
  touchedFilesSince: vi.fn(),
}))

import type { CliOptions } from '../../cli/args.js'
import { runRevalidate } from '../orchestrator-revalidate.js'
import {
  acquireFeatureLock,
  ensureStateDirs,
  listFindings,
  readFinding,
  stateDir,
  writeFinding,
} from '../state.js'
import type { RepoFindingRecord } from '../types.js'

let tmp: string

const baseCli: CliOptions = {
  scope: 'repo',
  quiet: false,
  format: 'text',
  postToPr: false,
  initHooks: false,
  reviewers: ['general'],
  listReviewers: false,
  watch: false,
  watchInterval: 300,
  watchInteractive: false,
  setup: false,
  setupVcs: false,
  reset: false,
  migrateYes: false,
  setupIndexer: false,
  index: false,
  indexReset: false,
  indexStatus: false,
  indexerCleanup: false,
  indexListRepos: false,
  backgroundIndexer: false,
  indexQueue: false,
  indexQueueClear: false,
  withContext: false,
  contextTopK: 5,
  agentic: true,
  maxIterations: 10,
  agenticTimeout: 600,
  showConfig: false,
  doctor: false,
  update: false,
  ci: false,
  failOn: 'critical',
  noSuppressions: false,
  engine: 'kode-agent',
  remap: false,
  jobs: 4,
  reportOnly: false,
  revalidate: true,
  clawpatchCompat: false,
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-reval-'))
  for (const m of Object.values(mocks)) {
    if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset()
  }
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFeatureFile(featureId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = join(tmp, '.clawpatch', 'features')
  await mkdir(dir, { recursive: true })
  const record = {
    schemaVersion: 1,
    featureId,
    title: featureId,
    summary: 's',
    kind: 'unknown',
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
  await writeFile(join(dir, `${featureId}.json`), JSON.stringify(record))
}

function makeRecord(overrides: Partial<RepoFindingRecord> = {}): RepoFindingRecord {
  return {
    schemaVersion: 1,
    findingId: 'fid-a',
    featureId: 'feat-a',
    persona: 'general',
    status: 'open',
    finding: {
      severity: 'HIGH',
      category: 'security',
      confidence: 'HIGH',
      title: 't',
      file: 'src/foo.ts',
      lineStart: 1,
      lineEnd: 1,
      evidence: 'e',
      problem: 'p',
      recommendation: 'r',
    },
    createdByRunId: 'run-original',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

function buildResult(verdictsByFindingId: Record<string, 'fixed' | 'still-present' | 'uncertain'>, options: { blockParsed?: boolean; truncated?: boolean } = {}) {
  const verdicts = new Map<string, { findingId: string; verdict: 'fixed' | 'still-present' | 'uncertain'; evidence?: string }>()
  for (const [id, v] of Object.entries(verdictsByFindingId)) {
    verdicts.set(id, { findingId: id, verdict: v })
  }
  return {
    feature: {} as unknown,
    persona: {} as unknown,
    verdicts,
    content: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    truncated: options.truncated ?? false,
    blockParsed: options.blockParsed ?? true,
  }
}

describe('runRevalidate — empty / no-op paths', () => {
  it('returns zero counts when there are no findings on disk', async () => {
    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.featuresReviewed).toBe(0)
    expect(result.findingsOnDisk).toBe(0)
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
  })

  it('returns zero counts when every finding is already closed', async () => {
    await writeFinding(tmp, makeRecord({ findingId: 'closed-1', status: 'fixed' }))
    await writeFinding(tmp, makeRecord({ findingId: 'closed-2', status: 'wont-fix' }))
    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.featuresReviewed).toBe(0)
    expect(result.findingsOnDisk).toBe(2)
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
  })
})

describe('runRevalidate — verdict application', () => {
  it('flips status to "fixed" when the agent says fixed', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const updated = await readFinding(tmp, 'fid-a')
    expect(updated?.status).toBe('fixed')
    expect(updated?.revalidationVerdict).toBe('fixed')
    expect(updated?.lastRevalidatedAt).toBeDefined()
    expect(updated?.revalidationRunId).toBeDefined()
    // Immutable fields must be preserved.
    expect(updated?.createdAt).toBe('2026-05-18T10:00:00.000Z')
    expect(updated?.createdByRunId).toBe('run-original')
    expect(updated?.findingId).toBe('fid-a')
    expect(updated?.persona).toBe('general')
    expect(updated?.featureId).toBe('feat-a')
  })

  it('keeps status="open" when the agent says still-present, but records the verdict', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'still-present' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const updated = await readFinding(tmp, 'fid-a')
    expect(updated?.status).toBe('open')
    // Crucially: revalidationVerdict is captured even for still-present so
    // the audit trail can show "open, re-verified" vs "open, never checked".
    expect(updated?.revalidationVerdict).toBe('still-present')
    expect(updated?.lastRevalidatedAt).toBeDefined()
  })

  it('flips status to "uncertain" when the agent says uncertain', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'uncertain' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const updated = await readFinding(tmp, 'fid-a')
    expect(updated?.status).toBe('uncertain')
    expect(updated?.revalidationVerdict).toBe('uncertain')
  })

  it('preserves the inner finding object verbatim across revalidation', async () => {
    await writeFeatureFile('feat-a')
    const original = makeRecord({
      findingId: 'fid-a',
      finding: {
        severity: 'CRITICAL',
        category: 'security',
        confidence: 'HIGH',
        title: 'Hardcoded API key',
        file: 'src/auth.ts',
        lineStart: 42,
        lineEnd: 50,
        evidence: 'sk-XXXX',
        problem: 'Secret committed.',
        recommendation: 'Rotate + env var.',
      },
    })
    await writeFinding(tmp, original)
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const updated = await readFinding(tmp, 'fid-a')
    expect(updated?.finding).toEqual(original.finding)
  })

  it('defaults to "uncertain" for findings the agent omitted from its verdict block', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-b' }))
    // Agent only verdicts fid-a; fid-b is missing.
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const a = await readFinding(tmp, 'fid-a')
    const b = await readFinding(tmp, 'fid-b')
    expect(a?.status).toBe('fixed')
    expect(b?.status).toBe('uncertain')
    expect(b?.revalidationVerdict).toBe('uncertain')
  })

  it('defaults every finding to "uncertain" when the agent emits no parseable block', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-b' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue({
      ...buildResult({}, { blockParsed: false }),
      blockError: 'missing',
    })

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const a = await readFinding(tmp, 'fid-a')
    const b = await readFinding(tmp, 'fid-b')
    expect(a?.status).toBe('uncertain')
    expect(b?.status).toBe('uncertain')
  })
})

describe('runRevalidate — closed findings are not re-verdicted', () => {
  it('leaves closed findings untouched even when grouped with open ones', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-open' }))
    const closedOriginal = makeRecord({
      findingId: 'fid-closed',
      status: 'fixed',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    await writeFinding(tmp, closedOriginal)
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-open': 'still-present' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    // Agent was invoked once, and only for the open finding.
    const calls = mocks.revalidateFeatureGroupWithAgent.mock.calls
    expect(calls).toHaveLength(1)
    const passedFindings = calls[0][0].openFindings as RepoFindingRecord[]
    expect(passedFindings.map((r) => r.findingId)).toEqual(['fid-open'])

    // Closed finding's record is unchanged.
    const closedAfter = await readFinding(tmp, 'fid-closed')
    expect(closedAfter?.updatedAt).toBe('2025-01-01T00:00:00.000Z')
    expect(closedAfter?.status).toBe('fixed')
    expect(closedAfter?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — --since filter', () => {
  it('only revalidates findings on features whose owned files changed', async () => {
    await writeFeatureFile('feat-touched', {
      ownedFiles: [{ path: 'src/touched.ts', reason: 'main' }],
    })
    await writeFeatureFile('feat-untouched', {
      ownedFiles: [{ path: 'src/untouched.ts', reason: 'main' }],
    })
    await writeFinding(tmp, makeRecord({ findingId: 'fid-t', featureId: 'feat-touched' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-u', featureId: 'feat-untouched' }))

    mocks.filterFeaturesBySince.mockResolvedValue({
      matched: [
        {
          schemaVersion: 1,
          featureId: 'feat-touched',
          title: 't',
          summary: 's',
          kind: 'unknown',
          source: 'heuristic',
          confidence: 'high',
          entrypoints: [],
          ownedFiles: [{ path: 'src/touched.ts', reason: 'main' }],
          contextFiles: [],
          tests: [],
          tags: [],
          trustBoundaries: [],
          status: 'pending',
          createdAt: '2026-05-18T10:00:00.000Z',
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
      ],
      touchedFiles: ['src/touched.ts'],
    })

    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-t': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, since: 'origin/main' },
    })

    expect(mocks.filterFeaturesBySince).toHaveBeenCalledOnce()
    const calls = mocks.revalidateFeatureGroupWithAgent.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0].feature.featureId).toBe('feat-touched')

    const t = await readFinding(tmp, 'fid-t')
    const u = await readFinding(tmp, 'fid-u')
    expect(t?.status).toBe('fixed')
    expect(u?.status).toBe('open') // untouched
    expect(u?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — --reviewers filter', () => {
  it('only revalidates findings whose persona is in the override list', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-sec', persona: 'security' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-gen', persona: 'general' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-sec': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reviewers: ['security'] },
    })

    const calls = mocks.revalidateFeatureGroupWithAgent.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0].persona.name).toBe('security')

    const gen = await readFinding(tmp, 'fid-gen')
    expect(gen?.status).toBe('open')
    expect(gen?.revalidationVerdict).toBeUndefined()
  })

  it('treats ["general"] as auto-dispatch (no override) — every persona\'s findings are revalidated', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-sec', persona: 'security' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-gen', persona: 'general' }))
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ openFindings }) =>
      buildResult(Object.fromEntries(openFindings.map((r: RepoFindingRecord) => [r.findingId, 'fixed' as const]))),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reviewers: ['general'] },
    })

    const personasInvoked = mocks.revalidateFeatureGroupWithAgent.mock.calls
      .map((c) => (c[0] as { persona: { name: string } }).persona.name)
      .sort()
    expect(personasInvoked).toEqual(['general', 'security'])
  })
})

describe('runRevalidate — grouping', () => {
  it('makes one engine call per (featureId, persona) group', async () => {
    await writeFeatureFile('feat-a')
    await writeFeatureFile('feat-b')
    await writeFinding(tmp, makeRecord({ findingId: 'a1', featureId: 'feat-a', persona: 'general' }))
    await writeFinding(tmp, makeRecord({ findingId: 'a2', featureId: 'feat-a', persona: 'general' }))
    await writeFinding(tmp, makeRecord({ findingId: 'a3', featureId: 'feat-a', persona: 'security' }))
    await writeFinding(tmp, makeRecord({ findingId: 'b1', featureId: 'feat-b', persona: 'general' }))

    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ openFindings }) =>
      buildResult(Object.fromEntries(openFindings.map((r: RepoFindingRecord) => [r.findingId, 'still-present' as const]))),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    // 3 distinct groups: (a, general), (a, security), (b, general).
    expect(mocks.revalidateFeatureGroupWithAgent).toHaveBeenCalledTimes(3)
    const seen = mocks.revalidateFeatureGroupWithAgent.mock.calls.map((c) => {
      const arg = c[0] as { feature: { featureId: string }; persona: { name: string }; openFindings: RepoFindingRecord[] }
      return {
        feature: arg.feature.featureId,
        persona: arg.persona.name,
        ids: arg.openFindings.map((r) => r.findingId).sort(),
      }
    })
    // (a, general) carries both a1 and a2 in one batched call.
    const aGen = seen.find((s) => s.feature === 'feat-a' && s.persona === 'general')
    expect(aGen?.ids).toEqual(['a1', 'a2'])
  })
})

describe('runRevalidate — feature locks', () => {
  it('skips a feature when another runner already holds its lock', async () => {
    await writeFeatureFile('feat-locked')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-x', featureId: 'feat-locked' }))

    // Hold the lock on behalf of a phantom runner.
    await acquireFeatureLock(tmp, 'feat-locked', 'phantom-run')

    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-x': 'fixed' }),
    )

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    expect(result.featuresReviewed).toBe(0)
    expect(result.findingsOnDisk).toBe(1)
    // Finding is untouched.
    const after = await readFinding(tmp, 'fid-x')
    expect(after?.status).toBe('open')
    expect(after?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — persona no longer registered', () => {
  it('marks findings as "uncertain" when the persona name cannot be resolved', async () => {
    await writeFeatureFile('feat-a')
    // "ghost-persona" is not a built-in and has no user-defined template;
    // resolveReviewer will throw "Unknown reviewer".
    await writeFinding(tmp, makeRecord({ findingId: 'fid-ghost', persona: 'ghost-persona' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-ghost': 'fixed' }), // mock would have said "fixed" if reached
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    // Engine never invoked — the persona-resolve guard short-circuits.
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    const after = await readFinding(tmp, 'fid-ghost')
    expect(after?.status).toBe('uncertain')
    expect(after?.revalidationVerdict).toBe('uncertain')
    // Immutable: persona stays the original ghost name (we don't rewrite it).
    expect(after?.persona).toBe('ghost-persona')
  })
})

describe('runRevalidate — --since filter reducing to zero', () => {
  it('returns 0 reviewed when --since produces no matched features', async () => {
    await writeFeatureFile('feat-a', {
      ownedFiles: [{ path: 'src/foo.ts', reason: 'main' }],
    })
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a', featureId: 'feat-a' }))
    // Mock returns empty matched set — caller --since ref produced no
    // touched-file overlap with this feature.
    mocks.filterFeaturesBySince.mockResolvedValue({ matched: [], touchedFiles: [] })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, since: 'origin/main' },
    })

    expect(mocks.filterFeaturesBySince).toHaveBeenCalledOnce()
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    expect(result.featuresReviewed).toBe(0)
    // Finding is untouched — no verdict applied to a finding the filter excluded.
    const after = await readFinding(tmp, 'fid-a')
    expect(after?.status).toBe('open')
    expect(after?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — missing feature record', () => {
  it('verdicts as "uncertain" when the finding\'s feature is not in clawpatch\'s map', async () => {
    // No .clawpatch/features/feat-orphan.json — but a finding references it.
    await writeFinding(tmp, makeRecord({ findingId: 'fid-orph', featureId: 'feat-orphan' }))
    await ensureStateDirs(tmp)

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    const after = await readFinding(tmp, 'fid-orph')
    expect(after?.status).toBe('uncertain')
    expect(after?.revalidationVerdict).toBe('uncertain')
  })
})

describe('runRevalidate — rate-limit abort', () => {
  it('breaks the loop and returns aborted=true on rate-limit error', async () => {
    await writeFeatureFile('feat-a')
    await writeFeatureFile('feat-b')
    await writeFinding(tmp, makeRecord({ findingId: 'a1', featureId: 'feat-a' }))
    await writeFinding(tmp, makeRecord({ findingId: 'b1', featureId: 'feat-b' }))

    let call = 0
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async () => {
      call += 1
      if (call === 1) return buildResult({ a1: 'fixed' })
      throw new Error('Model returned an error: You have hit your usage limit. Try again in ~10 min.')
    })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/usage limit|rate.?limit/i)
    // First feature's verdict was persisted before abort — partial progress survives.
    const a1 = await readFinding(tmp, 'a1')
    expect(a1?.status).toBe('fixed')
    // Second feature's finding was NOT touched.
    const b1 = await readFinding(tmp, 'b1')
    expect(b1?.status).toBe('open')
    expect(b1?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — run history', () => {
  it('appends a run-history entry with mode="revalidate" and accurate counters', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'a1' }))
    await writeFinding(tmp, makeRecord({ findingId: 'a2' }))
    await writeFinding(tmp, makeRecord({ findingId: 'a3' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ a1: 'fixed', a2: 'still-present', a3: 'uncertain' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const historyPath = join(stateDir(tmp), 'run-history.jsonl')
    const raw = await readFile(historyPath, 'utf-8')
    const entry = JSON.parse(raw.trim())
    expect(entry.mode).toBe('revalidate')
    expect(entry.findingsRevalidated).toBe(3)
    expect(entry.findingsClosed).toBe(1)
    expect(entry.findingsUncertain).toBe(1)
    expect(entry.findingsStillPresent).toBe(1)
    expect(entry.findingsEmitted).toBe(0) // revalidation never emits new findings
    // The verdict decomposition must sum to revalidated — guards against
    // a future regression where a new verdict type is added but the
    // counter loop is forgotten.
    expect(
      entry.findingsClosed + entry.findingsUncertain + entry.findingsStillPresent,
    ).toBe(entry.findingsRevalidated)
  })
})

describe('runRevalidate — filter mismatch', () => {
  it('returns 0 reviewed when filters reduce the open set to zero', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a', persona: 'general' }))

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reviewers: ['security'] }, // no security findings exist
    })

    expect(result.featuresReviewed).toBe(0)
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    // Existing finding is untouched.
    const a = await readFinding(tmp, 'fid-a')
    expect(a?.revalidationVerdict).toBeUndefined()
  })
})

describe('runRevalidate — sanity: findings dir is initialized lazily', () => {
  it('does not create finding files when there are no findings', async () => {
    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    // Post-run: still no findings on disk.
    expect(await listFindings(tmp)).toEqual([])
  })
})
