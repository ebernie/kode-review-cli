/**
 * Extracts the fenced `kode-revalidations` block from raw LLM output and
 * validates it against `RevalidationBlockSchema`. Mirrors
 * `src/review/finding-parser.ts` — tolerant of absence (returns `error:
 * 'missing'`), tolerant of multiple blocks (uses the last one, matching the
 * findings parser).
 */
import {
  REVALIDATIONS_FENCE_TAG,
  RevalidationBlockSchema,
  type RevalidationVerdictEntry,
} from './revalidation-schema.js'

export type RevalidationParseError = 'missing' | 'invalid-json' | 'schema'

export interface ParseRevalidationsResult {
  revalidations: RevalidationVerdictEntry[]
  error?: RevalidationParseError
  /** Human-readable detail when `error` is set. */
  detail?: string
}

/**
 * Match fenced blocks tagged with the REVALIDATIONS_FENCE_TAG language hint.
 * The fence must start at column 0 and uses three backticks (same convention
 * as the findings fence).
 */
const FENCE_RE = new RegExp(
  '^```' + REVALIDATIONS_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function parseRevalidationBlock(rawOutput: string): ParseRevalidationsResult {
  const blocks: string[] = []
  for (const match of rawOutput.matchAll(FENCE_RE)) {
    blocks.push(match[1])
  }
  if (blocks.length === 0) {
    return { revalidations: [], error: 'missing' }
  }
  // Last-wins: if the agent retried mid-response, the final block is canonical.
  const body = blocks[blocks.length - 1]

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    return { revalidations: [], error: 'invalid-json', detail: String(err) }
  }

  const result = RevalidationBlockSchema.safeParse(parsed)
  if (!result.success) {
    return { revalidations: [], error: 'schema', detail: result.error.message }
  }
  return { revalidations: result.data.revalidations }
}
