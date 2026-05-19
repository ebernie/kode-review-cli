/**
 * Revalidation prompt — used when a watched PR/MR has moved since its last
 * review. We don't run a full review again; we ask the model to triage the
 * prior findings against the new diff.
 *
 * Inspired by clawpatch's revalidate pass — "is the evidence still present?" —
 * adapted for kode-review's diff-scoped review unit.
 */
import { z } from 'zod'
import type { Finding } from './finding-schema.js'
import { pickFence } from '../repo-audit/prompts.js'
import { sanitizeXmlContent } from './xml-sanitize.js'

export const REVALIDATION_FENCE_TAG = 'kode-revalidation'

export const RevalidationOutcomeSchema = z.object({
  findingTitle: z.string().min(1),
  status: z.enum(['still-present', 'resolved', 'unverifiable']),
  rationale: z.string().min(1),
})

export type RevalidationOutcome = z.infer<typeof RevalidationOutcomeSchema>

export const RevalidationBlockSchema = z.object({
  outcomes: z.array(RevalidationOutcomeSchema),
})

export interface RevalidatePromptOptions {
  priorFindings: Finding[]
  newDiff: string
  prMrInfo?: string
}

export function buildRevalidatePrompt(opts: RevalidatePromptOptions): string {
  // Sanitize free-text fields of each finding before serializing. This is
  // belt-and-braces: the <prior_findings untrusted="true"> wrapper plus the
  // UNTRUSTED_CONTENT_BOUNDARY in the system prompt should be sufficient,
  // but stripping structural-tag closes from the data eliminates whole
  // classes of partial-match confusion.
  const sanitizedFindings = opts.priorFindings.map(f => ({
    ...f,
    title: sanitizeXmlContent(f.title, 'prior_findings'),
    problem: sanitizeXmlContent(f.problem, 'prior_findings'),
    recommendation: sanitizeXmlContent(f.recommendation, 'prior_findings'),
  }))

  const findingsJson = JSON.stringify({ findings: sanitizedFindings }, null, 2)
  const fence = pickFence(findingsJson)

  return [
    'You are reviewing an updated version of a PR you previously reviewed.',
    '',
    'Your job is NOT to do a fresh review. Your job is to triage the PRIOR FINDINGS against the NEW DIFF and report which ones are still present, which have been resolved, and which can no longer be verified from the visible diff.',
    '',
    '## Prior findings (from the previous review)',
    '',
    '<prior_findings untrusted="true">',
    fence + 'json',
    findingsJson,
    fence,
    '</prior_findings>',
    '',
    opts.prMrInfo ? '## PR/MR Information\n\n<pr_mr_info>\n' + sanitizeXmlContent(opts.prMrInfo, 'pr_mr_info') + '\n</pr_mr_info>\n' : '',
    '## New diff (current state of the PR)',
    '',
    '<diff_content>',
    sanitizeXmlContent(opts.newDiff, 'diff_content'),
    '</diff_content>',
    '',
    '## Output Format',
    '',
    'For each prior finding, classify its status:',
    '- **still-present** — the issue described in the prior finding is unchanged or only superficially edited.',
    '- **resolved** — the new diff fixes the issue. Cite the line(s) that resolve it.',
    '- **unverifiable** — the code path is no longer in the diff (file removed, function deleted, refactored beyond recognition). Do NOT guess; mark unverifiable.',
    '',
    'Emit exactly ONE fenced block tagged `' + REVALIDATION_FENCE_TAG + '`:',
    '',
    '```' + REVALIDATION_FENCE_TAG,
    '{',
    '  "outcomes": [',
    '    {',
    '      "findingTitle": "exact title from the prior finding",',
    '      "status": "still-present" | "resolved" | "unverifiable",',
    '      "rationale": "1-2 sentence explanation; cite path:lines where relevant"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Include one outcome per prior finding, matching by title. Do NOT introduce new findings in this pass — that is for the next full review.',
  ].join('\n')
}

export type RevalidationParseError = 'missing' | 'invalid-json' | 'schema'

export interface ParseRevalidationResult {
  outcomes: RevalidationOutcome[]
  error?: RevalidationParseError
  detail?: string
}

const FENCE_RE = new RegExp(
  '^```' + REVALIDATION_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function parseRevalidationBlock(raw: string): ParseRevalidationResult {
  const blocks: string[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(raw)) !== null) blocks.push(m[1])
  if (blocks.length === 0) return { outcomes: [], error: 'missing' }

  let parsed: unknown
  try {
    parsed = JSON.parse(blocks[blocks.length - 1])
  } catch (err) {
    return { outcomes: [], error: 'invalid-json', detail: String(err) }
  }
  const result = RevalidationBlockSchema.safeParse(parsed)
  if (!result.success) return { outcomes: [], error: 'schema', detail: result.error.message }
  return { outcomes: result.data.outcomes }
}
