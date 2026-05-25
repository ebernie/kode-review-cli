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
import type { FeatureRecord, RepoFindingRecord } from '../types.js'

let tmp: string

const baseCli: CliOptions = {
  scope: 'repo',
  quiet: false,
  format: 'text',
  postToPr: false,
  autoApprove: false,
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
  installAgentForce: false,
  listAgents: false,
  engine: 'kode-agent',
  remap: false,
  jobs: 4,
  reportOnly: false,
  listFindings: false,
  revalidate: true,
  retryUncertain: false,
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

  it('leaves a finding the agent omitted from its verdict block "open" for retry', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-b' }))
    // Agent only verdicts fid-a; fid-b is missing — an incomplete check, not
    // an observation, so fid-b must stay open and pristine for a later pass.
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
    expect(b?.status).toBe('open')
    // Untouched: no verdict, no revalidation stamp, original updatedAt.
    expect(b?.revalidationVerdict).toBeUndefined()
    expect(b?.lastRevalidatedAt).toBeUndefined()
    expect(b?.revalidationRunId).toBeUndefined()
    expect(b?.updatedAt).toBe('2026-05-18T10:00:00.000Z')
  })

  it('leaves every finding "open" when the agent emits no parseable block', async () => {
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
    // Both findings are untouched — same depth of check for each.
    for (const r of [a, b]) {
      expect(r?.status).toBe('open')
      expect(r?.revalidationVerdict).toBeUndefined()
      expect(r?.lastRevalidatedAt).toBeUndefined()
      expect(r?.revalidationRunId).toBeUndefined()
      expect(r?.updatedAt).toBe('2026-05-18T10:00:00.000Z')
    }
  })
})

describe('runRevalidate — engine errors leave findings open for retry', () => {
  it('leaves findings "open" (untouched) on a transient model error', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    mocks.revalidateFeatureGroupWithAgent.mockRejectedValue(
      new Error('Model returned an error: 503 service unavailable, please retry'),
    )

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const after = await readFinding(tmp, 'fid-a')
    expect(after?.status).toBe('open')
    // Fully pin "untouched": no verdict, no stamps, original updatedAt.
    expect(after?.revalidationVerdict).toBeUndefined()
    expect(after?.lastRevalidatedAt).toBeUndefined()
    expect(after?.revalidationRunId).toBeUndefined()
    expect(after?.updatedAt).toBe('2026-05-18T10:00:00.000Z')
    // The run did not abort — only the rate-limit path aborts.
    expect(result.aborted).toBeUndefined()
  })

  // Non-transient errors take the same leave-open branch as transient ones;
  // `isTransientModelError` only changes the log label, not the outcome. We
  // exercise the `else` branch explicitly and pin the same untouched contract.
  it('leaves findings "open" on a non-transient engine error', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    mocks.revalidateFeatureGroupWithAgent.mockRejectedValue(
      new Error('unexpected parser blowup'),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const after = await readFinding(tmp, 'fid-a')
    expect(after?.status).toBe('open')
    expect(after?.revalidationVerdict).toBeUndefined()
    expect(after?.lastRevalidatedAt).toBeUndefined()
    expect(after?.revalidationRunId).toBeUndefined()
    expect(after?.updatedAt).toBe('2026-05-18T10:00:00.000Z')
  })

  it('records left-open findings in run history under findingsLeftOpen, excluded from findingsRevalidated', async () => {
    await writeFeatureFile('feat-a')
    // fid-a gets a real verdict; fid-b is omitted (left open).
    await writeFinding(tmp, makeRecord({ findingId: 'fid-a' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-b' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-a': 'fixed' }),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })

    const historyPath = join(stateDir(tmp), 'run-history.jsonl')
    const entry = JSON.parse((await readFile(historyPath, 'utf-8')).trim())
    expect(entry.findingsRevalidated).toBe(1) // only fid-a was actually checked
    expect(entry.findingsClosed).toBe(1)
    expect(entry.findingsLeftOpen).toBe(1) // fid-b
    expect(entry.findingsUncertain).toBe(0)
    expect(entry.findingsStillPresent).toBe(0)
    // leftOpen is excluded from revalidated; together they cover both open findings.
    expect(entry.findingsRevalidated + entry.findingsLeftOpen).toBe(2)
  })
})

describe('runRevalidate — --retry-uncertain scope widening', () => {
  it('by default does NOT re-check uncertain findings', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-unc', status: 'uncertain' }))
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-unc': 'fixed' }),
    )

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli, // retryUncertain: false
    })

    // Uncertain is out of scope: engine never called, finding untouched.
    expect(mocks.revalidateFeatureGroupWithAgent).not.toHaveBeenCalled()
    expect(result.featuresReviewed).toBe(0)
    // The finding is still counted on disk — this distinguishes "excluded from
    // scope" from the "nothing on disk at all" early-exit (which also returns 0).
    expect(result.findingsOnDisk).toBe(1)
    const after = await readFinding(tmp, 'fid-unc')
    expect(after?.status).toBe('uncertain')
    expect(after?.revalidationVerdict).toBeUndefined()
  })

  it('re-checks uncertain findings when --retry-uncertain is set, alongside open ones', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-unc', status: 'uncertain' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-open', status: 'open' }))
    // The stranded uncertain finding is now fixed; the open one is still present.
    mocks.revalidateFeatureGroupWithAgent.mockResolvedValue(
      buildResult({ 'fid-unc': 'fixed', 'fid-open': 'still-present' }),
    )

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, retryUncertain: true },
    })

    expect(result.featuresReviewed).toBe(1)
    // Both findings entered the same (feature, persona) group in one call.
    const calls = mocks.revalidateFeatureGroupWithAgent.mock.calls
    expect(calls).toHaveLength(1)
    expect((calls[0][0].openFindings as RepoFindingRecord[]).map((r) => r.findingId).sort()).toEqual(
      ['fid-open', 'fid-unc'],
    )

    const unc = await readFinding(tmp, 'fid-unc')
    const open = await readFinding(tmp, 'fid-open')
    // The stranded finding got a real verdict and left uncertain limbo.
    expect(unc?.status).toBe('fixed')
    expect(unc?.revalidationVerdict).toBe('fixed')
    expect(unc?.lastRevalidatedAt).toBeDefined()
    expect(open?.status).toBe('open')
    expect(open?.revalidationVerdict).toBe('still-present')
  })

  it('groups uncertain and open findings purely by (feature, persona), independent of status', async () => {
    // The uncertain and open findings live in DIFFERENT features so a
    // regression that folds status into the grouping key would surface as the
    // wrong call count / membership.
    await writeFeatureFile('feat-open')
    await writeFeatureFile('feat-unc')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-open', featureId: 'feat-open', status: 'open' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-unc', featureId: 'feat-unc', status: 'uncertain' }))
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ openFindings }) =>
      buildResult(Object.fromEntries(openFindings.map((r: RepoFindingRecord) => [r.findingId, 'fixed' as const]))),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, retryUncertain: true },
    })

    // Two distinct features → two calls, one finding each (status is not a key).
    const seen = mocks.revalidateFeatureGroupWithAgent.mock.calls
      .map((c) => (c[0] as { feature: { featureId: string }; openFindings: RepoFindingRecord[] }))
      .map((a) => ({ feature: a.feature.featureId, ids: a.openFindings.map((r) => r.findingId) }))
      .sort((x, y) => x.feature.localeCompare(y.feature))
    expect(seen).toEqual([
      { feature: 'feat-open', ids: ['fid-open'] },
      { feature: 'feat-unc', ids: ['fid-unc'] },
    ])
    expect((await readFinding(tmp, 'fid-unc'))?.status).toBe('fixed')
    expect((await readFinding(tmp, 'fid-open'))?.status).toBe('fixed')
  })

  it('with --retry-uncertain, a re-checked uncertain finding stays uncertain (untouched) when the check fails', async () => {
    await writeFeatureFile('feat-a')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-unc', status: 'uncertain' }))
    mocks.revalidateFeatureGroupWithAgent.mockRejectedValue(
      new Error('503 service unavailable, please retry'),
    )

    await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, retryUncertain: true },
    })

    // Failed check must not downgrade or fabricate — the record is untouched,
    // so the NEXT --retry-uncertain run picks it up again.
    const after = await readFinding(tmp, 'fid-unc')
    expect(after?.status).toBe('uncertain')
    expect(after?.revalidationVerdict).toBeUndefined()
    expect(after?.lastRevalidatedAt).toBeUndefined()
    expect(after?.updatedAt).toBe('2026-05-18T10:00:00.000Z')
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

    // Key the outcome on feature identity, not invocation order: with the
    // worker pool feat-a and feat-b are reviewed concurrently, so we cannot
    // assume which engine call lands first. feat-a succeeds; feat-b rate-limits.
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ feature }) => {
      if ((feature as FeatureRecord).featureId === 'feat-a') return buildResult({ a1: 'fixed' })
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

    // The rate-limited group's findings are counted as left-open in run
    // history, so an aborted run does not under-report them.
    const historyPath = join(stateDir(tmp), 'run-history.jsonl')
    const entry = JSON.parse((await readFile(historyPath, 'utf-8')).trim())
    expect(entry.findingsRevalidated).toBe(1) // a1
    expect(entry.findingsClosed).toBe(1) // a1 → fixed
    expect(entry.findingsLeftOpen).toBe(1) // b1, rate-limited
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
    expect(entry.findingsLeftOpen).toBe(0) // every finding got a real verdict
    expect(entry.findingsEmitted).toBe(0) // revalidation never emits new findings
    // The verdict decomposition must sum to revalidated — guards against
    // a future regression where a new verdict type is added but the
    // counter loop is forgotten.
    expect(
      entry.findingsClosed + entry.findingsUncertain + entry.findingsStillPresent,
    ).toBe(entry.findingsRevalidated)
    // leftOpen is genuinely excluded from revalidated, not folded into it.
    expect(entry.findingsRevalidated + (entry.findingsLeftOpen ?? 0)).toBe(3)
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

describe('runRevalidate — concurrency', () => {
  it('reviews multiple features in parallel up to --jobs', async () => {
    // Three independent features, each with one open finding and a registered
    // persona. With jobs=3 the worker pool should run all three engine calls
    // concurrently, so the max number of simultaneously-active invocations
    // must exceed 1 (a sequential loop would never overlap).
    for (const id of ['feat-A', 'feat-B', 'feat-C']) {
      await writeFeatureFile(id)
      await writeFinding(tmp, makeRecord({ findingId: `fid-${id}`, featureId: id, persona: 'general' }))
    }

    const jobs = 3
    let active = 0
    let maxActive = 0
    const waiters: Array<() => void> = []
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ openFindings }) => {
      active++
      maxActive = Math.max(maxActive, active)
      // Park until `jobs` workers are concurrently in-flight; the last to arrive
      // releases all of them. Sequential execution never reaches `jobs`, so it
      // deadlocks instead of falsely passing.
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        if (waiters.length >= jobs) waiters.forEach((w) => w())
      })
      active--
      return {
        feature: {} as unknown,
        persona: {} as unknown,
        verdicts: new Map(
          (openFindings as RepoFindingRecord[]).map((f) => [
            f.findingId,
            { findingId: f.findingId, verdict: 'fixed' as const, evidence: 'gone' },
          ]),
        ),
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        truncated: false,
        blockParsed: true,
      }
    })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, jobs: 3, revalidate: true },
    })

    expect(maxActive).toBe(3)
    expect(result.featuresReviewed).toBe(3)
  })

  it('aborts the pool and preserves open findings on a rate-limit error', async () => {
    // feat-A's worker hits a rate limit (429); feat-B resolves normally. The
    // pool must stop scheduling new work, report aborted=true with a
    // rate-limit reason, and leave feat-A's finding untouched on disk.
    await writeFeatureFile('feat-A')
    await writeFeatureFile('feat-B')
    await writeFinding(tmp, makeRecord({ findingId: 'fid-A', featureId: 'feat-A', persona: 'general' }))
    await writeFinding(tmp, makeRecord({ findingId: 'fid-B', featureId: 'feat-B', persona: 'general' }))

    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ feature, openFindings }) => {
      if ((feature as FeatureRecord).featureId === 'feat-A') {
        // isRateLimitError matches `\b429\b` in the message.
        const err = new Error('Model returned an error: 429 rate limit exceeded') as Error & {
          status?: number
        }
        err.status = 429
        throw err
      }
      return buildResult(
        Object.fromEntries(
          (openFindings as RepoFindingRecord[]).map((f) => [f.findingId, 'fixed' as const]),
        ),
      )
    })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, jobs: 2, revalidate: true },
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/rate limit/i)
    // feat-A's finding was never given a verdict — it stays open on disk so a
    // later --revalidate retries it.
    const records = await listFindings(tmp)
    const a = records.find((r) => r.findingId === 'fid-A')
    expect(a?.status).toBe('open')
    expect(a?.revalidationVerdict).toBeUndefined()
    // feat-B's worker ran to completion before the pool stopped scheduling new
    // work, so its finding must be persisted as fixed.
    const bRecord = records.find((r) => r.featureId === 'feat-B')
    expect(bRecord?.status).toBe('fixed')
    expect(bRecord?.revalidationVerdict).toBe('fixed')
  })

  it('stops starting later persona groups of an in-flight feature once a peer worker rate-limits', async () => {
    // feat-multi has two persona groups (general, security); feat-rl has one
    // group that rate-limits immediately. With jobs=2 both features run
    // concurrently. feat-multi's FIRST persona group is held open long enough
    // for feat-rl to throw and request stop; the worker must then NOT start
    // feat-multi's SECOND group, leaving that finding open for retry.
    //
    // The assertions are deliberately independent of which persona group is
    // processed first: listFindings() uses readdir() ordering, which is not
    // guaranteed across filesystems, and groupByFeatureAndPersona preserves
    // that order. We only assert that exactly one of feat-multi's two groups
    // ran and exactly one of its findings stayed open.
    await writeFeatureFile('feat-multi')
    await writeFeatureFile('feat-rl')
    await writeFinding(tmp, makeRecord({ findingId: 'm-gen', featureId: 'feat-multi', persona: 'general' }))
    await writeFinding(tmp, makeRecord({ findingId: 'm-sec', featureId: 'feat-multi', persona: 'security' }))
    await writeFinding(tmp, makeRecord({ findingId: 'rl-1', featureId: 'feat-rl', persona: 'general' }))

    let multiCalls = 0
    const multiPersonasInvoked: string[] = []
    mocks.revalidateFeatureGroupWithAgent.mockImplementation(async ({ feature, persona, openFindings }) => {
      const featureId = (feature as FeatureRecord).featureId
      if (featureId === 'feat-rl') {
        throw new Error('Model returned an error: 429 rate limit exceeded')
      }
      // feat-multi
      multiPersonasInvoked.push((persona as { name: string }).name)
      multiCalls += 1
      if (multiCalls === 1) {
        // Hold the lane open on the FIRST group (whichever persona that is) so
        // feat-rl's worker throws + requestStop() runs before this group
        // resolves and the worker checks the next group.
        await new Promise((r) => setTimeout(r, 30))
      }
      return buildResult(
        Object.fromEntries(
          (openFindings as RepoFindingRecord[]).map((f) => [f.findingId, 'fixed' as const]),
        ),
      )
    })

    const result = await runRevalidate({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, jobs: 2, revalidate: true },
    })

    expect(result.aborted).toBe(true)
    // Exactly one of feat-multi's two persona groups ran; the second was
    // short-circuited once the peer worker requested stop.
    expect(multiPersonasInvoked).toHaveLength(1)
    // Exactly one of feat-multi's findings was verdicted; the other is left
    // open (untouched) for a later run.
    const records = await listFindings(tmp)
    const mGen = records.find((r) => r.findingId === 'm-gen')
    const mSec = records.find((r) => r.findingId === 'm-sec')
    const statuses = [mGen?.status, mSec?.status].sort()
    expect(statuses).toEqual(['fixed', 'open'])
    // The rate-limited feature's finding was never given a verdict — it stays
    // open and untouched for a later run, and the abort reason propagated.
    expect(result.abortReason).toMatch(/rate limit/i)
    const rlRecord = records.find((r) => r.findingId === 'rl-1')
    expect(rlRecord?.status).toBe('open')
    expect(rlRecord?.revalidationVerdict).toBeUndefined()
  })
})
