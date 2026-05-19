/**
 * Prompt construction for `--revalidate`.
 *
 * Re-targets a reviewer persona from "find issues" to "verify whether each
 * provided issue still exists." Sibling of `prompts.ts` (which drives initial
 * audit); reuses the file-inlining helpers there for consistency.
 *
 * The user prompt includes:
 *   1. A revalidation-mode preface explaining the three verdict states.
 *   2. Compact feature metadata (just enough for the persona to orient).
 *   3. Current contents of up to `MAX_REVALIDATION_FILES_IN_PROMPT` distinct
 *      files referenced by the open findings (so the agent can answer "does
 *      the problem still exist" without needing to call read_file for each
 *      one). Overflow files are listed by path under an "Additional cited
 *      files not inlined" header — reachable via tools, but excluded from
 *      the prompt body so a high-finding-count feature can't blow the
 *      context budget.
 *   4. The findings under review, sorted by `findingId` (deterministic
 *      ordering keeps the agent's output mapping stable across runs).
 *   5. Output instructions for the `kode-revalidations` block.
 */
import { escXmlAttr, langHintFromPath, pickFence, readFileForPrompt } from './prompts.js'
import { REVALIDATIONS_BLOCK_INSTRUCTIONS } from './revalidation-schema.js'
import { REPO_AUDIT_DEFAULTS, type FeatureRecord, type RepoFindingRecord } from './types.js'

/**
 * Suffix appended to the reviewer's system prompt when invoked in
 * revalidation mode. Kept short and additive: it re-targets the persona's
 * job from "find new issues" to "verdict each existing issue" without
 * contradicting the persona's own rubric.
 */
export const REVALIDATION_MODE_SUFFIX = `
## REVALIDATION MODE (added by --revalidate)

You are NOT looking for new issues. For each finding listed in the user
prompt's "Findings to Revalidate" section, decide whether the described
problem still exists in the current code.

Verdicts:
- "fixed" — the described problem no longer exists.
- "still-present" — the problem (or its equivalent) still exists.
- "uncertain" — you cannot tell without information not available.

Rules:
- Do not invent new findings. Your output must contain one verdict per
  findingId you were asked to check, and only those findingIds.
- "fixed" requires positive evidence the issue is gone, not absence of
  evidence. If you cannot find the cited problem AND cannot find an
  equivalent issue, but the file has changed substantially, prefer
  "uncertain" over "fixed".
- The originally cited file/line is a hint, not a query. The problem may
  have moved within the file or to a sibling module — chase it with the
  read_file and search_code tools when needed.
- Files marked status="missing" mean the cited file no longer exists in the
  repository. If the problem was localized to that file, verdict "fixed";
  otherwise verdict "uncertain".
`.trim()

export interface BuiltRevalidationPrompt {
  /** Suffix to append after the persona's template. */
  systemSuffix: string
  /** Structured user prompt body. */
  userPrompt: string
  /** Distinct file paths inlined in the prompt (subset of referenced files). */
  inlinedFiles: string[]
  /** Distinct file paths referenced by findings but missing on disk. */
  missingFiles: string[]
  /**
   * Distinct file paths cited by findings but NOT inlined because
   * `distinctFiles.length` exceeded `MAX_REVALIDATION_FILES_IN_PROMPT`. The
   * agent is told about them in a "use read_file" section so they remain
   * reachable, but their bodies do not consume prompt budget.
   *
   * Order matches the order of `distinctFiles` after the inline slice — i.e.
   * the overflow tail in finding-id-sorted order.
   */
  deferredFiles: string[]
}

export interface BuildRevalidationPromptOptions {
  feature: FeatureRecord
  /** All open findings in this (featureId, persona) group, in any order. */
  openFindings: RepoFindingRecord[]
  repoRoot: string
}

/**
 * Build the (system suffix, user prompt) pair for revalidating one
 * (featureId, persona) group.
 */
export async function buildRevalidationPrompt(
  opts: BuildRevalidationPromptOptions,
): Promise<BuiltRevalidationPrompt> {
  const { feature, openFindings, repoRoot } = opts

  // Deterministic ordering: the agent receives findings in a stable order
  // regardless of filesystem iteration order. Tests rely on this; so does
  // the user when comparing two runs of `--revalidate` against the same
  // record set.
  const sorted = [...openFindings].sort((a, b) => a.findingId.localeCompare(b.findingId))

  // Collect distinct files referenced by these findings. We inline up to
  // MAX_REVALIDATION_FILES_IN_PROMPT of them up-front so the agent doesn't
  // have to round-trip read_file per finding; anything past the cap is
  // listed by path with a "use read_file" hint instead of inlined.
  //
  // Without this cap, a feature whose open findings cite many files (e.g.
  // a cross-cutting persona's lint sweep) would inline every one, blowing
  // the prompt budget and degrading review quality on the very runs
  // revalidation is meant to make cheap.
  const distinctFiles = Array.from(new Set(sorted.map((r) => r.finding.file)))
  const filesToInline = distinctFiles.slice(
    0,
    REPO_AUDIT_DEFAULTS.MAX_REVALIDATION_FILES_IN_PROMPT,
  )
  const deferredFiles = distinctFiles.slice(
    REPO_AUDIT_DEFAULTS.MAX_REVALIDATION_FILES_IN_PROMPT,
  )

  const inlinedFiles: string[] = []
  const missingFiles: string[] = []
  const parts: string[] = []

  parts.push('## Revalidation Mode')
  parts.push('')
  parts.push(
    'You are revalidating previously-emitted findings against the current state of ' +
      'this repository. For each finding below, decide whether the described problem ' +
      'still exists in the code.',
  )
  parts.push('')

  parts.push('## Feature Under Review')
  parts.push('')
  parts.push('<feature_metadata>')
  parts.push(`featureId: ${feature.featureId}`)
  parts.push(`title: ${feature.title}`)
  parts.push(`kind: ${feature.kind}`)
  parts.push(`summary: ${feature.summary}`)
  if (feature.trustBoundaries.length > 0) {
    parts.push(`trust_boundaries: ${feature.trustBoundaries.join(', ')}`)
  }
  parts.push('</feature_metadata>')
  parts.push('')

  parts.push('## Current File Contents')
  parts.push('')
  for (const filePath of filesToInline) {
    const body = await readFileForPrompt(repoRoot, filePath)
    const pathAttr = escXmlAttr(filePath)
    if (body === null) {
      missingFiles.push(filePath)
      parts.push(`<file path="${pathAttr}" status="missing"/>`)
      parts.push('')
      continue
    }
    inlinedFiles.push(filePath)
    const fence = pickFence(body)
    parts.push(`<file path="${pathAttr}" status="present">`)
    parts.push(fence + langHintFromPath(filePath))
    parts.push(body)
    parts.push(fence)
    parts.push('</file>')
    parts.push('')
  }

  if (deferredFiles.length > 0) {
    // Deferred files are NOT inlined, but the agent must still know they
    // exist as candidate sources of evidence; the heading + per-path list
    // makes them reachable via the read_file / search_code tools.
    parts.push('### Additional cited files not inlined')
    parts.push('Use read_file / search_code tools to inspect these if needed:')
    for (const filePath of deferredFiles) {
      parts.push(`- ${filePath}`)
    }
    parts.push('')
  }

  parts.push('## Findings to Revalidate')
  parts.push('')
  for (const record of sorted) {
    const f = record.finding
    parts.push(`<finding id="${escXmlAttr(record.findingId)}" persona="${escXmlAttr(record.persona)}">`)
    parts.push(`originally cited: ${f.file}:${f.lineStart}-${f.lineEnd}`)
    parts.push(`severity: ${f.severity}`)
    parts.push(`category: ${f.category}`)
    parts.push(`title: ${f.title}`)
    parts.push(`problem: ${f.problem}`)
    parts.push(`evidence: ${f.evidence}`)
    parts.push(`recommendation: ${f.recommendation}`)
    parts.push('</finding>')
    parts.push('')
  }

  parts.push('## Output Instructions')
  parts.push('')
  parts.push(REVALIDATIONS_BLOCK_INSTRUCTIONS)

  return {
    systemSuffix: REVALIDATION_MODE_SUFFIX,
    userPrompt: parts.join('\n'),
    inlinedFiles,
    missingFiles,
    deferredFiles,
  }
}
