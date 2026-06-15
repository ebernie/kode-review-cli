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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const configMockState = vi.hoisted(() => ({
  configPath: '/tmp/kode-review-docker-test/config.json',
}))

interface MockExecOptions extends Record<string, unknown> {
  cwd?: string
  env?: Record<string, string>
}

const execCalls: Array<{ cmd: string; args: string[]; opts: MockExecOptions }> = []
const execResponses: Array<{ exitCode: number; stdout: string; stderr: string }> = []

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(async (cmd: string, args: string[], opts?: MockExecOptions) => {
    execCalls.push({ cmd, args, opts: opts ?? {} })
    const response = execResponses.shift()
    if (response) return response
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

vi.mock('../../config/index.js', () => ({
  getConfigPath: vi.fn(() => configMockState.configPath),
  getConfig: vi.fn(() => ({
    indexer: {
      apiPort: 8321,
      dbPort: 5436,
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      chunkSize: 1000,
      chunkOverlap: 300,
      composeProject: 'kode-review-indexer-test',
    },
  })),
}))

import {
  isIndexerRunning,
  getIndexerStatus,
  getDockerAssetsCandidates,
  BUNDLED_DOCKER_ASSETS,
  startIndexer,
} from '../docker.js'
import { INDEXER_API_SECRET_HEADER, INDEXER_ENV_FILE, parseEnvContent } from '../env.js'

let tempConfigRoot: string | undefined
let originalFetch: typeof global.fetch

beforeEach(() => {
  execCalls.length = 0
  execResponses.length = 0
  originalFetch = global.fetch
  tempConfigRoot = mkdtempSync(join(tmpdir(), 'kr-docker-test-'))
  configMockState.configPath = join(tempConfigRoot, 'config.json')
})

afterEach(() => {
  global.fetch = originalFetch
  vi.useRealTimers()
  if (tempConfigRoot) {
    rmSync(tempConfigRoot, { recursive: true, force: true })
    tempConfigRoot = undefined
  }
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
    const cwd = call.opts.cwd
    expect(typeof cwd).toBe('string')
    expect(cwd?.length).toBeGreaterThan(0)
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

  it('isIndexerRunning stops legacy running containers when env credentials are upgraded', async () => {
    const indexerDir = join(dirname(configMockState.configPath), 'indexer')
    mkdirSync(indexerDir, { recursive: true })
    writeFileSync(
      join(indexerDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
      ].join('\n') + '\n'
    )
    execResponses.push({ exitCode: 0, stdout: 'container-id\n', stderr: '' })

    await expect(isIndexerRunning()).resolves.toBe(false)

    const downCall = execCalls.find((call) => call.args.includes('down'))
    expect(downCall).toBeDefined()
    expect(downCall?.args).not.toContain('--volumes')
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
  'api_auth.py',
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
    expect(BUNDLED_DOCKER_ASSETS).toContain('api_auth.py')
  })

  it('keeps tsup Docker asset copy list in sync for API auth runtime module', () => {
    const tsupConfig = readFileSync(new URL('../../../tsup.config.ts', import.meta.url), 'utf-8')

    expect(tsupConfig).toContain("'api_auth.py'")
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

describe('bundled Docker assets — local-only authenticated indexer', () => {
  const readAsset = (name: string) => readFileSync(new URL(`../docker/${name}`, import.meta.url), 'utf-8')

  function extractPortMappings(compose: string): string[] {
    const ports: string[] = []
    let inPortsBlock = false
    for (const line of compose.split(/\r?\n/)) {
      if (/^\s{4}ports:\s*$/.test(line)) {
        inPortsBlock = true
        continue
      }
      if (inPortsBlock && /^\s{4}\S/.test(line)) {
        inPortsBlock = false
      }
      if (!inPortsBlock) continue

      const match = line.match(/^\s*-\s+"?([^"]+)"?\s*$/)
      if (match) {
        ports.push(match[1])
      }
    }
    return ports
  }

  it('binds Postgres and API ports to localhost only', () => {
    const compose = readAsset('compose.yaml')
    const ports = extractPortMappings(compose)

    expect(compose).toContain('"127.0.0.1:${KODE_REVIEW_DB_PORT:-5436}:5432"')
    expect(compose).toContain('"127.0.0.1:${KODE_REVIEW_API_PORT:-8321}:8000"')
    expect(ports).toEqual([
      '127.0.0.1:${KODE_REVIEW_DB_PORT:-5436}:5432',
      '127.0.0.1:${KODE_REVIEW_API_PORT:-8321}:8000',
    ])
    expect(ports.every((port) => port.startsWith('127.0.0.1:'))).toBe(true)
  })

  it('uses generated credentials instead of the old hardcoded DB URL', () => {
    const compose = readAsset('compose.yaml')
    const template = readAsset('.env.template')

    expect(compose).not.toContain('cocoindex:cocoindex')
    expect(template).not.toContain('cocoindex:cocoindex')
    expect(compose).toContain('POSTGRES_PASSWORD: ${KODE_REVIEW_DB_PASSWORD}')
    expect(compose).toContain('COCOINDEX_DATABASE_URL=${COCOINDEX_DATABASE_URL}')
    expect(template).toContain('KODE_REVIEW_DB_PASSWORD=')
  })

  it('propagates the API secret to the container and Docker healthcheck', () => {
    const compose = readAsset('compose.yaml')
    const dockerfile = readAsset('Dockerfile')

    expect(compose).toContain('KODE_REVIEW_INDEXER_API_SECRET=${KODE_REVIEW_INDEXER_API_SECRET}')
    expect(dockerfile).toContain('COPY api_auth.py .')
    expect(dockerfile).toContain('x-kode-review-indexer-secret')
    expect(dockerfile).toContain('KODE_REVIEW_INDEXER_API_SECRET')
  })

  it('includes FastAPI middleware that rejects missing or invalid shared secrets', () => {
    const auth = readAsset('api_auth.py')
    const main = readAsset('main.py')

    expect(auth).toContain('@app.middleware("http")')
    expect(auth).toContain('KODE_REVIEW_INDEXER_API_SECRET')
    expect(auth).toContain('x-kode-review-indexer-secret')
    expect(auth).toContain('status_code=401')
    expect(auth).toContain('secrets.compare_digest')
    expect(main).toContain('install_indexer_api_auth(app)')
  })

  it('startIndexer reads the generated secret for health polling', async () => {
    vi.useFakeTimers()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'healthy' }),
    })
    global.fetch = mockFetch

    const started = startIndexer()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(started).resolves.toBe('http://localhost:8321')

    const envPath = join(dirname(configMockState.configPath), 'indexer', INDEXER_ENV_FILE)
    const secret = parseEnvContent(readFileSync(envPath, 'utf-8')).KODE_REVIEW_INDEXER_API_SECRET
    expect(secret).toBeTruthy()
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8321/health',
      expect.objectContaining({
        method: 'GET',
        headers: { [INDEXER_API_SECRET_HEADER]: secret },
      })
    )

    const upCall = execCalls.find((call) => call.args.includes('up'))
    expect(upCall?.args).toContain('--force-recreate')
  })

  it('startIndexer passes trusted generated env values to Docker Compose over process env', async () => {
    vi.useFakeTimers()
    const oldApiSecret = process.env.KODE_REVIEW_INDEXER_API_SECRET
    const oldDbPassword = process.env.KODE_REVIEW_DB_PASSWORD
    const oldDbUrl = process.env.COCOINDEX_DATABASE_URL
    process.env.KODE_REVIEW_INDEXER_API_SECRET = ''
    process.env.KODE_REVIEW_DB_PASSWORD = ''
    process.env.COCOINDEX_DATABASE_URL = 'postgresql://cocoindex:bad@db:5432/cocoindex'

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'healthy' }),
    })
    global.fetch = mockFetch

    try {
      const started = startIndexer()
      await vi.advanceTimersByTimeAsync(2000)
      await expect(started).resolves.toBe('http://localhost:8321')

      const envPath = join(dirname(configMockState.configPath), 'indexer', INDEXER_ENV_FILE)
      const generatedEnv = parseEnvContent(readFileSync(envPath, 'utf-8'))
      const upCall = execCalls.find((call) => call.args.includes('up'))

      expect(upCall?.opts.env?.KODE_REVIEW_INDEXER_API_SECRET).toBe(generatedEnv.KODE_REVIEW_INDEXER_API_SECRET)
      expect(upCall?.opts.env?.KODE_REVIEW_DB_PASSWORD).toBe(generatedEnv.KODE_REVIEW_DB_PASSWORD)
      expect(upCall?.opts.env?.COCOINDEX_DATABASE_URL).toBe(generatedEnv.COCOINDEX_DATABASE_URL)
      expect(upCall?.opts.env?.KODE_REVIEW_INDEXER_API_SECRET).not.toBe('')
      expect(upCall?.opts.env?.COCOINDEX_DATABASE_URL).not.toBe('postgresql://cocoindex:bad@db:5432/cocoindex')
    } finally {
      if (oldApiSecret === undefined) {
        delete process.env.KODE_REVIEW_INDEXER_API_SECRET
      } else {
        process.env.KODE_REVIEW_INDEXER_API_SECRET = oldApiSecret
      }
      if (oldDbPassword === undefined) {
        delete process.env.KODE_REVIEW_DB_PASSWORD
      } else {
        process.env.KODE_REVIEW_DB_PASSWORD = oldDbPassword
      }
      if (oldDbUrl === undefined) {
        delete process.env.COCOINDEX_DATABASE_URL
      } else {
        process.env.COCOINDEX_DATABASE_URL = oldDbUrl
      }
    }
  })

  it('stops legacy running containers without removing volumes so callers recreate them', async () => {
    const indexerDir = join(dirname(configMockState.configPath), 'indexer')
    mkdirSync(indexerDir, { recursive: true })
    writeFileSync(
      join(indexerDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
      ].join('\n') + '\n'
    )
    execResponses.push({
      exitCode: 0,
      stdout: [
        '{"Name":"kode-review-indexer-test-api","State":"running"}',
        '{"Name":"kode-review-indexer-test-db","State":"running"}',
      ].join('\n'),
      stderr: '',
    })

    const status = await getIndexerStatus()

    expect(status.running).toBe(false)
    expect(status.healthy).toBe(false)
    expect(status.containerStatus).toBe('stopped')
    expect(status.dbStatus).toBe('stopped')

    const downCall = execCalls.find((call) => call.args.includes('down'))
    expect(downCall).toBeDefined()
    expect(downCall?.args).not.toContain('--volumes')
  })

  it('stops partially running legacy containers after env credential upgrades', async () => {
    const indexerDir = join(dirname(configMockState.configPath), 'indexer')
    mkdirSync(indexerDir, { recursive: true })
    writeFileSync(
      join(indexerDir, INDEXER_ENV_FILE),
      [
        'KODE_REVIEW_API_PORT=8321',
        'KODE_REVIEW_DB_PORT=5436',
        'KODE_REVIEW_EMBEDDING_MODEL=old-model',
      ].join('\n') + '\n'
    )
    execResponses.push({
      exitCode: 0,
      stdout: [
        '{"Name":"kode-review-indexer-test-api","State":"exited"}',
        '{"Name":"kode-review-indexer-test-db","State":"running"}',
      ].join('\n'),
      stderr: '',
    })

    const status = await getIndexerStatus()

    expect(status.running).toBe(false)
    expect(status.healthy).toBe(false)
    expect(status.containerStatus).toBe('stopped')
    expect(status.dbStatus).toBe('stopped')

    const downCall = execCalls.find((call) => call.args.includes('down'))
    expect(downCall).toBeDefined()
    expect(downCall?.args).not.toContain('--volumes')
  })
})
