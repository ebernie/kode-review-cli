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

  // isHighImpact is computed as `directImporters.length >= 5` (see
  // HIGH_IMPACT_THRESHOLD in get-impact-fs.ts). Previous coverage was a
  // tautology (`expect(isHighImpact).toBe(directImporters.length >= 5)`)
  // that would have passed even if the threshold check were broken.
  // These two tests pin the boundary against fixtures with deliberately
  // chosen importer counts.
  it('does not flag isHighImpact for files below the 5-importer threshold', async () => {
    // utils.ts is imported only by calculator.ts → 1 importer (< 5).
    const out = await getImpactFsHandler({ filePath: 'src/utils.ts' }, FIXTURE)
    expect(out.directImporters.length).toBeLessThan(5)
    expect(out.isHighImpact).toBe(false)
  })

  it('flags isHighImpact when file is imported by 5+ files (threshold met)', async () => {
    // widely-used.ts is imported by importer-{a,b,c,d,e}.ts → exactly 5
    // importers, sitting on the threshold boundary.
    const out = await getImpactFsHandler({ filePath: 'src/widely-used.ts' }, FIXTURE)
    expect(out.directImporters.length).toBeGreaterThanOrEqual(5)
    expect(out.isHighImpact).toBe(true)
  })
})
