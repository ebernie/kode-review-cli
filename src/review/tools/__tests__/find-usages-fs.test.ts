import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
