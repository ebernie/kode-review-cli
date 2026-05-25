/**
 * Tests for orchestrator.ts — the top-level entry point for `--scope repo`.
 *
 * Mocks the boundary functions (clawpatch CLI spawn, engine review call,
 * install detection) so we exercise the orchestration logic without
 * shelling out to clawpatch or calling pi.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks for the orchestrator's boundary functions.
const mocks = vi.hoisted(() => ({
  runClawpatchMap: vi.fn(),
  runClawpatchInit: vi.fn(),
  detectClawpatch: vi.fn(),
  isNodeVersionCompatible: vi.fn(),
  buildNodeUpgradeHint: vi.fn(() => 'Node upgrade required'),
  buildInstallHint: vi.fn(() => 'Install clawpatch'),
  reviewFeatureWithAgent: vi.fn(),
  filterFeaturesBySince: vi.fn(),
}))

vi.mock('../clawpatch-cli.js', () => ({
  runClawpatchMap: mocks.runClawpatchMap,
  runClawpatchInit: mocks.runClawpatchInit,
  // The orchestrator only imports runClawpatchMap and runClawpatchInit,
  // but keep the other exports stubbed so any future use doesn't surprise
  // the test runner.
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
  revalidate: false,
  retryUncertain: false,
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
  mocks.runClawpatchInit.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
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
    expect(mocks.runClawpatchInit).not.toHaveBeenCalled()
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

  it('runs clawpatch init when .clawpatch/ is missing, before map', async () => {
    // Precondition: tmp has no .clawpatch/. Stating it explicitly so the
    // test doesn't silently pass if a future beforeEach starts creating it.
    expect(existsSync(join(tmp, '.clawpatch'))).toBe(false)
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli })
    expect(mocks.runClawpatchInit).toHaveBeenCalledTimes(1)
    expect(mocks.runClawpatchInit).toHaveBeenCalledWith(tmp)
    // Both sides must have run — assert independently so the ordering check
    // below isn't vacuously true if map never executed.
    expect(mocks.runClawpatchMap).toHaveBeenCalledTimes(1)
    const initOrder = mocks.runClawpatchInit.mock.invocationCallOrder[0]
    const mapOrder = mocks.runClawpatchMap.mock.invocationCallOrder[0]
    expect(initOrder).toBeLessThan(mapOrder)
  })

  it('treats a non-zero init exit as success when .clawpatch/ appears (concurrent runner race)', async () => {
    // Simulate the race: our init lost to another runner. The other runner
    // created the dir, so our init exits non-zero ("already initialized"),
    // but we re-check the dir and continue rather than aborting.
    mocks.runClawpatchInit.mockImplementation(async () => {
      await mkdir(join(tmp, '.clawpatch'), { recursive: true })
      return { exitCode: 2, stdout: '', stderr: 'already initialized; use --force' }
    })
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli })
    expect(mocks.runClawpatchInit).toHaveBeenCalledTimes(1)
    expect(mocks.runClawpatchMap).toHaveBeenCalledTimes(1)
  })

  it('skips clawpatch init when .clawpatch/ already exists', async () => {
    // State the precondition directly: the .clawpatch/ dir exists.
    await mkdir(join(tmp, '.clawpatch'), { recursive: true })
    await writeFeatureFile('feat-a')
    mocks.reviewFeatureWithAgent.mockResolvedValue({
      feature: {} as unknown,
      persona: {} as unknown,
      content: '',
      usage: {} as unknown,
      truncated: false,
      findings: [],
    })
    await runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli })
    expect(mocks.runClawpatchInit).not.toHaveBeenCalled()
    expect(mocks.runClawpatchMap).toHaveBeenCalledTimes(1)
  })

  it('aborts if clawpatch init exits non-zero (and never reaches map)', async () => {
    mocks.runClawpatchInit.mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'init boom' })
    await expect(
      runRepoAudit({ repoRoot: tmp, repoUrl: 'https://x.test/r.git', cli: baseCli }),
    ).rejects.toThrow(/clawpatch init failed/)
    expect(mocks.runClawpatchInit).toHaveBeenCalledWith(tmp)
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
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
  it('delegates to runRevalidate (which has its own dedicated test file) and does NOT invoke the audit pipeline', async () => {
    // Seed an open finding so runRevalidate has something to look at. The
    // engine mock is left unconfigured — runRevalidate's own tests cover the
    // happy path; here we only assert delegation does not fall through to
    // the audit pipeline (clawpatch map, reviewFeatureWithAgent).
    const { writeFinding } = await import('../state.js')
    await writeFinding(tmp, {
      schemaVersion: 1,
      findingId: 'seed',
      featureId: 'feat-x',
      persona: 'general',
      status: 'fixed', // already closed → runRevalidate short-circuits, no engine call
      finding: {
        severity: 'LOW', category: 'other', confidence: 'LOW',
        title: 't', file: 'f.ts', lineStart: 1, lineEnd: 1,
        evidence: 'x', problem: 'p', recommendation: 'r',
      },
      createdByRunId: 'r0',
      createdAt: '2026-05-19T10:00:00.000Z',
      updatedAt: '2026-05-19T10:00:00.000Z',
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, revalidate: true },
    })
    // Audit pipeline must not have been engaged.
    expect(mocks.runClawpatchMap).not.toHaveBeenCalled()
    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
    // runRevalidate observed the (closed) seed finding and returned cleanly.
    expect(result.findingsOnDisk).toBe(1)
    expect(result.featuresReviewed).toBe(0)
  })
})

describe('runRepoAudit — concurrency', () => {
  it('reviews features in parallel up to --jobs (no deadlock)', async () => {
    // Three pending features, each dispatching only the general persona
    // (kind 'unknown'), so reviewFeatureWithAgent is called once per feature.
    await writeFeatureFile('feat-1')
    await writeFeatureFile('feat-2')
    await writeFeatureFile('feat-3')

    // Barrier: each invocation parks until all `jobs` invocations are
    // simultaneously in-flight, then they all release together. A sequential
    // implementation can never get 3 in-flight at once → the barrier never
    // releases → the test times out (which is the failure signal). A correct
    // parallel implementation releases instantly.
    const jobs = 3
    let active = 0
    let maxActive = 0
    const waiters: Array<() => void> = []
    mocks.reviewFeatureWithAgent.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        if (waiters.length >= jobs) waiters.forEach((w) => w())
      })
      active--
      return { findings: [], truncated: false }
    })

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
      cli: { ...baseCli, scope: 'repo', jobs: 3 },
    })

    expect(maxActive).toBe(3)
    expect(result.featuresReviewed).toBe(3)
    expect(result.featuresSkipped).toBe(0)
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

  it('stops new work on a rate-limit error and reports aborted=true', async () => {
    // Two single-persona features (kind 'unknown' → general only). Key the
    // outcome on feature identity, not invocation order: with the worker pool
    // feat-x and feat-y may be reviewed concurrently, so we cannot assume which
    // engine call lands first. feat-x succeeds (emits a finding so we can prove
    // partial progress survives); feat-y rate-limits.
    await writeFeatureFile('feat-x')
    await writeFeatureFile('feat-y')

    mocks.reviewFeatureWithAgent.mockImplementation(async ({ feature, persona }) => {
      if (feature.featureId === 'feat-y') {
        throw new Error(
          'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min.',
        )
      }
      return {
        feature,
        persona,
        findings: [
          {
            severity: 'LOW',
            category: 'maintainability',
            confidence: 'HIGH',
            title: 'tidy',
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
      cli: { ...baseCli, jobs: 2 },
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/usage limit|rate.?limit/i)
    // feat-x's finding was persisted before the abort — partial progress
    // survives even though feat-y rate-limited.
    const onDisk = await listFindings(tmp)
    expect(onDisk.map((r) => r.featureId)).toContain('feat-x')
    expect(result.findingsEmitted).toBe(1)
  })

  it('stops dispatching remaining personas of an in-flight feature once a peer hits a rate limit', async () => {
    // feat-multi is a multi-persona feature (service + user-input → general,
    // architect, security). feat-rl rate-limits on its sole persona. With
    // jobs=2 both are dequeued together. We hold feat-multi's FIRST persona
    // (general) in-flight until feat-rl has rate-limited and called
    // requestStop(); after general resolves, the persona loop must observe
    // handle.stopRequested and skip architect + security rather than keep
    // hammering an already-rate-limited provider.
    // Ordering invariant: readFeatures sorts by featureId, and
    // 'feat-multi' < 'feat-rl' alphabetically, so feat-multi is dispatched to
    // lane 0 and feat-rl to lane 1 under jobs:2. The barrier relies on both
    // running concurrently; renaming so the sort reverses would break it.
    await writeFeatureFile('feat-multi', { kind: 'service', trustBoundaries: ['user-input'] })
    await writeFeatureFile('feat-rl')

    let releaseGeneral: (() => void) | null = null
    const generalParked = new Promise<void>((resolve) => {
      releaseGeneral = resolve
    })
    let rlHappened: (() => void) | null = null
    const rlDone = new Promise<void>((resolve) => {
      rlHappened = resolve
    })
    const personasCalledForMulti: string[] = []

    mocks.reviewFeatureWithAgent.mockImplementation(async ({ feature, persona }) => {
      if (feature.featureId === 'feat-rl') {
        rlHappened?.()
        throw new Error(
          'Model returned an error: You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min.',
        )
      }
      // feat-multi
      personasCalledForMulti.push(persona.name)
      if (persona.name === 'general') {
        // Park until the peer feature has rate-limited and set the stop flag.
        await rlDone
        await generalParked
      }
      return {
        feature,
        persona,
        findings: [],
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        truncated: false,
      }
    })

    // Once the rate limit has fired (stop requested), release feat-multi's
    // general persona so the worker proceeds to its between-persona check.
    void rlDone.then(() => releaseGeneral?.())

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli, jobs: 2 },
    })

    expect(result.aborted).toBe(true)
    expect(result.abortReason).toMatch(/usage limit|rate.?limit/i)
    // general ran (it was already in flight); architect + security were
    // skipped because the peer set stopRequested before they were dispatched.
    expect(personasCalledForMulti).toEqual(['general'])
  })

  it('skips a feature when another runner already holds its lock', async () => {
    const { acquireFeatureLock } = await import('../state.js')
    mocks.isNodeVersionCompatible.mockReturnValue(true)
    mocks.detectClawpatch.mockResolvedValue({ installed: true, version: '0.3.0' })
    mocks.runClawpatchMap.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    await writeFeatureFile('feat_locked', { trustBoundaries: ['user-input'], kind: 'service' })

    // Pre-acquire the lock on behalf of a phantom "other runner" so the
    // orchestrator's own acquireFeatureLock call returns null.
    const held = await acquireFeatureLock(tmp, 'feat_locked', 'phantom-run-id')
    expect(held).not.toBeNull()

    const result = await runRepoAudit({
      repoRoot: tmp,
      repoUrl: 'git@example.com:o/r.git',
      cli: { ...baseCli },
    })

    expect(mocks.reviewFeatureWithAgent).not.toHaveBeenCalled()
    expect(result.featuresReviewed).toBe(0)
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
