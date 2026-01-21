/**
 * Review prompt template - base instructions
 */
const REVIEW_PROMPT_BASE = `You are an expert code reviewer. Perform a thorough and exhaustive code review of the following changes.`

/**
 * Context limitations when NO semantic context is available
 */
const CONTEXT_LIMITATIONS_NO_CONTEXT = `
## Important Context Limitations

**You can only see files included in the diff below.** You cannot see:
- Files that exist on disk but aren't in this diff
- Previously committed files not modified in this change
- Untracked or gitignored files

If a config file (package.json, tsconfig.json, etc.) references a file path that you don't see in the diff:
- Do NOT assume the file is missing
- Note it as "Unable to verify - file not in diff" rather than reporting it as a bug
- Only report missing file issues with LOW confidence`

/**
 * Context limitations when semantic context IS available
 */
const CONTEXT_LIMITATIONS_WITH_CONTEXT = `
## Available Context

You have access to two types of context for this review:

1. **The Diff**: The actual code changes being reviewed (primary focus)
2. **Related Code**: Semantically similar code from the repository that may help you understand patterns, conventions, and how the changes integrate with the existing codebase

**Important notes about Related Code:**
- This is retrieved via semantic search - it shows code *similar* to the changes, not necessarily *all* related code
- Use it to understand existing patterns and verify consistency
- It may include callers, similar implementations, or related utilities
- If something seems inconsistent with related code, flag it - but acknowledge the context is partial

**You still cannot see:**
- All files in the repository (only semantically related snippets)
- Configuration files unless they appear in the diff or related code
- Test files unless they appear in the diff or related code

When referencing related code in your review, cite it explicitly (e.g., "The related code shows a similar pattern in utils.ts...")`

/**
 * Review criteria without semantic context
 */
const REVIEW_CRITERIA_BASE = `
## Review Criteria

Analyze the code for the following, in order of priority:

### 1. Security Issues (CRITICAL)
- Injection vulnerabilities (SQL, command, XSS, etc.)
- Authentication/authorization flaws
- Sensitive data exposure
- Insecure dependencies or configurations
- Path traversal, SSRF, or other OWASP Top 10 issues

### 2. Bugs & Logic Errors (HIGH)
- Off-by-one errors, null pointer issues
- Race conditions or concurrency problems
- Incorrect error handling
- Edge cases not handled
- Resource leaks (memory, file handles, connections)

### 3. Code Quality (MEDIUM)
- DRY violations (duplicated code)
- SOLID principle violations
- Overly complex logic (high cyclomatic complexity)
- Poor naming or unclear intent
- Missing or inadequate error handling

### 4. Conventions & Best Practices (LOW)
- Coding style inconsistencies
- Missing documentation for public APIs
- Improper use of language idioms
- Unnecessary dependencies or imports`

/**
 * Additional review criteria when semantic context is available
 */
const REVIEW_CRITERIA_WITH_CONTEXT = `

### 5. Codebase Consistency (MEDIUM) - Context-Aware
Use the **Related Code** section to check for:
- **Pattern violations**: Does the new code follow established patterns visible in related code?
- **API consistency**: Do new functions/methods match the style of similar existing ones?
- **Naming conventions**: Are names consistent with how similar concepts are named elsewhere?
- **Error handling patterns**: Does error handling match the project's established approach?
- **Breaking changes**: Could changes break existing callers visible in the related code?

When you find inconsistencies with the related code, cite the specific example:
- GOOD: "The related code in \`utils.ts\` uses \`async/await\` but this function uses callbacks"
- BAD: "This doesn't match project conventions"`

/**
 * Review scope section
 */
const REVIEW_SCOPE = `
## Review Scope

**Be exhaustive.** Report ALL issues you find, not just the top few. A thorough review should typically find 5-15 issues in a medium-sized diff. If you find fewer than 3 issues in a non-trivial diff, double-check that you haven't missed anything.

Focus primarily on **changed lines** (+ lines in the diff). Only flag issues in context lines if they are directly affected by or related to the changes.

## Output Format

Provide your review in the following structure:

### Summary
A brief 2-3 sentence overview of the changes and overall code quality.

### Issues Found

Report ALL issues found. For each issue:

\`\`\`
**[SEVERITY: CRITICAL|HIGH|MEDIUM|LOW]** - Category: Brief title

File: <filename>:<line_number>

Problem:
<description of the issue>

Problematic Code:
\`\`\`<language>
<the problematic code snippet>
\`\`\`

Suggested Fix:
\`\`\`<language>
<the corrected code>
\`\`\`

Confidence: HIGH|MEDIUM|LOW
\`\`\`

**Confidence Guidelines:**
- **HIGH**: You are certain this is an issue based on visible code
- **MEDIUM**: Likely an issue, but depends on context you can't fully see
- **LOW**: Possible issue, but could be intentional or handled elsewhere`

/**
 * Enhanced confidence guidelines when semantic context is available
 */
const CONFIDENCE_GUIDELINES_WITH_CONTEXT = `
**Confidence Adjustments with Related Code:**
- **Upgrade to HIGH** if related code confirms the issue (e.g., you see the pattern done correctly elsewhere)
- **Upgrade to HIGH** if related code shows callers that would break
- **Downgrade to LOW** if related code shows intentional variation (e.g., different approach for good reason)
- **Cite your evidence**: "Confidence HIGH because related code in \`auth.ts\` shows the correct pattern"`

/**
 * Base confidence guidelines (no semantic context)
 */
const CONFIDENCE_GUIDELINES_BASE = `

**Formatting note:** For large reviews with more than 5 HIGH/CRITICAL issues, you may abbreviate MEDIUM/LOW issues to just the title and one-line description.

### Positive Observations
Note 2-3 things done well (good patterns, security practices, clean code, etc.).

### Final Verdict

\`\`\`
RECOMMENDATION: [APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION]

Confidence Level: [HIGH | MEDIUM | LOW]

Merge Decision: [SAFE_TO_MERGE | DO_NOT_MERGE | CONDITIONAL_MERGE]

Rationale: <1-2 sentence explanation>

Issues Summary: X CRITICAL, Y HIGH, Z MEDIUM, W LOW
\`\`\`

If CONDITIONAL_MERGE, specify what must be addressed before merging.

---
`

export interface ReviewPromptOptions {
  context: string
  diffContent: string
  prMrInfo?: string
  /** Semantic context from the code indexer */
  semanticContext?: string
  /** PR/MR description summary to provide author intent context */
  prDescriptionSummary?: string
}

/**
 * Known structural XML tags used in prompts
 * These must be escaped in user content to prevent tag injection
 */
const STRUCTURAL_TAGS = ['pr_mr_info', 'related_code', 'diff_content', 'author_intent']

/**
 * Sanitize content to prevent XML tag injection
 * Escapes all structural tags that could break prompt structure
 */
function sanitizeXmlContent(content: string, _tagName: string): string {
  let sanitized = content

  // Escape all known structural tags (both opening and closing)
  // This prevents content from injecting fake boundaries
  for (const tag of STRUCTURAL_TAGS) {
    // Escape closing tags: </tag> -> <\/tag>
    sanitized = sanitized.replace(
      new RegExp(`</${tag}>`, 'gi'),
      `<\\/${tag}>`
    )
    // Escape opening tags: <tag> -> <\tag>
    sanitized = sanitized.replace(
      new RegExp(`<${tag}>`, 'gi'),
      `<\\${tag}>`
    )
  }

  return sanitized
}

/**
 * Build the review template dynamically based on available context
 */
function buildReviewTemplate(hasSemanticContext: boolean): string {
  const parts: string[] = [REVIEW_PROMPT_BASE]

  // Add appropriate context limitations section
  if (hasSemanticContext) {
    parts.push(CONTEXT_LIMITATIONS_WITH_CONTEXT)
  } else {
    parts.push(CONTEXT_LIMITATIONS_NO_CONTEXT)
  }

  // Add base review criteria
  parts.push(REVIEW_CRITERIA_BASE)

  // Add context-aware criteria if semantic context is available
  if (hasSemanticContext) {
    parts.push(REVIEW_CRITERIA_WITH_CONTEXT)
  }

  // Add review scope and output format
  parts.push(REVIEW_SCOPE)

  // Add enhanced confidence guidelines if semantic context is available
  if (hasSemanticContext) {
    parts.push(CONFIDENCE_GUIDELINES_WITH_CONTEXT)
  }

  // Add the rest of the output format (positive observations, verdict)
  parts.push(CONFIDENCE_GUIDELINES_BASE)

  return parts.join('\n')
}

/**
 * Build the complete review prompt
 */
export function buildReviewPrompt(options: ReviewPromptOptions): string {
  const hasSemanticContext = Boolean(options.semanticContext)
  const template = buildReviewTemplate(hasSemanticContext)

  const parts: string[] = [template]

  parts.push('## Context')
  parts.push(options.context)
  parts.push('')

  // Include author intent summary prominently when available
  if (options.prDescriptionSummary) {
    parts.push('## Author Intent')
    parts.push('')
    parts.push('The PR/MR author describes the purpose of these changes as:')
    parts.push('')
    parts.push('<author_intent>')
    parts.push(sanitizeXmlContent(options.prDescriptionSummary, 'author_intent'))
    parts.push('</author_intent>')
    parts.push('')
    parts.push('Use this context to understand what the author is trying to accomplish and verify the implementation matches the stated intent.')
    parts.push('')
  }

  if (options.prMrInfo) {
    parts.push('## PR/MR Information')
    parts.push('<pr_mr_info>')
    parts.push(sanitizeXmlContent(options.prMrInfo, 'pr_mr_info'))
    parts.push('</pr_mr_info>')
    parts.push('')
  }

  if (options.semanticContext) {
    parts.push('## Related Code Context')
    parts.push('')
    parts.push('The following code snippets are semantically related to the changes being reviewed.')
    if (options.prDescriptionSummary) {
      parts.push('Chunks marked [PR_INTENT] were retrieved based on the PR description.')
    }
    parts.push('')
    parts.push('<related_code>')
    parts.push(sanitizeXmlContent(options.semanticContext, 'related_code'))
    parts.push('</related_code>')
    parts.push('')
  }

  parts.push('## Code Changes (Diff)')
  parts.push('<diff_content>')
  parts.push(sanitizeXmlContent(options.diffContent, 'diff_content'))
  parts.push('</diff_content>')

  return parts.join('\n')
}

/**
 * Legacy export for backwards compatibility
 * @deprecated Use buildReviewPrompt() instead
 */
export const REVIEW_PROMPT_TEMPLATE = buildReviewTemplate(false)
