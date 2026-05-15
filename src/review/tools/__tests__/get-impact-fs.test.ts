import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getImpactFsHandler } from '../get-impact-fs.js'
import { isRipgrepAvailable } from '../ripgrep.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

const hasRg = await isRipgrepAvailable()

describe.skipIf(!hasRg)('getImpactFsHandler', () => {
  it('finds direct importers of a file (TS)', async () => {
    const out = await getImpactFsHandler({ filePath: 'src/utils.ts' }, FIXTURE)
    expect(out.directImporters.some((p) => p.endsWith('calculator.ts'))).toBe(true)
    expect(out.isPartial).toBe(true)
  })

  it('reports zero importers for unreferenced files', async () => {
    const out = await getImpactFsHandler({ filePath: 'src/nonexistent.ts' }, FIXTURE)
    expect(out.directImporters).toEqual([])
  })

  it('flags isHighImpact only when threshold reached', async () => {
    const out = await getImpactFsHandler({ filePath: 'src/utils.ts' }, FIXTURE)
    expect(out.isHighImpact).toBe(out.directImporters.length >= 5)
  })
})
