import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { findDefinitionsFsHandler } from '../find-definitions-fs.js'
import { isRipgrepAvailable } from '../ripgrep.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

const hasRg = await isRipgrepAvailable()

describe.skipIf(!hasRg)('findDefinitionsFsHandler', () => {
  it('locates a TypeScript function definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'square' }, FIXTURE)
    const utilsHit = out.definitions.find((d) => d.path.endsWith('utils.ts'))
    expect(utilsHit).toBeDefined()
    expect(utilsHit!.content).toContain('export function square')
  })

  it('locates a TypeScript class definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'Calculator' }, FIXTURE)
    const hit = out.definitions.find((d) => d.path.endsWith('calculator.ts'))
    expect(hit).toBeDefined()
    expect(hit!.content).toContain('class Calculator')
  })

  it('locates a Python function definition', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'square' }, FIXTURE)
    expect(
      out.definitions.some((d) => d.path.endsWith('helpers.py') && d.content.includes('def square')),
    ).toBe(true)
  })

  it('returns an empty result for unknown symbols', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'nopeNotReal' }, FIXTURE)
    expect(out.definitions).toEqual([])
    expect(out.totalCount).toBe(0)
  })
})

/**
 * Pins the sensitive-path filter wiring on findDefinitionsFsHandler.
 *
 * Uses non-dotfile sensitive paths so ripgrep actually returns them —
 * if the filter is removed, the test fails because the sensitive content
 * surfaces. (.env-style dotfiles are skipped by ripgrep by default; that
 * code path is covered by the sensitive-filter unit tests.) An
 * affirmative "benign result IS present" assertion guards against
 * vacuous-pass on an empty result set.
 */
describe.skipIf(!hasRg)('findDefinitionsFsHandler — sensitive path filter', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kr-finddefs-sensitive-'))
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    mkdirSync(join(tmpDir, 'config'), { recursive: true })
    mkdirSync(join(tmpDir, 'auth'), { recursive: true })
    writeFileSync(
      join(tmpDir, 'src', 'app.ts'),
      'export function secretLeak() { return process.env.X }\n',
    )
    // Spring Boot profile-specific config and a credentials.json — both
    // are matched by ripgrep (non-hidden), both match the sensitive
    // denylist. Their content includes the definition regex's keywords
    // (`export const`, `func`) so the regex matches them.
    writeFileSync(
      join(tmpDir, 'config', 'application-prod.yml'),
      'export const secretLeak: leaked-app-prod\n',
    )
    writeFileSync(
      join(tmpDir, 'auth', 'credentials.json'),
      '{"export const secretLeak": "leaked-creds-json"}\n',
    )
  })

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns benign definitions and drops sensitive paths', async () => {
    const out = await findDefinitionsFsHandler({ symbol: 'secretLeak' }, tmpDir)
    // Affirmative: the benign source IS present. Without this, the
    // following negative assertions could pass on an empty array.
    const paths = out.definitions.map((d) => d.path.replace(/^\.\//, ''))
    expect(paths).toContain('src/app.ts')
    // Filter dropped both sensitive paths.
    expect(paths).not.toContain('config/application-prod.yml')
    expect(paths).not.toContain('auth/credentials.json')
    // Defense in depth: their leaked-* payloads never appear.
    for (const d of out.definitions) {
      expect(d.content).not.toContain('leaked-app-prod')
      expect(d.content).not.toContain('leaked-creds-json')
    }
  })
})
