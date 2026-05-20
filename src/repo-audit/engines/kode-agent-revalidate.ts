/**
 * kode-agent engine wrapper for `--revalidate`.
 *
 * For one (featureId, persona) group of open findings:
 *   1. Loads the persona's system prompt, appends `REVALIDATION_MODE_SUFFIX`.
 *   2. Builds a revalidation user prompt (findings + current file contents).
 *   3. Runs the agentic engine with tools enabled (so the agent can chase
 *      file moves via read_file / search_code if needed).
 *   4. Parses the `kode-revalidations` JSON block from the agent's response.
 *
 * Returns a Map keyed by `findingId` so the orchestrator can match verdicts
 * back to records cheaply. Unknown findingIds (hallucinated by the agent) are
 * filtered here rather than at the orchestrator — keeping the orchestrator's
 * loop focused on persistence.
 */
import { runAgenticReview } from '../../review/engine.js'
import type { UsageTotals } from '../../review/usage.js'
import { loadReviewerSystemPrompt, type ReviewerInfo } from '../../reviewers/index.js'
import { logger } from '../../utils/logger.js'
import { parseRevalidationBlock } from '../revalidation-parser.js'
import { buildRevalidationPrompt } from '../revalidation-prompts.js'
import type { RevalidationVerdictEntry } from '../revalidation-schema.js'
import type { FeatureRecord, RepoFindingRecord } from '../types.js'

export interface RevalidateFeatureGroupWithAgentOptions {
  feature: FeatureRecord
  persona: ReviewerInfo
  /** All open findings in this (featureId, persona) group. */
  openFindings: RepoFindingRecord[]
  repoRoot: string
  repoUrl: string
  branch?: string
  indexerUrl?: string
  model?: string
  maxIterations?: number
  /** Hard ceiling in seconds. Default: 600. */
  timeoutSec?: number
}

export interface RevalidateFeatureGroupResult {
  feature: FeatureRecord
  persona: ReviewerInfo
  /** Verdicts keyed by findingId. Includes only ids the agent emitted. */
  verdicts: Map<string, RevalidationVerdictEntry>
  /** Raw model output (for debugging). */
  content: string
  usage: UsageTotals
  /** True if the agent hit max iterations before producing structured output. */
  truncated: boolean
  truncationReason?: string
  /** Whether the structured-output block was parseable. */
  blockParsed: boolean
  /** Parser error, if any (missing / invalid-json / schema). */
  blockError?: string
}

/**
 * Revalidate one persona's findings for one feature. The orchestrator is
 * responsible for status mapping, persistence, and locking.
 */
export async function revalidateFeatureGroupWithAgent(
  options: RevalidateFeatureGroupWithAgentOptions,
): Promise<RevalidateFeatureGroupResult> {
  const built = await buildRevalidationPrompt({
    feature: options.feature,
    openFindings: options.openFindings,
    repoRoot: options.repoRoot,
  })

  // Surface vanished files: the agent will see status="missing" markers and
  // verdict accordingly, but operators benefit from a one-line summary so
  // unexpected "fixed" verdicts can be traced back to a deleted file.
  if (built.missingFiles.length > 0) {
    logger.info(
      `  ${options.persona.name}: ${built.missingFiles.length} cited file(s) missing on disk: ${built.missingFiles.join(', ')}`,
    )
  }

  const personaSystem = loadReviewerSystemPrompt(options.persona)
  const systemPrompt = personaSystem + '\n\n' + built.systemSuffix

  const result = await runAgenticReview({
    // Diff-mode inputs are unused when userPromptOverride is set, but the
    // type requires `diffContent` and `context`. Pass non-empty placeholders.
    diffContent: '',
    context: `repo-scope revalidation: ${options.feature.featureId}`,
    userPromptOverride: built.userPrompt,
    systemPrompt,
    model: options.model,
    repoRoot: options.repoRoot,
    repoUrl: options.repoUrl,
    branch: options.branch,
    indexerUrl: options.indexerUrl,
    maxIterations: options.maxIterations,
    timeout: options.timeoutSec,
    // Revalidate mode emits `kode-revalidations`, not `kode-findings`; we parse
    // that body ourselves below via parseRevalidationBlock. Without this flag
    // the engine would warn "missing kode-findings block" on every group.
    parseFindings: false,
  })

  const parsed = parseRevalidationBlock(result.content)
  const expectedIds = new Set(options.openFindings.map((r) => r.findingId))
  const verdicts = new Map<string, RevalidationVerdictEntry>()

  // Filter to known findingIds. Hallucinations get logged and dropped.
  for (const entry of parsed.revalidations) {
    if (!expectedIds.has(entry.findingId)) {
      logger.warn(
        `  ${options.persona.name}: agent emitted verdict for unknown findingId="${entry.findingId}" — dropping.`,
      )
      continue
    }
    if (verdicts.has(entry.findingId)) {
      logger.warn(
        `  ${options.persona.name}: duplicate verdict for findingId="${entry.findingId}" — last-wins.`,
      )
    }
    verdicts.set(entry.findingId, entry)
  }

  return {
    feature: options.feature,
    persona: options.persona,
    verdicts,
    content: result.content,
    usage: result.usage,
    truncated: result.truncated,
    truncationReason: result.truncationReason,
    blockParsed: parsed.error === undefined,
    blockError: parsed.error,
  }
}
