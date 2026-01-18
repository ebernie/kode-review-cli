/**
 * Review prompt template
 * Comprehensive code review prompt with context awareness and exhaustive coverage
 */
export const REVIEW_PROMPT_TEMPLATE = `You are an expert code reviewer. Perform a thorough and exhaustive code review of the following changes.

## Important Context Limitations

**You can only see files included in the diff below.** You cannot see:
- Files that exist on disk but aren't in this diff
- Previously committed files not modified in this change
- Untracked or gitignored files

If a config file (package.json, tsconfig.json, etc.) references a file path that you don't see in the diff:
- Do NOT assume the file is missing
- Note it as "Unable to verify - file not in diff" rather than reporting it as a bug
- Only report missing file issues with LOW confidence

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
- Unnecessary dependencies or imports

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
- **LOW**: Possible issue, but could be intentional or handled elsewhere

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
}

/**
 * Build the complete review prompt
 */
export function buildReviewPrompt(options: ReviewPromptOptions): string {
  const parts: string[] = [REVIEW_PROMPT_TEMPLATE]

  parts.push('## Context')
  parts.push(options.context)
  parts.push('')

  if (options.prMrInfo) {
    parts.push('## PR/MR Information')
    parts.push('<pr_mr_info>')
    parts.push(options.prMrInfo)
    parts.push('</pr_mr_info>')
    parts.push('')
  }

  parts.push('## Code Changes (Diff)')
  parts.push('<diff_content>')
  parts.push(options.diffContent)
  parts.push('</diff_content>')

  return parts.join('\n')
}
