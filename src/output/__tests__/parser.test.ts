import { describe, it, expect } from 'vitest'
import {
  parseReviewContent,
  extractSummary,
  extractIssues,
  extractPositives,
  extractVerdict,
  countIssuesBySeverity,
} from '../parser.js'

describe('parseReviewContent', () => {
  const SAMPLE_REVIEW = `### Summary

This PR introduces a new authentication module with JWT token handling.

### Issues Found

**[SEVERITY: CRITICAL]** - Security: SQL injection vulnerability

File: \`src/auth/login.ts:45\`

Problem:
User input is directly interpolated into SQL query without sanitization.

Problematic Code:
\`\`\`typescript
const query = \`SELECT * FROM users WHERE email = '\${email}'\`
\`\`\`

Suggested Fix:
\`\`\`typescript
const query = 'SELECT * FROM users WHERE email = $1'
const result = await db.query(query, [email])
\`\`\`

Confidence: HIGH

**[SEVERITY: HIGH]** - Logic: Missing null check

File: \`src/auth/session.ts:23-25\`

Problem:
The session object may be null, but no check is performed.

Confidence: MEDIUM

**[SEVERITY: LOW]** - Style: Inconsistent naming

File: \`src/auth/utils.ts:10\`

Problem:
Function uses camelCase but project convention is snake_case.

Confidence: LOW

### Positive Observations

- Good use of TypeScript generics for type safety
- Well-structured error handling with custom error classes
- Comprehensive JSDoc comments on public APIs

### Final Verdict

RECOMMENDATION: REQUEST_CHANGES

Confidence Level: HIGH

Merge Decision: DO_NOT_MERGE

Rationale: Critical SQL injection vulnerability must be fixed before merge.

Issues Summary: 1 CRITICAL, 1 HIGH, 0 MEDIUM, 1 LOW
`

  it('parses a complete review into structured data', () => {
    const result = parseReviewContent(SAMPLE_REVIEW)

    expect(result).not.toBeNull()
    expect(result!.summary).toContain('authentication module')
    expect(result!.issues.length).toBe(3) // Expect all 3 issues parsed
    expect(result!.issues[0].severity).toBe('CRITICAL')
    expect(result!.issues[1].severity).toBe('HIGH')
    expect(result!.issues[2].severity).toBe('LOW')
    expect(result!.verdict.recommendation).toBe('REQUEST_CHANGES')
  })

  it('extracts issues with correct severity levels', () => {
    const result = parseReviewContent(SAMPLE_REVIEW)

    // Find the critical issue
    const criticalIssue = result!.issues.find(i => i.severity === 'CRITICAL')
    expect(criticalIssue).toBeDefined()
    expect(criticalIssue!.category).toBe('Security')
    expect(criticalIssue!.title).toContain('SQL injection')
  })

  it('returns null for empty or invalid input', () => {
    expect(parseReviewContent('')).toBeNull()
    expect(parseReviewContent('  ')).toBeNull()
    expect(parseReviewContent(null as unknown as string)).toBeNull()
    expect(parseReviewContent(undefined as unknown as string)).toBeNull()
  })

  it('handles minimal valid content', () => {
    const minimal = `### Summary

A simple change.

### Final Verdict

RECOMMENDATION: APPROVE
Merge Decision: SAFE_TO_MERGE
`
    const result = parseReviewContent(minimal)
    expect(result).not.toBeNull()
    expect(result!.summary).toContain('simple change')
    expect(result!.verdict.recommendation).toBe('APPROVE')
  })
})

describe('extractSummary', () => {
  it('extracts summary from standard format', () => {
    const content = `### Summary

This is the summary text.

### Issues Found

Some issues here.
`
    const result = extractSummary(content)
    expect(result).toBe('This is the summary text.')
  })

  it('handles ## Summary format', () => {
    const content = `## Summary

Brief overview of changes.

## Issues
`
    const result = extractSummary(content)
    expect(result).toBe('Brief overview of changes.')
  })

  it('returns empty string when no summary found', () => {
    const content = `### Issues Found

Some issues here.
`
    const result = extractSummary(content)
    expect(result).toBe('')
  })
})

describe('extractIssues', () => {
  it('extracts issues with standard format', () => {
    const content = `### Issues Found

**[SEVERITY: CRITICAL]** - Security: XSS vulnerability

File: \`app.js:10\`

Problem:
User input not escaped.

Confidence: HIGH

**[SEVERITY: MEDIUM]** - Code Quality: Duplicate code

File: \`utils.js:50\`

Problem:
Same logic appears in two places.

Confidence: MEDIUM

### Positive Observations
`
    const issues = extractIssues(content)

    expect(issues.length).toBe(2)
    expect(issues[0].severity).toBe('CRITICAL')
    expect(issues[0].category).toBe('Security')
    expect(issues[0].title).toContain('XSS vulnerability')
    expect(issues[0].file).toBe('app.js')
    expect(issues[0].line).toBe(10)
    expect(issues[1].severity).toBe('MEDIUM')
    expect(issues[1].category).toBe('Code Quality')
  })

  it('extracts file paths with line numbers', () => {
    const content = `**[SEVERITY: HIGH]** - Bug: Race condition

File: \`src/concurrent.ts:100\`

Problem:
Shared state modified without locks.

Confidence: HIGH

### End
`
    const issues = extractIssues(content)

    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('HIGH')
    expect(issues[0].category).toBe('Bug')
    expect(issues[0].title).toContain('Race condition')
    expect(issues[0].file).toBe('src/concurrent.ts')
    expect(issues[0].line).toBe(100)
    expect(issues[0].confidence).toBe('HIGH')
  })

  it('returns empty array for content without issues', () => {
    const content = `### Summary

Everything looks good!

### Final Verdict

RECOMMENDATION: APPROVE
`
    const issues = extractIssues(content)
    expect(issues).toEqual([])
  })
})

describe('extractPositives', () => {
  it('extracts bullet point positives', () => {
    const content = `### Positive Observations

- Good test coverage
- Clean code structure

### Final Verdict
`
    const positives = extractPositives(content)

    expect(positives.length).toBe(2)
    expect(positives[0]).toBe('Good test coverage')
    expect(positives[1]).toBe('Clean code structure')
  })

  it('handles asterisk bullets', () => {
    const content = `### Positive Observations

* First positive observation here
* Second positive observation

### End
`
    const positives = extractPositives(content)

    expect(positives.length).toBe(2)
    expect(positives[0]).toBe('First positive observation here')
    expect(positives[1]).toBe('Second positive observation')
  })

  it('returns empty array when no positives section', () => {
    const content = `### Summary

Some content here.
`
    const positives = extractPositives(content)
    expect(positives).toEqual([])
  })
})

describe('extractVerdict', () => {
  it('extracts verdict from section', () => {
    const content = `### Final Verdict

RECOMMENDATION: APPROVE

Confidence Level: HIGH

Merge Decision: SAFE_TO_MERGE

Rationale: All checks pass and code quality is good.

Issues Summary: 0 CRITICAL, 0 HIGH, 2 MEDIUM, 1 LOW
`
    const verdict = extractVerdict(content)

    expect(verdict).not.toBeNull()
    expect(verdict!.recommendation).toBe('APPROVE')
    expect(verdict!.mergeDecision).toBe('SAFE_TO_MERGE')
    expect(verdict!.issueSummary).toEqual({
      critical: 0,
      high: 0,
      medium: 2,
      low: 1,
    })
  })

  it('extracts REQUEST_CHANGES verdict', () => {
    const content = `### Final Verdict

RECOMMENDATION: REQUEST_CHANGES

Merge Decision: DO_NOT_MERGE
`
    const verdict = extractVerdict(content)

    expect(verdict!.recommendation).toBe('REQUEST_CHANGES')
    expect(verdict!.mergeDecision).toBe('DO_NOT_MERGE')
  })

  it('returns null when no verdict found', () => {
    const content = `### Summary

Just a summary, no verdict.
`
    const verdict = extractVerdict(content)
    expect(verdict).toBeNull()
  })

  it('falls back to simple pattern matching', () => {
    const content = `The code looks okay.

RECOMMENDATION: APPROVE
`
    const verdict = extractVerdict(content)

    expect(verdict).not.toBeNull()
    expect(verdict!.recommendation).toBe('APPROVE')
    expect(verdict!.mergeDecision).toBe('SAFE_TO_MERGE')
  })
})

describe('countIssuesBySeverity', () => {
  it('counts issues correctly by severity', () => {
    const issues = [
      { severity: 'CRITICAL' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'HIGH' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'HIGH' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'MEDIUM' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'LOW' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'LOW' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
      { severity: 'LOW' as const, category: '', title: '', description: '', confidence: 'HIGH' as const },
    ]

    const counts = countIssuesBySeverity(issues)

    expect(counts).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 3,
    })
  })

  it('returns zeros for empty array', () => {
    const counts = countIssuesBySeverity([])

    expect(counts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    })
  })
})
