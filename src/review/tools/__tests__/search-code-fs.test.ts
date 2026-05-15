import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
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
