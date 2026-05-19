/**
 * kode-agent engine for repo-scope review.
 *
 * Loads the persona's system prompt, appends the FEATURE_REVIEW_MODE_SUFFIX,
 * builds a feature-shaped user prompt, and runs the existing agentic engine
 * with tools enabled so the model can explore beyond owned/context files.
 *
 * Caps emitted findings at REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE.
 */
import { runAgenticReview } from '../../review/engine.js'
import type { Finding } from '../../review/finding-schema.js'
import type { UsageTotals } from '../../review/usage.js'
import {
  loadReviewerSystemPrompt,
  type ReviewerInfo,
} from '../../reviewers/index.js'
import { buildFeatureReviewPrompt } from '../prompts.js'
import {
  REPO_AUDIT_DEFAULTS,
  type FeatureRecord,
} from '../types.js'

export interface ReviewFeatureWithAgentOptions {
  feature: FeatureRecord
  persona: ReviewerInfo
  repoRoot: string
  repoUrl: string
  branch?: string
  indexerUrl?: string
  model?: string
  /** Max tool-call iterations. */
  maxIterations?: number
  /** Hard ceiling in seconds. Default: 600. */
  timeoutSec?: number
}

export interface ReviewFeatureResult {
  feature: FeatureRecord
  persona: ReviewerInfo
  findings: Finding[]
  /** Raw model output (for debugging / mirror writers). */
  content: string
  usage: UsageTotals
  /** True if the agent hit max iterations before producing structured output. */
  truncated: boolean
  truncationReason?: string
}

/**
 * Review one feature with one persona. Returns the parsed findings (capped)
 * plus raw output and usage. The caller (runner.ts) wraps multiple calls
 * across personas/features under a worker pool with locking.
 */
export async function reviewFeatureWithAgent(
  options: ReviewFeatureWithAgentOptions,
): Promise<ReviewFeatureResult> {
  const built = await buildFeatureReviewPrompt({
    feature: options.feature,
    repoRoot: options.repoRoot,
  })

  // Persona system prompt + feature mode adapter.
  const personaSystem = loadReviewerSystemPrompt(options.persona)
  const systemPrompt = personaSystem + '\n\n' + built.systemSuffix

  const result = await runAgenticReview({
    // Diff-mode inputs are unused when userPromptOverride is set, but the
    // type requires `diffContent` and `context`. Pass non-empty placeholders
    // so prompt-version drift in the unused buildAgenticPrompt is harmless.
    diffContent: '',
    context: `repo-scope feature review: ${options.feature.featureId}`,
    userPromptOverride: built.userPrompt,
    systemPrompt,
    model: options.model,
    repoRoot: options.repoRoot,
    repoUrl: options.repoUrl,
    branch: options.branch,
    indexerUrl: options.indexerUrl,
    maxIterations: options.maxIterations,
    timeout: options.timeoutSec,
  })

  // Cap findings — the prompt already asks for prioritization, but defend in
  // depth so a chatty model doesn't blow past the cap.
  const cap = REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE
  const findings = result.findings.slice(0, cap)

  return {
    feature: options.feature,
    persona: options.persona,
    findings,
    content: result.content,
    usage: result.usage,
    truncated: result.truncated,
    truncationReason: result.truncationReason,
  }
}
