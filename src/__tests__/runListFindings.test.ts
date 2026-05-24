import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same trick as runRepoScopeAudit.test.ts: src/index.ts calls main() at load,
// which would parseArgs(vitest's argv) and throw. Set argv before any imports.
vi.hoisted(() => {
  process.argv = ['node', 'kode-review', '--show-config']
})

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

import { runListFindings } from '../index.js'
import { writeRepoReport } from '../repo-audit/report.js'
import { writeFinding } from '../repo-audit/state.js'
import { getRepoRoot } from '../vcs/index.js'
import type { CliOptions } from '../cli/args.js'
import type { RepoFindingRecord } from '../repo-audit/types.js'

const BASE_CLI: CliOptions = {
  scope: 'repo',
  format: 'text',
  quiet: false,
  ci: false,
  failOn: 'critical',
  noSuppressions: false,
  reportOnly: false,
  listFindings: true,
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

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kode-runListFindings-'))
  await mkdir(join(root, '.kode-review', 'findings'), { recursive: true })
  return root
}

async function seed(
  repoRoot: string,
  id: string,
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
  status: RepoFindingRecord['status'] = 'open',
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

describe('runListFindings', () => {
  let repoRoot: string
  let exitSpy: MockInstance<(code?: number | string | null) => never>

  beforeEach(async () => {
    repoRoot = await makeRepo()
    vi.mocked(getRepoRoot).mockResolvedValue(repoRoot)
    vi.mocked(writeRepoReport).mockClear()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('exits 1 when not in a git repository', async () => {
    vi.mocked(getRepoRoot).mockResolvedValueOnce(null)
    await expect(runListFindings(BASE_CLI)).rejects.toThrow(/process\.exit\(1\)/)
    expect(writeRepoReport).not.toHaveBeenCalled()
  })

  it('renders all findings when no filters are set', async () => {
    await seed(repoRoot, 'a'.repeat(24), 'CRITICAL')
    await seed(repoRoot, 'b'.repeat(24), 'LOW')
    await runListFindings(BASE_CLI)
    expect(writeRepoReport).toHaveBeenCalledOnce()
    const records = vi.mocked(writeRepoReport).mock.calls[0][0].records
    // Assert IDs, not just length: a regression that swapped records for
    // synthetic entries (or deduplicated incorrectly) would slip past a
    // length-only check.
    expect(records.map((r) => r.findingId).sort()).toEqual(['a'.repeat(24), 'b'.repeat(24)])
  })

  it('filters by --severity', async () => {
    await seed(repoRoot, 'a'.repeat(24), 'CRITICAL')
    await seed(repoRoot, 'b'.repeat(24), 'MEDIUM')
    await seed(repoRoot, 'c'.repeat(24), 'LOW')
    await runListFindings({ ...BASE_CLI, findingsSeverity: ['CRITICAL', 'MEDIUM'] })
    const records = vi.mocked(writeRepoReport).mock.calls[0][0].records
    expect(records.map((r) => r.finding.severity).sort()).toEqual(['CRITICAL', 'MEDIUM'])
  })

  it('filters by --status', async () => {
    await seed(repoRoot, 'a'.repeat(24), 'HIGH', 'open')
    await seed(repoRoot, 'b'.repeat(24), 'HIGH', 'fixed')
    await seed(repoRoot, 'c'.repeat(24), 'HIGH', 'uncertain')
    await runListFindings({ ...BASE_CLI, findingsStatus: ['open', 'uncertain'] })
    const records = vi.mocked(writeRepoReport).mock.calls[0][0].records
    expect(records.map((r) => r.status).sort()).toEqual(['open', 'uncertain'])
  })

  it('intersects --severity and --status filters', async () => {
    await seed(repoRoot, 'a'.repeat(24), 'CRITICAL', 'open')
    await seed(repoRoot, 'b'.repeat(24), 'CRITICAL', 'fixed')
    await seed(repoRoot, 'c'.repeat(24), 'LOW', 'open')
    await runListFindings({
      ...BASE_CLI,
      findingsSeverity: ['CRITICAL'],
      findingsStatus: ['open'],
    })
    const records = vi.mocked(writeRepoReport).mock.calls[0][0].records
    expect(records).toHaveLength(1)
    expect(records[0].findingId).toBe('a'.repeat(24))
  })

  it('skips writeRepoReport on empty-disk result in text mode (prints a hint instead)', async () => {
    // No findings seeded → all.length === 0 branch.
    await runListFindings(BASE_CLI)
    expect(writeRepoReport).not.toHaveBeenCalled()
  })

  it('still writes an artifact for empty results when --output-file is set', async () => {
    // CI/reporting scripts expect a file even on empty results. The friendly
    // hint path must not swallow `--output-file`.
    await runListFindings({ ...BASE_CLI, outputFile: '/tmp/empty-report.txt' })
    expect(writeRepoReport).toHaveBeenCalledOnce()
    const call = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(call.records).toEqual([])
    expect(call.outputFile).toBe('/tmp/empty-report.txt')
  })

  it('skips writeRepoReport when filters exclude every record in text mode', async () => {
    // Findings exist but the filter excludes them all → all.length > 0,
    // filtered.length === 0 branch. Separate test from the empty-disk case
    // so a regression that collapses both branches into one is caught.
    await seed(repoRoot, 'a'.repeat(24), 'CRITICAL')
    await runListFindings({ ...BASE_CLI, findingsSeverity: ['LOW'] })
    expect(writeRepoReport).not.toHaveBeenCalled()
  })

  it('still renders empty result in json mode (consumers expect a parseable payload)', async () => {
    await runListFindings({ ...BASE_CLI, format: 'json' })
    expect(writeRepoReport).toHaveBeenCalledOnce()
    const call = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(call.records).toEqual([])
    // Also assert format is forwarded — a regression that hard-coded 'text'
    // would still produce an empty-records call but silently drop the format.
    expect(call.format).toBe('json')
  })

  it('forwards --format / --output-file / --quiet / --no-suppressions to writeRepoReport', async () => {
    await seed(repoRoot, 'a'.repeat(24), 'HIGH')
    await runListFindings({
      ...BASE_CLI,
      format: 'markdown',
      outputFile: '/tmp/out.md',
      quiet: true,
      noSuppressions: true,
    })
    const call = vi.mocked(writeRepoReport).mock.calls[0][0]
    expect(call.format).toBe('markdown')
    expect(call.outputFile).toBe('/tmp/out.md')
    expect(call.quiet).toBe(true)
    // suppressionsDisabled controls a security-adjacent header note; assert
    // it explicitly so a refactor that drops the forwarding is caught.
    expect(call.suppressionsDisabled).toBe(true)
  })
})
