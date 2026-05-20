/**
 * Regression test for the indexer-status compose-file fix.
 *
 * Background: `isIndexerRunning` and `getIndexerStatus` previously called
 * `docker compose -p <project> ...` directly. Without `-f <compose.yaml>`
 * (and a matching `cwd`), `docker compose` can't find the compose file when
 * the caller is outside the indexer config directory — so the status check
 * incorrectly reports "not running" and triggers restarts / context skips.
 *
 * The fix routes both through the shared `dockerCompose` helper, which
 * injects `-f` + `cwd`. This test pins that invariant: a call to
 * `isIndexerRunning` must result in an `exec` invocation that includes
 * `-f .../compose.yaml`, regardless of the test's own cwd.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execCalls: Array<{ cmd: string; args: string[]; opts: any }> = []

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(async (cmd: string, args: string[], opts?: any) => {
    execCalls.push({ cmd, args, opts: opts ?? {} })
    // Default: pretend `docker compose ps -q` returned no running containers.
    return { exitCode: 0, stdout: '', stderr: '' }
  }),
  execInteractive: vi.fn(async () => 0),
}))

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  isIndexerRunning,
  getIndexerStatus,
  getDockerAssetsCandidates,
  BUNDLED_DOCKER_ASSETS,
} from '../docker.js'

beforeEach(() => {
  execCalls.length = 0
})

describe('isIndexerRunning / getIndexerStatus — compose file injection', () => {
  it('isIndexerRunning routes through dockerCompose (includes -f compose.yaml + cwd)', async () => {
    await isIndexerRunning()

    expect(execCalls.length).toBeGreaterThan(0)
    const call = execCalls[0]
    expect(call.cmd).toBe('docker')
    // Critical assertion: `-f <path>/compose.yaml` must be present so the
    // command works regardless of the test's own cwd. The previous bug was
    // exactly the absence of this flag.
    const fIdx = call.args.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(call.args[fIdx + 1]).toMatch(/compose\.yaml$/)
    // And dockerCompose passes its computed config dir as cwd.
    expect(typeof call.opts.cwd).toBe('string')
    expect(call.opts.cwd.length).toBeGreaterThan(0)
    // Subcommand stays `ps -q` — we only changed the routing.
    expect(call.args).toContain('ps')
    expect(call.args).toContain('-q')
  })

  it('getIndexerStatus initial ps call also includes -f compose.yaml', async () => {
    await getIndexerStatus()

    // Lock the assumption that getIndexerStatus makes exactly one `exec`
    // call (the JSON `ps`). The health check goes through IndexerClient
    // (HTTP), not exec. If a future refactor routes the health check
    // through exec, this `length === 1` assertion fails — preventing the
    // index-based [0] check below from silently asserting on the wrong call.
    expect(execCalls.length).toBe(1)
    const call = execCalls[0]
    expect(call.cmd).toBe('docker')
    const fIdx = call.args.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(call.args[fIdx + 1]).toMatch(/compose\.yaml$/)
    expect(call.args).toContain('ps')
    expect(call.args).toContain('--format')
    expect(call.args).toContain('json')
  })
})

/**
 * Regression test for the Docker asset path lookup hardening (D-4b).
 *
 * Before: getDockerAssetsPath consulted process.cwd()-derived locations
 * (`<cwd>/src/indexer/docker`, `<cwd>/dist/indexer/docker`) as a fallback.
 * A user who ran `kode-review` inside an attacker-controlled repository
 * that happened to contain those paths would hand the attacker's
 * compose.yaml to `docker compose -f` — an untrusted code-execution path.
 *
 * The fix removes those entries. This test pins the invariant by asserting
 * that no candidate path begins with the current working directory.
 */
describe('getDockerAssetsCandidates — cwd fallback rejection', () => {
  it('returns exactly four __dirname-rooted candidates (no cwd fallback entries)', () => {
    // Pre-fix the list had six entries: four __dirname-rooted plus two
    // appended from process.cwd(). The hardening drops the cwd-rooted
    // pair. A length assertion catches re-introduction either as a
    // direct cwd join or as any other cwd-derived expression.
    //
    // We can't assert that no candidate path *starts with* cwd, because
    // in a dev checkout __dirname itself sits under cwd (the four
    // legitimate entries collide with the removed-cwd path by
    // coincidence). The cwd-invariance test below proves the candidates
    // are not derived from cwd; this test pins the length.
    const candidates = getDockerAssetsCandidates()
    expect(candidates).toHaveLength(4)
  })

  it('is cwd-invariant — changing process.cwd() must not change the result', async () => {
    // Stronger property than just "cwd not in the list": the entire
    // candidate list must derive solely from __dirname. Capture the list,
    // chdir to a temp directory, capture again, restore — and assert
    // equality. A regression that pulled any path off process.cwd() would
    // produce a different second list.
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const before = [...getDockerAssetsCandidates()]
    const origCwd = process.cwd()
    const stash = mkdtempSync(join(tmpdir(), 'kr-docker-cwd-'))
    try {
      process.chdir(stash)
      const after = [...getDockerAssetsCandidates()]
      expect(after).toEqual(before)
    } finally {
      process.chdir(origCwd)
      rmSync(stash, { recursive: true, force: true })
    }
  })

  it('returns __dirname-rooted module-relative paths', () => {
    const candidates = getDockerAssetsCandidates()
    // Every candidate should end with `docker` — the assets-folder marker.
    // A regression that returned something else entirely would silently
    // fail the existsSync check at runtime.
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate).toMatch(/docker$/)
    }
  })
})

/**
 * Regression test for the cleanup-vs-bundled drift (D-4c).
 *
 * `ensureDockerAssets` copies a list of files in; `cleanupIndexer` used to
 * carry an inline list that drifted (call_graph.py, config_parser.py,
 * .env.template were missing from cleanup). The fix derives both halves
 * from `BUNDLED_DOCKER_ASSETS`. This test pins:
 *   - the constant contains the three files that were previously dropped
 *   - it does NOT contain `.env` (which is generated, not copied)
 *   - it has no duplicates
 */
/**
 * Pin the full BUNDLED_DOCKER_ASSETS set with an explicit expected list
 * so drift is caught in BOTH directions: a file added to one usage site
 * without the other, or a file removed from the constant that the docker
 * assets directory still ships.
 */
const EXPECTED_BUNDLED_DOCKER_ASSETS: readonly string[] = [
  'compose.yaml',
  'Dockerfile',
  'main.py',
  'indexer.py',
  'incremental.py',
  'cocoindex_flow.py',
  'ast_chunker.py',
  'migrate.py',
  'schema.sql',
  'requirements.txt',
  'verify_export.py',
  'import_graph.py',
  'hybrid.py',
  'bm25.py',
  'call_graph.py',
  'config_parser.py',
  '.env.template',
]

describe('BUNDLED_DOCKER_ASSETS — cleanup/ensure parity', () => {
  it('matches the full expected set exactly (catches additions and deletions)', () => {
    // toEqual on a sorted snapshot — pins both presence (regression catches
    // a deletion) and absence-of-strays (catches a junk entry being added).
    // The sort tolerates ordering changes; the content equality catches drift.
    const sortedActual = [...BUNDLED_DOCKER_ASSETS].sort()
    const sortedExpected = [...EXPECTED_BUNDLED_DOCKER_ASSETS].sort()
    expect(sortedActual).toEqual(sortedExpected)
  })

  it('includes the three asset files that were previously dropped on cleanup', () => {
    // Redundant with the full-set test above but kept as a named regression
    // anchor for the original D-4c finding (`call_graph.py`,
    // `config_parser.py`, `.env.template` were missing from cleanup).
    expect(BUNDLED_DOCKER_ASSETS).toContain('call_graph.py')
    expect(BUNDLED_DOCKER_ASSETS).toContain('config_parser.py')
    expect(BUNDLED_DOCKER_ASSETS).toContain('.env.template')
  })

  it('does not include the generated .env file (that is added only on cleanup)', () => {
    expect(BUNDLED_DOCKER_ASSETS).not.toContain('.env')
  })

  it('has no duplicate entries', () => {
    const seen = new Set<string>()
    for (const f of BUNDLED_DOCKER_ASSETS) {
      expect(seen.has(f), `duplicate asset: ${f}`).toBe(false)
      seen.add(f)
    }
  })
})
