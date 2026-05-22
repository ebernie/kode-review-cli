import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `src/index.ts` invokes main() at module-load. Under vitest, process.argv is
// vitest's own argv, which parseArgs() rejects — that throws inside main and
// triggers process.exit(1), surfacing as an unhandled rejection that fails
// the run. ESM imports hoist above plain statements, so we set argv inside
// vi.hoisted() which runs before any imports.
vi.hoisted(() => {
  process.argv = ['node', 'kode-review', '--show-config']
})

// Mock everything the function reaches for so we can drive each branch.
vi.mock('../repo-audit/orchestrator.js', () => ({
  runRepoAudit: vi.fn(),
}))
vi.mock('../repo-audit/report.js', () => ({
  writeRepoReport: vi.fn(async () => {}),
}))
vi.mock('../vcs/index.js', () => ({
  getRepoRoot: vi.fn(),
  getRepoUrl: vi.fn(),
  detectPlatform: vi.fn(),
  getCurrentBranch: vi.fn(),
  isGitRepository: vi.fn(),
}))
vi.mock('../indexer/index.js', () => ({
  getIndexerStatus: vi.fn(async () => ({ running: false, apiUrl: null })),
}))

import { runRepoScopeAudit } from '../index.js'
import { runRepoAudit } from '../repo-audit/orchestrator.js'
import { writeRepoReport } from '../repo-audit/report.js'
// `state.js` is intentionally NOT mocked — these tests validate the real
// filesystem round-trip: seeded findings written by `writeFinding` must be
// readable by the real `listFindings` inside `runRepoScopeAudit`. If a future
// refactor routes the listing path through the (mocked) orchestrator instead,
// these tests would silently exercise the mock — re-evaluate the mock graph
// at that point.
import { writeFinding } from '../repo-audit/state.js'
import { getRepoRoot, getRepoUrl } from '../vcs/index.js'
import type { CliOptions } from '../cli/args.js'

// Only the fields runRepoScopeAudit actually reads need real values; the rest
// are filler so the object satisfies the CliOptions interface. We avoid
// re-implementing parseArgs() — the SUT is the contract under test.
const BASE_CLI: CliOptions = {
  scope: 'repo',
  format: 'text',
  quiet: false,
  ci: false,
  failOn: 'critical',
  noSuppressions: false,
  reportOnly: false,
  postToPr: false,
  autoApprove: false,
  initHooks: false,
  reviewers: ['general'],
  listReviewers: false,
  watch: false,
  watchInterval: 60,
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
  contextTopK: 8,
  agentic: false,
  maxIterations: 25,
  agenticTimeout: 300,
  showConfig: false,
  doctor: false,
  update: false,
  installAgentForce: false,
  listAgents: false,
  engine: 'kode-agent',
  remap: false,
  jobs: 1,
  revalidate: false,
  clawpatchCompat: false,
}

const BASE_CTX = { interactive: false, quiet: false }

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kode-runRepoScopeAudit-'))
  await mkdir(join(root, '.kode-review', 'findings'), { recursive: true })
  return root
}

async function seedFinding(
  repoRoot: string,
  id: string,
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
  status: 'open' | 'uncertain' | 'fixed' | 'wont-fix' | 'false-positive' = 'open',
): Promise<void> {
  await writeFinding(repoRoot, {
    schemaVersion: 1,
    findingId: id,
    featureId: 'feat_test',
    persona: 'general',
    status,
    finding: {
      severity,
      category: 'correctness',
      confidence: 'HIGH',
      title: `Seed ${id}`,
      file: 'src/x.ts',
      lineStart: 1,
      lineEnd: 1,
      evidence: 'e',
      problem: 'p',
      recommendation: 'r',
    },
    createdByRunId: 'run-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

describe('runRepoScopeAudit', () => {
  let repoRoot: string
  let exitSpy: MockInstance<(code?: number | string | null) => never>

  beforeEach(async () => {
    repoRoot = await makeRepo()
    vi.mocked(getRepoRoot).mockResolvedValue(repoRoot)
    vi.mocked(getRepoUrl).mockResolvedValue('https://example.com/foo.git')
    vi.mocked(runRepoAudit).mockReset()
    vi.mocked(writeRepoReport).mockClear()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('throws when not in a git repository', async () => {
    vi.mocked(getRepoRoot).mockResolvedValueOnce(null)
    await expect(runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')).rejects.toThrow(/Not in a git repository/)
  })

  it('calls runRepoAudit with repoRoot/repoUrl/branch/cli', async () => {
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 0,
    })
    await runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')
    expect(runRepoAudit).toHaveBeenCalledOnce()
    const arg = vi.mocked(runRepoAudit).mock.calls[0][0]
    expect(arg.repoRoot).toBe(repoRoot)
    expect(arg.repoUrl).toBe('https://example.com/foo.git')
    expect(arg.branch).toBe('main')
    // Assert field-level forwarding, not reference equality: a future shallow-copy
    // wrap of options must not break the contract test.
    expect(arg.cli.scope).toBe('repo')
    expect(arg.cli.failOn).toBe('critical')
    expect(arg.cli.reportOnly).toBe(false)
    expect(arg.cli.ci).toBe(false)
  })

  it('renders findings on success', async () => {
    await seedFinding(repoRoot, 'a'.repeat(24), 'MEDIUM')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 1, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')
    expect(writeRepoReport).toHaveBeenCalledOnce()
    const renderArg = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(renderArg.records).toHaveLength(1)
    expect(renderArg.records[0].finding.severity).toBe('MEDIUM')
  })

  it('renders on-disk findings even when runRepoAudit throws, then rethrows', async () => {
    await seedFinding(repoRoot, 'b'.repeat(24), 'HIGH')
    const boom = new Error('clawpatch map failed')
    vi.mocked(runRepoAudit).mockRejectedValue(boom)

    await expect(runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')).rejects.toThrow('clawpatch map failed')

    expect(writeRepoReport).toHaveBeenCalledOnce()
    const renderArg = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(renderArg.records).toHaveLength(1)
    expect(renderArg.records[0].finding.severity).toBe('HIGH')
  })

  it('proceeds without throwing when repoUrl is missing (warning path)', async () => {
    vi.mocked(getRepoUrl).mockResolvedValueOnce(null)
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 0, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 0,
    })
    await expect(runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')).resolves.toBeUndefined()
    expect(runRepoAudit).toHaveBeenCalledOnce()
    expect(vi.mocked(runRepoAudit).mock.calls[0][0].repoUrl).toBe('')
  })

  it('forwards format/output-file/quiet/suppressionsDisabled to writeRepoReport', async () => {
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 0, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 0,
    })
    await runRepoScopeAudit(
      { ...BASE_CLI, format: 'markdown', outputFile: '/tmp/out.md', quiet: true, noSuppressions: true },
      BASE_CTX,
      'main',
    )
    const renderArg = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(renderArg.format).toBe('markdown')
    expect(renderArg.outputFile).toBe('/tmp/out.md')
    expect(renderArg.quiet).toBe(true)
    expect(renderArg.suppressionsDisabled).toBe(true)
  })

  it('CI mode: exits 1 when a CRITICAL finding is open and failOn=critical, rendering first', async () => {
    await seedFinding(repoRoot, 'c'.repeat(24), 'CRITICAL')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 1, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'critical' }, BASE_CTX, 'main'),
    ).rejects.toThrow(/process\.exit\(1\)/)
    // Render MUST happen before exit so users see findings in CI logs.
    expect(writeRepoReport).toHaveBeenCalledOnce()
  })

  it('CI mode: does NOT exit when only MEDIUM findings exist and failOn=critical', async () => {
    await seedFinding(repoRoot, 'd'.repeat(24), 'MEDIUM')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 1, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'critical' }, BASE_CTX, 'main'),
    ).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('CI mode with failOn=high: exits 1 on HIGH findings too, rendering first', async () => {
    await seedFinding(repoRoot, 'e'.repeat(24), 'HIGH')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 1, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'high' }, BASE_CTX, 'main'),
    ).rejects.toThrow(/process\.exit\(1\)/)
    expect(writeRepoReport).toHaveBeenCalledOnce()
  })

  it('CI mode with failOn=none: never exits but still renders', async () => {
    await seedFinding(repoRoot, 'f'.repeat(24), 'CRITICAL')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 1, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'none' }, BASE_CTX, 'main'),
    ).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
    // Even with failOn=none, rendering must still happen — otherwise a silent
    // early-return regression would pass this test undetected.
    expect(writeRepoReport).toHaveBeenCalledOnce()
  })

  // ── CI fail-on gate vs `uncertain` status ─────────────────────────────────
  //
  // Regression: an `uncertain` CRITICAL finding (set by --revalidate when the
  // agent can't determine whether the issue is fixed) must STILL trigger the
  // CI fail-on gate. The agent gave up, so a human must look — letting CI
  // pass would silently bypass --fail-on critical.

  it('CI mode: exits 1 when an UNCERTAIN CRITICAL finding exists and failOn=critical', async () => {
    await seedFinding(repoRoot, 'u'.repeat(24), 'CRITICAL', 'uncertain')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'critical' }, BASE_CTX, 'main'),
    ).rejects.toThrow(/process\.exit\(1\)/)
    expect(writeRepoReport).toHaveBeenCalledOnce()
  })

  it('CI mode: exits 1 when an UNCERTAIN HIGH finding exists and failOn=high', async () => {
    await seedFinding(repoRoot, 'v'.repeat(24), 'HIGH', 'uncertain')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'high' }, BASE_CTX, 'main'),
    ).rejects.toThrow(/process\.exit\(1\)/)
  })

  it('CI mode: does NOT exit on a FIXED CRITICAL finding with failOn=critical (true closed state)', async () => {
    await seedFinding(repoRoot, 'w'.repeat(24), 'CRITICAL', 'fixed')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'critical' }, BASE_CTX, 'main'),
    ).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('CI mode: does NOT exit on an UNCERTAIN MEDIUM finding with failOn=critical (severity below threshold)', async () => {
    await seedFinding(repoRoot, 'x'.repeat(24), 'MEDIUM', 'uncertain')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'critical' }, BASE_CTX, 'main'),
    ).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('CI mode with failOn=none: does NOT exit even on an UNCERTAIN CRITICAL', async () => {
    await seedFinding(repoRoot, 'y'.repeat(24), 'CRITICAL', 'uncertain')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 1, featuresSkipped: 0, findingsEmitted: 0, findingsSuppressed: 0, findingsOnDisk: 1,
    })
    await expect(
      runRepoScopeAudit({ ...BASE_CLI, ci: true, failOn: 'none' }, BASE_CTX, 'main'),
    ).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('aborted result still renders the on-disk finding and does not throw', async () => {
    await seedFinding(repoRoot, '0'.repeat(24), 'HIGH')
    vi.mocked(runRepoAudit).mockResolvedValue({
      featuresReviewed: 5, featuresSkipped: 0, findingsEmitted: 3, findingsSuppressed: 0, findingsOnDisk: 3,
      aborted: true, abortReason: 'rate limit hit',
    })
    await expect(runRepoScopeAudit(BASE_CLI, BASE_CTX, 'main')).resolves.toBeUndefined()
    expect(writeRepoReport).toHaveBeenCalledOnce()
    const renderArg = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(renderArg.records).toHaveLength(1)
    expect(renderArg.records[0].finding.severity).toBe('HIGH')
  })
})
