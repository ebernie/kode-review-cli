import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseRipgrepJsonOutput } from '../ripgrep.js'

describe('parseRipgrepJsonOutput', () => {
  it('extracts matches from rg --json line-delimited output', () => {
    const raw = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'export function foo() {\n' },
          line_number: 12,
          submatches: [{ match: { text: 'foo' }, start: 16, end: 19 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
    ].join('\n')

    const matches = parseRipgrepJsonOutput(raw)

    expect(matches).toEqual([
      {
        path: 'src/a.ts',
        line: 12,
        text: 'export function foo() {',
        matchText: 'foo',
        column: 17,
      },
    ])
  })

  it('returns an empty array for no-match output', () => {
    expect(parseRipgrepJsonOutput('')).toEqual([])
  })

  it('ignores non-match event types', () => {
    const raw = JSON.stringify({ type: 'summary', data: {} })
    expect(parseRipgrepJsonOutput(raw)).toEqual([])
  })

  it('throws on malformed JSON lines', () => {
    expect(() => parseRipgrepJsonOutput('{not json')).toThrow(/parse/i)
  })

  it('fails fast when a malformed line follows a valid match line', () => {
    const valid = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'x.ts' },
        lines: { text: 'foo\n' },
        line_number: 1,
        submatches: [{ match: { text: 'foo' }, start: 0, end: 3 }],
      },
    })
    const raw = `${valid}\n{garbage`
    expect(() => parseRipgrepJsonOutput(raw)).toThrow(/parse/i)
  })

  it('reports column=1 when the match starts at column 0', () => {
    const raw = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'x.ts' },
        lines: { text: 'foo\n' },
        line_number: 1,
        submatches: [{ match: { text: 'foo' }, start: 0, end: 3 }],
      },
    })
    expect(parseRipgrepJsonOutput(raw)[0].column).toBe(1)
  })

  it('falls back to safe defaults when optional fields are missing', () => {
    const raw = JSON.stringify({ type: 'match', data: {} })
    expect(parseRipgrepJsonOutput(raw)).toEqual([
      { path: '', line: 0, text: '', matchText: '', column: 1 },
    ])
  })
})

/**
 * Subprocess-cap behavior. Two findings (1831085c.../d991fcd2...) flagged
 * that the maxResults limit was applied only *after* rg had emitted full
 * output and the JSON had been parsed. The fix rejects empty patterns,
 * clamps maxResults to ABSOLUTE_MAX_RESULTS (1000), and passes --max-count
 * + --max-filesize to rg itself so the subprocess self-limits.
 *
 * Validation cases run against the real binary — they short-circuit before
 * any spawn. The "passes args to rg" cases mock the exec boundary so the
 * exact argv can be asserted without needing a giant repo fixture to
 * provoke a runaway scan.
 */
describe('ripgrepSearch — input validation', () => {
  // The SUT now validates pattern + maxResults BEFORE probing for rg, so
  // these assertions are unconditional — they hold on hosts without rg
  // installed too. We defer the import to make sure prior describe blocks'
  // module mocks don't leak in.
  let ripgrepSearch: typeof import('../ripgrep.js').ripgrepSearch

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../ripgrep.js')
    ripgrepSearch = mod.ripgrepSearch
  })

  it('rejects an empty pattern before spawning rg', async () => {
    await expect(ripgrepSearch('', process.cwd())).rejects.toThrow(/non-empty/)
  })

  it('rejects a whitespace-only pattern before spawning rg', async () => {
    await expect(ripgrepSearch('   \t\n', process.cwd())).rejects.toThrow(/non-empty/)
  })

  it('rejects maxResults = 0', async () => {
    await expect(
      ripgrepSearch('foo', process.cwd(), { maxResults: 0 }),
    ).rejects.toThrow(/positive finite/)
  })

  it('rejects negative maxResults', async () => {
    await expect(
      ripgrepSearch('foo', process.cwd(), { maxResults: -10 }),
    ).rejects.toThrow(/positive finite/)
  })

  it('rejects NaN maxResults', async () => {
    await expect(
      ripgrepSearch('foo', process.cwd(), { maxResults: Number.NaN }),
    ).rejects.toThrow(/positive finite/)
  })

  it('rejects Infinity maxResults', async () => {
    await expect(
      ripgrepSearch('foo', process.cwd(), { maxResults: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/positive finite/)
  })
})

/**
 * Args contract: verify ripgrepSearch passes subprocess-level caps to rg.
 * Mocking the exec boundary lets us assert the exact argv without needing a
 * fixture that actually exercises rg's --max-count behavior.
 */
describe('ripgrepSearch — subprocess cap args', () => {
  // Use the module path here that ripgrep.ts itself uses.
  const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []

  beforeEach(() => {
    execCalls.length = 0
    vi.resetModules()
    vi.doMock('../../../utils/exec.js', () => ({
      exec: vi.fn(
        async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
          execCalls.push({ cmd, args, opts: opts ?? {} })
          return { exitCode: 1, stdout: '', stderr: '' }
        },
      ),
      commandExists: vi.fn(async () => true),
      execInteractive: vi.fn(async () => 0),
    }))
  })

  afterEach(() => {
    vi.doUnmock('../../../utils/exec.js')
  })

  it('passes --max-count with the requested limit', async () => {
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x', { maxResults: 50 })
    expect(execCalls).toHaveLength(1)
    const args = execCalls[0].args
    const idx = args.indexOf('--max-count')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('50')
  })

  it('passes --max-filesize=10M', async () => {
    // Pinned to the exact value — the audit flagged that a shape-only check
    // (e.g., `/^\d+[KMG]?$/`) would pass even on a regression to 1K or 1G,
    // both of which would defeat the cap.
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x')
    const args = execCalls[0].args
    const idx = args.indexOf('--max-filesize')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('10M')
  })

  it('uses a sensible default when maxResults is omitted', async () => {
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x')
    const args = execCalls[0].args
    const idx = args.indexOf('--max-count')
    expect(idx).toBeGreaterThan(-1)
    expect(Number(args[idx + 1])).toBe(200)
  })

  it('floors fractional maxResults', async () => {
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x', { maxResults: 17.9 })
    const args = execCalls[0].args
    const idx = args.indexOf('--max-count')
    expect(args[idx + 1]).toBe('17')
  })

  it('forwards a 30s timeout and 64MiB maxBuffer to execa', async () => {
    // Pin to exact values — both are load-bearing for the OOM/DoS defense:
    // a regression to timeout=1ms or maxBuffer=1KiB would silently weaken
    // the cap. The audit flagged that a `> 0` check was too loose.
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x')
    const opts = execCalls[0].opts
    expect(opts.timeout).toBe(30_000)
    expect(opts.maxBuffer).toBe(64 * 1024 * 1024)
  })

  it('clamps oversized maxResults to ABSOLUTE_MAX_RESULTS (1000)', async () => {
    // A caller (or model) asking for 100k matches should be silently
    // clamped to the documented ceiling. 1000 is the anchor — anything
    // higher means the cap regressed, anything lower means we tightened
    // without updating the test.
    const { ripgrepSearch } = await import('../ripgrep.js')
    await ripgrepSearch('foo', '/tmp/x', { maxResults: 100_000 })
    const args = execCalls[0].args
    const idx = args.indexOf('--max-count')
    expect(Number(args[idx + 1])).toBe(1000)
  })

  it('surfaces a structured error when the exec layer throws', async () => {
    // execa's `reject: false` path still throws on spawn-time failures
    // (ENOENT) and can throw on `timeout`/`maxBuffer` overflow depending on
    // its internal path. The SUT wraps runProcess in try/catch so callers
    // always see a "ripgrep failed to execute" prefix rather than an
    // opaque rejection.
    vi.resetModules()
    vi.doMock('../../../utils/exec.js', () => ({
      exec: vi.fn(async () => {
        throw new Error('Command failed with ENOBUFS: maxBuffer exceeded')
      }),
      commandExists: vi.fn(async () => true),
      execInteractive: vi.fn(async () => 0),
    }))
    const { ripgrepSearch } = await import('../ripgrep.js')
    await expect(ripgrepSearch('foo', '/tmp/x')).rejects.toThrow(
      /ripgrep failed to execute.*ENOBUFS/,
    )
  })

  it('global slice truncates parsed matches that exceed the limit', async () => {
    // --max-count is per-file. A pattern matching across many files can
    // therefore produce a parsed result larger than `limit`, and the
    // final `matches.slice(0, limit)` is the authoritative global cap
    // — the original OOM vector from the findings. Synthesize a stdout
    // payload with 1001 match events at the 1000-cap ceiling and assert
    // only 1000 come back.
    vi.resetModules()
    const events: string[] = []
    for (let i = 0; i < 1001; i++) {
      events.push(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: `f${i}.ts` },
            lines: { text: 'hit\n' },
            line_number: 1,
            submatches: [{ match: { text: 'hit' }, start: 0, end: 3 }],
          },
        }),
      )
    }
    const synthetic = events.join('\n')
    vi.doMock('../../../utils/exec.js', () => ({
      exec: vi.fn(async () => ({ exitCode: 0, stdout: synthetic, stderr: '' })),
      commandExists: vi.fn(async () => true),
      execInteractive: vi.fn(async () => 0),
    }))
    const { ripgrepSearch } = await import('../ripgrep.js')
    const result = await ripgrepSearch('hit', '/tmp/x', { maxResults: 100_000 })
    expect(result).toHaveLength(1000)
  })
})
