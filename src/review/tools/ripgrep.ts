/**
 * Thin wrapper around the `rg` binary using its JSON event stream.
 * All filesystem-backed agentic tools route through this module so we
 * have a single place to enforce flags, gitignore behaviour, and result caps.
 */

import { exec as runProcess, commandExists } from '../../utils/exec.js'

export interface RipgrepMatch {
  path: string
  line: number
  text: string
  matchText: string
  /** 1-based column where the match starts. */
  column: number
}

export interface RipgrepOptions {
  globs?: string[]
  maxResults?: number
  type?: string
  fixedString?: boolean
  wholeWord?: boolean
}

const DEFAULT_MAX_RESULTS = 200
// Hard upper bound regardless of caller-requested maxResults. Caps the
// `--max-count` value we pass to rg so a model-supplied huge limit cannot
// turn the subprocess loose on a repo-scale match set.
const ABSOLUTE_MAX_RESULTS = 1000
// Mirror of rg's own --max-filesize flag. Skips files larger than this
// outright so a single huge file cannot dominate the output buffer.
const DEFAULT_MAX_FILESIZE = '10M'
// Hard ceiling on subprocess wall time, applied via execa's `timeout`.
const DEFAULT_TIMEOUT_MS = 30_000
// Hard ceiling on captured stdout, applied via execa's `maxBuffer`. Higher
// than rg's per-file cap × ABSOLUTE_MAX_RESULTS in the worst case but still
// bounded — overruns abort the subprocess rather than balloon memory.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

export async function isRipgrepAvailable(): Promise<boolean> {
  return commandExists('rg')
}

export async function ripgrepSearch(
  pattern: string,
  repoRoot: string,
  options: RipgrepOptions = {},
): Promise<RipgrepMatch[]> {
  // Validate inputs *before* probing for rg. Reject obviously-bad arguments
  // even on hosts without rg installed — the caller's bug isn't conditional
  // on rg's presence, and the validation path needs to be unconditionally
  // testable.

  // Reject empty/whitespace patterns. With -F (fixed-string, the default)
  // an empty pattern matches *every line*, which is the canonical way a
  // model can accidentally trigger a repo-scale scan.
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new Error('ripgrep pattern must be a non-empty string')
  }

  // Clamp legitimate-but-oversized maxResults to ABSOLUTE_MAX_RESULTS;
  // reject non-positive / non-finite values.
  const requested = options.maxResults ?? DEFAULT_MAX_RESULTS
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error(
      `ripgrep maxResults must be a positive finite number, got: ${String(requested)}`,
    )
  }
  const limit = Math.min(Math.floor(requested), ABSOLUTE_MAX_RESULTS)

  if (!(await isRipgrepAvailable())) {
    throw new Error(
      'ripgrep (rg) is required for filesystem-backed agentic tools but was not found on PATH. ' +
        'Install ripgrep (https://github.com/BurntSushi/ripgrep#installation) or start the indexer.',
    )
  }

  const args: string[] = [
    '--json',
    '--no-messages',
    // Per-file cap. rg stops emitting match events for a file after `limit`
    // hits, so even a pattern matching every line in 10k files emits at
    // most limit × 10k events instead of unbounded.
    '--max-count',
    String(limit),
    '--max-filesize',
    DEFAULT_MAX_FILESIZE,
  ]
  if (options.fixedString !== false) args.push('-F')
  if (options.wholeWord) args.push('-w')
  if (options.type) args.push('--type', options.type)
  for (const g of options.globs ?? []) args.push('-g', g)
  args.push('--', pattern, '.')

  // Wrap the spawn so any execa-level failure (timeout, maxBuffer overflow,
  // ENOENT) surfaces as a structured ripgrep error rather than an opaque
  // throw — `utils/exec.ts` uses `reject: false`, but spawn-time errors
  // (e.g. ENOENT) still throw, and a `timeout`/`maxBuffer` kill can also
  // bubble depending on execa's path.
  let result
  try {
    result = await runProcess('rg', args, {
      cwd: repoRoot,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`ripgrep failed to execute: ${msg}`)
  }
  // rg exits 1 when there are no matches — that is not an error for us.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`ripgrep failed (exit ${result.exitCode}): ${result.stderr}`)
  }

  // Final global slice. --max-count caps *per file*, so cross-file totals
  // can still exceed `limit`; this is the authoritative global cap. If
  // maxBuffer fires and execa's wrapper hides the failure as exit=0 with
  // truncated stdout, parseRipgrepJsonOutput will throw on the chopped
  // final JSON line — surfacing the problem rather than silently returning
  // a partial result.
  const matches = parseRipgrepJsonOutput(result.stdout)
  return matches.slice(0, limit)
}

interface RgEvent {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: Array<{ match?: { text?: string }; start?: number }>
  }
}

export function parseRipgrepJsonOutput(raw: string): RipgrepMatch[] {
  if (!raw) return []
  const out: RipgrepMatch[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let event: RgEvent
    try {
      event = JSON.parse(line) as RgEvent
    } catch {
      throw new Error(`Failed to parse ripgrep JSON line: ${line.slice(0, 80)}`)
    }
    if (event.type !== 'match' || !event.data) continue
    const d = event.data
    const sm = Array.isArray(d.submatches) && d.submatches.length > 0 ? d.submatches[0] : null
    out.push({
      path: d.path?.text ?? '',
      line: typeof d.line_number === 'number' ? d.line_number : 0,
      text: typeof d.lines?.text === 'string' ? d.lines.text.replace(/\n$/, '') : '',
      matchText: sm?.match?.text ?? '',
      column: typeof sm?.start === 'number' ? sm.start + 1 : 1,
    })
  }
  return out
}
