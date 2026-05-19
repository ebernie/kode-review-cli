/**
 * Tests for orchestrator.ts — the top-level entry point for `--scope repo`.
 *
 * Mocks the boundary functions (clawpatch CLI spawn, engine review call,
 * install detection) so we exercise the orchestration logic without
 * shelling out to clawpatch or calling pi.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks for the orchestrator's boundary functions.
const mocks = vi.hoisted(() => ({
  runClawpatchMap: vi.fn(),
  detectClawpatch: vi.fn(),
  isNodeVersionCompatible: vi.fn(),
  buildNodeUpgradeHint: vi.fn(() => 'Node upgrade required'),
  buildInstallHint: vi.fn(() => 'Install clawpatch'),
  reviewFeatureWithAgent: vi.fn(),
  filterFeaturesBySince: vi.fn(),
}))

vi.mock('../clawpatch-cli.js', () => ({
  runClawpatchMap: mocks.runClawpatchMap,
  // The orchestrator only imports runClawpatchMap, but keep the other
  // exports stubbed so any future use doesn't surprise the test runner.
  runClawpatch: vi.fn(),
  runClawpatchDoctor: vi.fn(),
}))

vi.mock('../install.js', () => ({
  detectClawpatch: mocks.detectClawpatch,
  isNodeVersionCompatible: mocks.isNodeVersionCompatible,
  buildNodeUpgradeHint: mocks.buildNodeUpgradeHint,
  buildInstallHint: mocks.buildInstallHint,
}))

vi.mock('../engines/kode-agent.js', () => ({
  reviewFeatureWithAgent: mocks.reviewFeatureWithAgent,
}))

vi.mock('../feature-filter.js', () => ({
  filterFeaturesBySince: mocks.filterFeaturesBySince,
  // touchedFilesSince is also exported by the module; stub for completeness.
  touchedFilesSince: vi.fn(),
}))

import type { CliOptions } from '../../cli/args.js'
import { runRepoAudit } from '../orchestrator.js'
import { ensureStateDirs, listFindings } from '../state.js'

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
  revalidate: false,
  clawpatchCompat: false,
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-orch-'))
  for (const m of Object.values(mocks)) {
    if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset()
  }
  // Sensible defaults: env is healthy, clawpatch is installed. The two
  // hint builders are pure string helpers used in throw messages — re-bind
  // their fixed return values since mockReset cleared them.
  mocks.isNodeVersionCompatible.mockReturnValue(true)
  mocks.detectClawpatch.mockResolvedValue({ installed: true, version: 'clawpatch 0.3.0' })
  mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  mocks.buildNodeUpgradeHint.mockReturnValue('Node upgrade required')
  mocks.buildInstallHint.mockReturnValue('Install clawpatch')
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
    // Default to 'unknown' so the default persona set is just ['general'].
    // Tests that want to exercise architect/security/test-auditor dispatch
    // override this via the second argument.
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

describe('runRepoAudit — gates', () => {
  it('rejects when Node version is below the minimum', async () => {
    mocks.isNodeVersionCompatible.mockReturnValue(false)
    await expect(
      runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli }),
    ).rejects.toThrow('Node upgrade required')
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
  })

  it('rejects when clawpatch is not on PATH', async () => {
    mocks.detectClawpatch.mockResolvedValue({ installed: false, version: null })
    await expect(
      runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli }),
    ).rejects.toThrow('Install clawpatch')
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
  })

  it('does NOT invoke clawpatch in --report-only mode', async () => {
    await ensureStateDirs(tmp)
    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reportOnly: true },
    })
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
    expect(mocks.detectClawpatch).not.toHaveBeenCalled()
    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
    expect(result.featuresReviewed).toBe(0)
  })

  it('aborts if clawpatch map exits non-zero', async () => {
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'boom' })
    await expect(
      runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli }),
    ).rejects.toThrow(/clawpatch map failed/)
    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
  })
})

describe('runRepoAudit — happy path', () => {
  it('reviews each pending feature, persists findings, and reports counts', async () => {
    await writeFeatureFile('feat-a')
    await writeFeatureFile('feat-b')
    mocks.reviewFeatureWithAgent.mockImplementation(async ({ feature, persona }) => ({
      feature,
      persona,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [
        {
          severity: 'HIGH',
          category: 'security',
          confidence: 'HIGH',
          title: `issue in ${feature.featureId}`,
          file: 'src/foo.ts',
          lineStart: 1,
          lineEnd: 1,
          evidence: 'x',
          problem: 'p',
          recommendation: 'r',
        },
      ],
    }))

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.featuresReviewed).toBe(2)
    expect(result.findingsEmitted).toBe(2)
    // findingsOnDisk should reflect the total post-write count, not just
    // the new emissions — guards against a future regression where the
    // post-run count is misreported.
    expect(result.findingsOnDisk).toBe(2)
    const onDisk = await listFindings(tmp)
    expect(onDisk).toHaveLength(2)
    expect(onDisk.map((r) => r.featureId).sort()).toEqual(['feat-a', 'feat-b'])
  })

  it('passes --force to clawpatch map when --remap is set', async () => {
    await writeFeatureFile('feat-a')
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, remap: true },
    })
    expect(mocks.runClawpatchMap).toHaveBeenCalledWith(tmp, { force: true })
  })

  it('skips features that already have findings on disk (unless --remap)', async () => {
    await writeFeatureFile('feat-a')
    await writeFeatureFile('feat-b')
    // Seed an existing finding for feat-a → it should be skipped.
    await ensureStateDirs(tmp)
    await writeFile(
      join(tmp, '.kode-review', 'findings', 'seed.json'),
      JSON.stringify({
        schemaVersion: 1,
        findingId: 'seed',
        featureId: 'feat-a',
        persona: 'general',
        status: 'open',
        finding: {
          severity: 'LOW', category: 'other', confidence: 'LOW',
          title: 't', file: 'f.ts', lineStart: 1, lineEnd: 1,
          evidence: 'x', problem: 'p', recommendation: 'r',
        },
        createdByRunId: 'r0',
        createdAt: '2026-05-19T10:00:00.000Z',
        updatedAt: '2026-05-19T10:00:00.000Z',
      }),
    )
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.featuresReviewed).toBe(1)
    expect(result.featuresSkipped).toBe(1)
    // reviewFeatureWithAgent should have been called for feat-b only.
    const calledFor = mocks.reviewFeatureWithAgent.mock.calls.map((c) => c[0].feature.featureId)
    expect(calledFor).toEqual(['feat-b'])
  })

  it('runs every persona returned by persona-dispatch for each feature', async () => {
    // A library feature with user-input boundary → general + architect + security
    await writeFeatureFile('feat-service', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    const personas = mocks.reviewFeatureWithAgent.mock.calls.map((c) => c[0].persona.name)
    expect(personas.sort()).toEqual(['architect', 'general', 'security'])
  })

  it('suppresses findings matched by `kode-review: ignore` markers', async () => {
    // `kind: 'unknown'` triggers only the general persona — keeps the mock
    // simple (one call) and lets us assert exact suppression counts.
    await writeFeatureFile('feat-a', { kind: 'unknown' })
    await writeFile(join(tmp, 'src.ts'), 'const x = 1 // kode-review: ignore\n')
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [
        {
          severity: 'HIGH', category: 'security', confidence: 'HIGH',
          title: 't', file: 'src.ts', lineStart: 1, lineEnd: 1,
          evidence: 'x', problem: 'p', recommendation: 'r',
        },
      ],
    })
    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.findingsSuppressed).toBe(1)
    expect(result.findingsEmitted).toBe(0)
  })

  it('--no-suppressions disables the structured filter', async () => {
    await writeFeatureFile('feat-a', { kind: 'unknown' })
    await writeFile(join(tmp, 'src.ts'), 'const x = 1 // kode-review: ignore\n')
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [
        {
          severity: 'HIGH', category: 'security', confidence: 'HIGH',
          title: 't', file: 'src.ts', lineStart: 1, lineEnd: 1,
          evidence: 'x', problem: 'p', recommendation: 'r',
        },
      ],
    })
    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, noSuppressions: true },
    })
    expect(result.findingsSuppressed).toBe(0)
    expect(result.findingsEmitted).toBe(1)
  })
})

describe('runRepoAudit — --since filtering', () => {
  it('passes the supplied ref to filterFeaturesBySince and only reviews matched features', async () => {
    await writeFeatureFile('feat-touched')
    await writeFeatureFile('feat-untouched')
    // Mocked filter returns only feat-touched.
    mocks.filterFeaturesBySince.mockResolvedValue({
      matched: [
        {
          schemaVersion: 1, featureId: 'feat-touched', title: 't', summary: 's',
          kind: 'unknown', source: 'heuristic', confidence: 'high',
          entrypoints: [], ownedFiles: [], contextFiles: [], tests: [], tags: [],
          trustBoundaries: [], status: 'pending',
          createdAt: '2026-05-18T10:00:00.000Z', updatedAt: '2026-05-18T10:00:00.000Z',
        },
      ],
      touchedFiles: ['x.ts'],
    })
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })

    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, since: 'origin/main' },
    })

    expect(mocks.filterFeaturesBySince).toHaveBeenCalledOnce()
    const filterCall = mocks.filterFeaturesBySince.mock.calls[0]
    expect(filterCall?.[2]).toBe('origin/main')
    const reviewed = mocks.reviewFeatureWithAgent.mock.calls.map((c) => c[0].feature.featureId)
    expect(reviewed).toEqual(['feat-touched'])
  })

  it('does NOT call filterFeaturesBySince when --since is not provided', async () => {
    await writeFeatureFile('feat-a')
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(mocks.filterFeaturesBySince).not.toHaveBeenCalled()
  })
})

describe('runRepoAudit — --revalidate', () => {
  it('throws a clear "not yet implemented" error rather than silently running a full audit', async () => {
    await expect(
      runRepoAudit({
        repoRoot: tmp,
        repoUrl: 'https://x.test/r.git',
        cli: { ...baseCli, revalidate: true },
      }),
    ).rejects.toThrow(/--revalidate is not yet implemented/)
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
  })
})

describe('runRepoAudit — edge cases', () => {
  it('returns zero counts when clawpatch maps no features', async () => {
    // No feature files written.
    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: baseCli,
    })
    expect(result.featuresReviewed).toBe(0)
    expect(result.findingsEmitted).toBe(0)
    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
  })

  it('treats `--reviewer general` (the default) as auto-dispatch, not as an override', async () => {
    // A service with security boundaries: auto-dispatch picks general +
    // architect + security. If the default `['general']` were treated as an
    // explicit override, only general would run.
    await writeFeatureFile('feat-a', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reviewers: ['general'] },
    })
    const personas = mocks.reviewFeatureWithAgent.mock.calls.map((c) => c[0].persona.name)
    expect(personas).toContain('security')
    expect(personas).toContain('architect')
  })

  it('honors an explicit reviewer override that differs from the default', async () => {
    await writeFeatureFile('feat-a', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, reviewers: ['security'] },
    })
    const personas = mocks.reviewFeatureWithAgent.mock.calls.map((c) => c[0].persona.name)
    // Override is verbatim — no auto-dispatch — so only security ran.
    expect(personas).toEqual(['security'])
  })

  it('continues to the next persona when one persona throws a non-rate-limit error', async () => {
    // kind=service + user-input boundary → general + architect + security (3 personas).
    await writeFeatureFile('feat-a', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })

    let callCount = 0
    mocks.reviewFeatureWithAgent.mockImplementation(async ({ persona }) => {
      callCount += 1
      if (persona.name === 'security') {
        throw new Error('Some weird transient blip')
      }
      return {
        feature: undefined,
        persona,
        findings: [
          {
            severity: 'LOW',
            category: 'maintainability',
            confidence: 'HIGH',
            title: `tidy from ${persona.name}`,
            file: 'src/foo.ts',
            lineStart: 1,
            lineEnd: 1,
            evidence: 'foo',
            problem: 'p',
            recommendation: 'r',
          },
        ],
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        truncated: false,
      }
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli },
    })

    // All 3 personas were dispatched; security threw, general + architect
    // each emitted one finding.
    expect(callCount).toBe(3)
    expect(result.featuresReviewed).toBe(1)
    expect(result.findingsEmitted).toBe(2)
    expect(result.aborted).toBeFalsy()
  })

  it('breaks the loop on a rate-limit error and reports aborted=true', async () => {
    // Two features, each dispatching 3 personas (general/architect/security).
    await writeFeatureFile('feat-x', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })
    await writeFeatureFile('feat-y', {
      kind: 'service',
      trustBoundaries: ['user-input'],
    })

    let call = 0
    mocks.reviewFeatureWithAgent.mockImplementation(async ({ persona }) => {
      call += 1
      if (call === 1) {
        return {
          feature: undefined,
          persona,
          findings: [],
          content: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
          truncated: false,
        }
      }
      throw new Error(
        'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min.',
      )
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli },
    })

    // Loop broke after the rate-limit fired on the second persona of feat-x —
    // exactly 2 calls (success + rate-limit) and exactly 1 feature touched.
    // Tight equality catches any regression that delays the break.
    expect(call).toBe(2)
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/usage limit|rate.?limit/i)
    expect(result.featuresReviewed).toBe(1)
  })

  it('--report-only short-circuits before Node/clawpatch gates fire', async () => {
    // Even on a broken environment (incompatible Node, no clawpatch), report-only
    // must list the findings already on disk — that's the whole point of the flag.
    mocks.isNodeVersionCompatible.mockReturnValue(false)
    mocks.detectClawpatch.mockResolvedValue({ installed: false, version: null })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli, reportOnly: true },
    })

    expect(result.featuresReviewed).toBe(0)
    expect(result.findingsOnDisk).toBe(0)
    expect(mocks.isNodeVersionCompatible).not.toHaveBeenCalled()
    expect(mocks.detectClawpatch).not.toHaveBeenCalled()
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
  })
})
