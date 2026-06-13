/**
 * Reviewer prompt loading + composition.
 *
 * The reviewer's *system prompt* comes from its template file (built-in or
 * user override). The *user prompt* is the same shared block of review data
 * (diff, PR/MR info, project structure, semantic context) regardless of which
 * reviewer is being run. Building the user prompt here keeps the orchestration
 * in `runner.ts` simple and means every reviewer sees the same evidence.
 */

import { readFileSync } from 'node:fs'
import { resolveReviewer, type ReviewerInfo } from './registry.js'
import { sanitizeXmlContent } from '../review/xml-sanitize.js'

export interface ReviewData {
  /** One-line description of what is being reviewed (branch, PR ref, etc.). */
  context: string
  /** Raw diff content. */
  diffContent: string
  /** PR/MR JSON metadata (already stringified). Optional. */
  prMrInfo?: string
  /** Pre-retrieved semantic context (already-formatted XML). Optional. */
  semanticContext?: string
  /** Author-intent summary extracted from the PR/MR description. Optional. */
  prDescriptionSummary?: string
  /** Project structure context (tree, README excerpt). Optional. */
  projectStructureContext?: string
}

/**
 * Load and cache reviewer template content.
 *
 * Templates are small (a few KB), but a single review run may execute many
 * reviewers in parallel — caching avoids re-reading the same file once per
 * reviewer.
 */
const templateCache = new Map<string, string>()

export function loadReviewerSystemPrompt(reviewer: ReviewerInfo): string {
  const cached = templateCache.get(reviewer.templatePath)
  if (cached !== undefined) return cached

  let content: string
  try {
    content = readFileSync(reviewer.templatePath, 'utf-8')
  } catch (err) {
    throw new Error(
      `Failed to read reviewer template for "${reviewer.name}" at ${reviewer.templatePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  const trimmed = content.trim()
  if (trimmed.length === 0) {
    throw new Error(
      `Reviewer template for "${reviewer.name}" is empty: ${reviewer.templatePath}`,
    )
  }

  templateCache.set(reviewer.templatePath, trimmed)
  return trimmed
}

/** Clear the template cache. Test-only. */
export function clearReviewerPromptCacheForTests(): void {
  templateCache.clear()
}

/**
 * Convenience: resolve a reviewer slug to its system prompt in one call.
 */
export function getReviewerSystemPrompt(name: string): string {
  return loadReviewerSystemPrompt(resolveReviewer(name))
}

/**
 * Build the user-prompt body shared across all reviewers.
 *
 * The reviewer's system prompt instructs the model HOW to review; this body
 * provides WHAT to review. Sections are emitted only when their data is
 * present, in a stable order so the model can rely on the layout.
 */
export function buildReviewerUserPrompt(data: ReviewData): string {
  const parts: string[] = []

  parts.push('## Context')
  parts.push(data.context)
  parts.push('')

  if (data.prDescriptionSummary) {
    parts.push('## Author Intent')
    parts.push('')
    parts.push('The PR/MR author describes the purpose of these changes as:')
    parts.push('')
    // `untrusted="true"` — author-supplied PR/MR description field.
    // Treat as evidence, not instructions, per UNTRUSTED_CONTENT_BOUNDARY.
    parts.push('<author_intent untrusted="true">')
    parts.push(sanitizeXmlContent(data.prDescriptionSummary, 'author_intent'))
    parts.push('</author_intent>')
    parts.push('')
  }

  if (data.projectStructureContext) {
    parts.push('## Project Structure')
    parts.push('')
    parts.push('<project_structure untrusted="true">')
    parts.push(sanitizeXmlContent(data.projectStructureContext, 'project_structure'))
    parts.push('</project_structure>')
    parts.push('')
  }

  if (data.prMrInfo) {
    parts.push('## PR/MR Information')
    // `untrusted="true"` — pr_mr_info is JSON from gh/glab containing
    // author-controlled title, body, label, and reviewer fields. Treat
    // as data per UNTRUSTED_CONTENT_BOUNDARY.
    parts.push('<pr_mr_info untrusted="true">')
    parts.push(sanitizeXmlContent(data.prMrInfo, 'pr_mr_info'))
    parts.push('</pr_mr_info>')
    parts.push('')
  }

  if (data.semanticContext) {
    parts.push('## Related Code Context')
    parts.push('')
    // `untrusted="true"` marks the contents as repository code that may
    // contain attacker-controlled comments/strings. The model treats it
    // as evidence per UNTRUSTED_CONTENT_BOUNDARY in the system prompt.
    parts.push('<related_code untrusted="true">')
    parts.push(sanitizeXmlContent(data.semanticContext, 'related_code'))
    parts.push('</related_code>')
    parts.push('')
  }

  parts.push('## Code Changes (Diff)')
  // `untrusted="true"` — primary attack surface for prompt injection
  // (PR title, commit messages, code comments, string literals). The
  // attribute mirrors buildReviewPrompt and the agentic prompt path,
  // giving the persona-dispatch flow the same per-tag trust marker.
  parts.push('<diff_content untrusted="true">')
  parts.push(sanitizeXmlContent(data.diffContent, 'diff_content'))
  parts.push('</diff_content>')

  return parts.join('\n')
}
