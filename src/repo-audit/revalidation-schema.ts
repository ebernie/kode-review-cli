/**
 * Structured output contract for `--revalidate`.
 *
 * The agent emits a fenced `kode-revalidations` JSON block with one entry
 * per finding it was asked to check. The shape is deliberately distinct from
 * `FindingsBlockSchema` — revalidation produces *verdicts on existing
 * findings*, not new findings.
 *
 * Verdict → status mapping lives in this module so the orchestrator and
 * tests stay in sync.
 */
import { z } from 'zod'
import {
  REVALIDATION_VERDICTS,
  type RepoFindingStatus,
  type RevalidationVerdict,
} from './types.js'

/**
 * One verdict on one finding. `findingId` is the canonical id from
 * `.kode-review/findings/<id>.json`. `evidence` is optional free-form
 * justification the agent may include (e.g. "function deleted in commit X").
 */
export const RevalidationVerdictEntrySchema = z.object({
  findingId: z.string().min(1),
  verdict: z.enum(REVALIDATION_VERDICTS),
  evidence: z.string().optional(),
})

export type RevalidationVerdictEntry = z.infer<typeof RevalidationVerdictEntrySchema>

export const RevalidationBlockSchema = z.object({
  revalidations: z.array(RevalidationVerdictEntrySchema),
})

export type RevalidationBlock = z.infer<typeof RevalidationBlockSchema>

/**
 * Map an agent verdict to a persisted finding status. Stateless and total.
 */
export function verdictToStatus(verdict: RevalidationVerdict): RepoFindingStatus {
  switch (verdict) {
    case 'fixed':
      return 'fixed'
    case 'still-present':
      return 'open'
    case 'uncertain':
      return 'uncertain'
  }
}

/**
 * Human-readable hint for the agent's structured-output instructions. Mirrors
 * `FINDINGS_BLOCK_INSTRUCTIONS` in shape so persona prompts can be authored
 * in the same idiom.
 */
export const REVALIDATIONS_FENCE_TAG = 'kode-revalidations'

export const REVALIDATIONS_BLOCK_INSTRUCTIONS = [
  '## Structured Output (REQUIRED)',
  '',
  'Emit exactly ONE fenced block at the end of your response using the',
  `\`${REVALIDATIONS_FENCE_TAG}\` language tag. Inside, place valid JSON`,
  'matching this schema:',
  '',
  '```json',
  '{',
  '  "revalidations": [',
  '    {',
  '      "findingId": "<id from the Findings to Revalidate section>",',
  '      "verdict": "fixed" | "still-present" | "uncertain",',
  '      "evidence": "<optional short justification>"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'One entry per finding you were asked to review. Do not invent findingIds.',
  'Do not emit `false-positive` or `wont-fix` — those are user intents, not',
  'verdicts you can make.',
].join('\n')
