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

export async function isRipgrepAvailable(): Promise<boolean> {
  return commandExists('rg')
}

export async function ripgrepSearch(
  pattern: string,
  repoRoot: string,
  options: RipgrepOptions = {},
): Promise<RipgrepMatch[]> {
  if (!(await isRipgrepAvailable())) {
    throw new Error(
      'ripgrep (rg) is required for filesystem-backed agentic tools but was not found on PATH. ' +
        'Install ripgrep (https://github.com/BurntSushi/ripgrep#installation) or start the indexer.',
    )
  }

  const args: string[] = ['--json', '--no-messages']
  if (options.fixedString !== false) args.push('-F')
  if (options.wholeWord) args.push('-w')
  if (options.type) args.push('--type', options.type)
  for (const g of options.globs ?? []) args.push('-g', g)
  args.push('--', pattern, '.')

  const result = await runProcess('rg', args, { cwd: repoRoot })
  // rg exits 1 when there are no matches — that is not an error for us.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`ripgrep failed (exit ${result.exitCode}): ${result.stderr}`)
  }

  const matches = parseRipgrepJsonOutput(result.stdout)
  const limit = options.maxResults ?? DEFAULT_MAX_RESULTS
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
