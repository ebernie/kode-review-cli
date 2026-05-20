import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { findUsagesFsHandler } from '../find-usages-fs.js'
import { isRipgrepAvailable } from '../ripgrep.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

const hasRg = await isRipgrepAvailable()

describe.skipIf(!hasRg)('findUsagesFsHandler', () => {
  it('finds call sites of a function', async () => {
    const out = await findUsagesFsHandler({ symbol: 'square' }, FIXTURE)
    expect(out.usages.some((u) => u.path.endsWith('calculator.ts'))).toBe(true)
    expect(out.usages.every((u) => !u.content.includes('export function square'))).toBe(true)
  })

  it('finds usages of a class', async () => {
    const out = await findUsagesFsHandler({ symbol: 'Calculator' }, FIXTURE)
    expect(out.usages.some((u) => u.path.endsWith('index.ts'))).toBe(true)
  })

  it('returns an empty result for unused symbols', async () => {
    const out = await findUsagesFsHandler({ symbol: 'absolutelyUnusedSym' }, FIXTURE)
    expect(out.usages).toEqual([])
  })
})

/**
 * Pins the sensitive-path filter wiring on findUsagesFsHandler.
 *
 * Uses non-dotfile sensitive paths so ripgrep actually returns them; the
 * dotfile path is covered by the sensitive-filter unit tests. The
 * affirmative "benign IS present" assertion guards against vacuous-pass
 * on an empty result set.
 */
describe.skipIf(!hasRg)('findUsagesFsHandler — sensitive path filter', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kr-findusages-sensitive-'))
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    mkdirSync(join(tmpDir, 'config'), { recursive: true })
    mkdirSync(join(tmpDir, 'auth'), { recursive: true })
    // Whole-word usage of `secretSymbol` in source — this should survive.
    writeFileSync(
      join(tmpDir, 'src', 'caller.ts'),
      'import { secretSymbol } from "./lib"\nsecretSymbol()\n',
    )
    // Non-hidden sensitive files containing the same identifier as a
    // whole word — ripgrep returns these, and the filter must drop them
    // before content leaves the handler.
    writeFileSync(
      join(tmpDir, 'config', 'application-prod.yml'),
      'secretSymbol: leaked-app-prod-value\n',
    )
    writeFileSync(
      join(tmpDir, 'auth', 'credentials.json'),
      '{"secretSymbol": "leaked-creds-value"}\n',
    )
  })

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns benign usages and drops sensitive paths', async () => {
    const out = await findUsagesFsHandler({ symbol: 'secretSymbol' }, tmpDir)
    // Affirmative: the benign source IS present. Without this, the
    // following negative assertions could pass on an empty array.
    const paths = out.usages.map((u) => u.path.replace(/^\.\//, ''))
    expect(paths).toContain('src/caller.ts')
    // Filter dropped both sensitive paths.
    expect(paths).not.toContain('config/application-prod.yml')
    expect(paths).not.toContain('auth/credentials.json')
    // Defense in depth on content.
    for (const u of out.usages) {
      expect(u.content).not.toContain('leaked-app-prod-value')
      expect(u.content).not.toContain('leaked-creds-value')
    }
  })
})
