/**
 * Extracts the fenced findings block from raw LLM output and validates
 * it against FindingsBlockSchema. Tolerates absence of the block — the
 * markdown review remains the source of truth for humans.
 */
import { FindingsBlockSchema, type Finding } from './finding-schema.js'

export const FINDINGS_FENCE_TAG = 'kode-findings'

export type FindingsParseError = 'missing' | 'invalid-json' | 'schema'

export interface ParseFindingsResult {
  findings: Finding[]
  error?: FindingsParseError
  /** Human-readable detail when error is set. */
  detail?: string
}

/**
 * Match fenced blocks tagged with the FINDINGS_FENCE_TAG language hint.
 * The fence must start at column 0 and uses three backticks.
 */
const FENCE_RE = new RegExp(
  '^```' + FINDINGS_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function parseFindingsBlock(rawReview: string): ParseFindingsResult {
  const blocks: string[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(rawReview)) !== null) {
    blocks.push(m[1])
  }
  if (blocks.length === 0) {
    return { findings: [], error: 'missing' }
  }
  const body = blocks[blocks.length - 1]

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    return { findings: [], error: 'invalid-json', detail: String(err) }
  }

  const result = FindingsBlockSchema.safeParse(parsed)
  if (!result.success) {
    return { findings: [], error: 'schema', detail: result.error.message }
  }
  return { findings: result.data.findings }
}
