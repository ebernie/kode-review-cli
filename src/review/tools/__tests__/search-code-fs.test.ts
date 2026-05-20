import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { searchCodeFsHandler } from '../search-code-fs.js'
import { isRipgrepAvailable } from '../ripgrep.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

const hasRg = await isRipgrepAvailable()

describe.skipIf(!hasRg)('searchCodeFsHandler', () => {
  it('returns matches for an identifier', async () => {
    const out = await searchCodeFsHandler({ query: 'squareSum' }, FIXTURE)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.every((r) => r.content.includes('squareSum'))).toBe(true)
    expect(out.query).toBe('squareSum')
  })

  it('respects the limit option', async () => {
    const out = await searchCodeFsHandler({ query: 'square', limit: 1 }, FIXTURE)
    expect(out.results).toHaveLength(1)
  })

  it('returns no results for non-existent identifiers without throwing', async () => {
    const out = await searchCodeFsHandler({ query: 'totallyMadeUpSymbol_xyzzy' }, FIXTURE)
    expect(out.results).toEqual([])
    expect(out.totalMatches).toBe(0)
  })

  it('caps limit at the upper bound', async () => {
    const out = await searchCodeFsHandler({ query: 'function', limit: 9999 }, FIXTURE)
    expect(out.results.length).toBeLessThanOrEqual(20)
  })

  it('uses matchTypes=["lexical"] in every result', async () => {
    const out = await searchCodeFsHandler({ query: 'square' }, FIXTURE)
    expect(out.results.every((r) => r.matchTypes.length === 1 && r.matchTypes[0] === 'lexical')).toBe(true)
  })
})

describe.skipIf(hasRg)('searchCodeFsHandler (no rg)', () => {
  it('throws a clear error referencing ripgrep + install URL when rg is missing', async () => {
    await expect(searchCodeFsHandler({ query: 'foo' }, FIXTURE)).rejects.toThrow(/ripgrep/)
  })
})

/**
 * Integration test for the sensitive-file filter wired into the fs-backed
 * search handler. We materialize a temp repo with a benign source file and
 * a handful of sensitive files, all containing the same needle, and
 * confirm that only the benign file surfaces — sensitive contents must
 * not reach the model.
 *
 * Uses *non-hidden* sensitive paths (application-prod.yml, .pem, .key,
 * credentials.json, etc.) because ripgrep skips dotfiles by default; the
 * .env / .env.example dotfile cases are covered by the unit tests on
 * `filterSensitivePaths` directly. This integration test pins the
 * wiring between ripgrep results and the filter for paths ripgrep
 * actually returns.
 */
describe.skipIf(!hasRg)('searchCodeFsHandler — sensitive path filter', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kr-search-sensitive-'))
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    mkdirSync(join(tmpDir, 'keys'), { recursive: true })
    mkdirSync(join(tmpDir, 'config'), { recursive: true })
    mkdirSync(join(tmpDir, 'auth'), { recursive: true })
    writeFileSync(join(tmpDir, 'src', 'app.ts'), 'const SECRET_TOKEN = "from-source"\n')
    // Spring Boot profile-specific config — non-hidden, ripgrep returns it.
    writeFileSync(
      join(tmpDir, 'config', 'application-prod.yml'),
      'SECRET_TOKEN: from-app-prod-yml\n',
    )
    // Cert file by extension
    writeFileSync(
      join(tmpDir, 'keys', 'server.pem'),
      '# SECRET_TOKEN-pem-payload\n-----BEGIN PRIVATE KEY-----\n',
    )
    writeFileSync(
      join(tmpDir, 'keys', 'server.key'),
      '# SECRET_TOKEN-key-payload\n',
    )
    // GCP-style service account / credentials JSON
    writeFileSync(
      join(tmpDir, 'auth', 'credentials.json'),
      '{"SECRET_TOKEN": "from-creds-json"}\n',
    )
    writeFileSync(
      join(tmpDir, 'auth', 'service-account.json'),
      '{"SECRET_TOKEN": "from-svcacct-json"}\n',
    )
  })

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns matches from source files but drops sensitive paths', async () => {
    const out = await searchCodeFsHandler({ query: 'SECRET_TOKEN', limit: 20 }, tmpDir)
    const paths = out.results.map((r) => r.path)
    // ripgrep emits paths relative to the search root, with a `./` prefix
    // because we invoke it with `.` as the search target. Normalize for
    // assertions so the test isn't coupled to that surface detail.
    const normalized = paths.map((p) => p.replace(/^\.\//, ''))
    // benign source must survive
    expect(normalized).toContain('src/app.ts')
    // sensitive files must be filtered before content reaches the caller
    expect(normalized).not.toContain('config/application-prod.yml')
    expect(normalized).not.toContain('keys/server.pem')
    expect(normalized).not.toContain('keys/server.key')
    expect(normalized).not.toContain('auth/credentials.json')
    expect(normalized).not.toContain('auth/service-account.json')
  })

  it('the sensitive file content never appears in the returned results', async () => {
    // Defense in depth on the filter wiring: even if the path slipped
    // through, the secret string should not leak. Asserting on content
    // (not just path) pins this against a future refactor that, e.g.,
    // maps paths AFTER content extraction and loses the filter.
    const out = await searchCodeFsHandler({ query: 'SECRET_TOKEN', limit: 20 }, tmpDir)
    for (const result of out.results) {
      expect(result.content).not.toContain('from-app-prod-yml')
      expect(result.content).not.toContain('pem-payload')
      expect(result.content).not.toContain('key-payload')
      expect(result.content).not.toContain('from-creds-json')
      expect(result.content).not.toContain('from-svcacct-json')
    }
  })

  it('totalMatches reflects the post-filter count, not the raw ripgrep hit count', async () => {
    const out = await searchCodeFsHandler({ query: 'SECRET_TOKEN', limit: 20 }, tmpDir)
    expect(out.totalMatches).toBe(out.results.length)
    // 6 files contain the needle (src/app.ts plus 5 sensitive); only the
    // benign source survives. Total matches must be strictly less than
    // the raw file count, proving the filter ran.
    expect(out.totalMatches).toBeLessThan(6)
    expect(out.totalMatches).toBe(1)
  })
})
