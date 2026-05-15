import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
