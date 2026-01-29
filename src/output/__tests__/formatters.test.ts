import { describe, it, expect } from 'vitest'
import {
  formatAsText,
  formatAsJson,
  formatAsMarkdown,
  formatForPRComment,
} from '../formatters.js'
import type { ReviewOutput, StructuredReview } from '../types.js'

const mockStructuredReview: StructuredReview = {
  summary: 'This PR adds a new authentication module with JWT support.',
  issues: [
    {
      severity: 'CRITICAL',
      category: 'Security',
      title: 'SQL injection vulnerability',
      file: 'src/auth/login.ts',
      line: 45,
      description: 'User input directly interpolated into SQL query.',
      codeSnippet: 'const query = `SELECT * FROM users WHERE email = \'${email}\'`',
      suggestion: 'const query = \'SELECT * FROM users WHERE email = $1\'',
      confidence: 'HIGH',
    },
    {
      severity: 'HIGH',
      category: 'Logic',
      title: 'Missing null check',
      file: 'src/auth/session.ts',
      line: 23,
      endLine: 25,
      description: 'Session object may be null.',
      confidence: 'MEDIUM',
    },
    {
      severity: 'LOW',
      category: 'Style',
      title: 'Inconsistent naming',
      file: 'src/auth/utils.ts',
      line: 10,
      description: 'Function uses camelCase but project convention is snake_case.',
      confidence: 'LOW',
    },
  ],
  positives: [
    'Good use of TypeScript generics',
    'Well-structured error handling',
    'Comprehensive JSDoc comments',
  ],
  verdict: {
    recommendation: 'REQUEST_CHANGES',
    confidence: 'HIGH',
    mergeDecision: 'DO_NOT_MERGE',
    rationale: 'Critical SQL injection vulnerability must be fixed.',
    issueSummary: { critical: 1, high: 1, medium: 0, low: 1 },
  },
  metadata: {
    timestamp: '2024-01-15T10:30:00Z',
    scope: 'pr',
    agentic: false,
    prNumber: 42,
    branch: 'feature/auth',
  },
}

const mockReviewOutput: ReviewOutput = {
  raw: '# Review\n\nThis is the raw markdown content...',
  structured: mockStructuredReview,
}

const mockReviewOutputNoStructured: ReviewOutput = {
  raw: '# Review\n\nThis is raw content without structured data.',
}

describe('formatAsText', () => {
  it('returns raw content when structured data exists', () => {
    const result = formatAsText(mockReviewOutput)
    expect(result).toBe(mockReviewOutput.raw)
  })

  it('returns raw content when no structured data', () => {
    const result = formatAsText(mockReviewOutputNoStructured)
    expect(result).toBe(mockReviewOutputNoStructured.raw)
  })
})

describe('formatAsJson', () => {
  it('outputs valid JSON with all fields', () => {
    const result = formatAsJson(mockReviewOutput)
    const parsed = JSON.parse(result)

    expect(parsed.summary).toBe(mockStructuredReview.summary)
    expect(parsed.issues).toHaveLength(3)
    expect(parsed.positives).toHaveLength(3)
    expect(parsed.verdict.recommendation).toBe('REQUEST_CHANGES')
  })

  it('includes computed issue counts', () => {
    const result = formatAsJson(mockReviewOutput)
    const parsed = JSON.parse(result)

    expect(parsed.issueCount).toEqual({
      critical: 1,
      high: 1,
      medium: 0,
      low: 1,
    })
  })

  it('includes metadata by default', () => {
    const result = formatAsJson(mockReviewOutput)
    const parsed = JSON.parse(result)

    expect(parsed.metadata).toBeDefined()
    expect(parsed.metadata.timestamp).toBe('2024-01-15T10:30:00Z')
    expect(parsed.metadata.prNumber).toBe(42)
  })

  it('excludes metadata when option set to false', () => {
    const result = formatAsJson(mockReviewOutput, { includeMetadata: false })
    const parsed = JSON.parse(result)

    expect(parsed.metadata).toBeUndefined()
  })

  it('includes raw content when requested', () => {
    const result = formatAsJson(mockReviewOutput, { includeRaw: true })
    const parsed = JSON.parse(result)

    expect(parsed.raw).toBe(mockReviewOutput.raw)
  })

  it('handles missing structured data gracefully', () => {
    const result = formatAsJson(mockReviewOutputNoStructured)
    const parsed = JSON.parse(result)

    expect(parsed.summary).toBeNull()
    expect(parsed.issues).toEqual([])
    expect(parsed.parseError).toBe(true)
  })

  it('produces properly formatted JSON with indentation', () => {
    const result = formatAsJson(mockReviewOutput)

    // Should have newlines for readability
    expect(result).toContain('\n')
    // Should be parseable
    expect(() => JSON.parse(result)).not.toThrow()
  })
})

describe('formatAsMarkdown', () => {
  it('generates markdown report with header', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('# Code Review Report')
  })

  it('includes metadata section', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('**Generated:**')
    expect(result).toContain('2024-01-15T10:30:00Z')
    expect(result).toContain('PR #42')
  })

  it('includes summary section', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('## Summary')
    expect(result).toContain('authentication module')
  })

  it('includes issues with severity icons', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('## Issues Found (3)')
    expect(result).toContain('🔴 CRITICAL')
    expect(result).toContain('🟠 HIGH')
    expect(result).toContain('🔵 LOW')
  })

  it('includes issue details with file locations', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('`src/auth/login.ts:45`')
    expect(result).toContain('`src/auth/session.ts:23-25`')
  })

  it('includes positive observations', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('## Positive Observations')
    expect(result).toContain('Good use of TypeScript generics')
  })

  it('includes verdict section with indicators', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('## Verdict')
    expect(result).toContain('❌ REQUEST_CHANGES')
    expect(result).toContain('🔴 DO NOT MERGE')
  })

  it('includes footer with attribution', () => {
    const result = formatAsMarkdown(mockReviewOutput)

    expect(result).toContain('Generated by [kode-review]')
  })

  it('handles missing structured data', () => {
    const result = formatAsMarkdown(mockReviewOutputNoStructured)

    expect(result).toContain('# Code Review Report')
    expect(result).toContain('raw content without structured data')
  })

  it('omits metadata when option set to false', () => {
    const result = formatAsMarkdown(mockReviewOutput, { includeMetadata: false })

    expect(result).not.toContain('**Generated:**')
    // Summary should still be present
    expect(result).toContain('## Summary')
  })
})

describe('formatForPRComment', () => {
  it('produces compact format suitable for PR comments', () => {
    const result = formatForPRComment(mockStructuredReview)

    expect(result).toContain('## 🤖 Automated Code Review')
    expect(result).toContain('### Summary')
    expect(result).toContain('<details>')
  })

  it('includes collapsible issues section', () => {
    const result = formatForPRComment(mockStructuredReview)

    expect(result).toContain('<summary>📋 Issues Found</summary>')
    expect(result).toContain('</details>')
  })

  it('shows issue badges', () => {
    const result = formatForPRComment(mockStructuredReview)

    expect(result).toContain('🔴 1 Critical')
    expect(result).toContain('🟠 1 High')
    expect(result).toContain('🔵 1 Low')
  })

  it('shows verdict with indicator', () => {
    const result = formatForPRComment(mockStructuredReview)

    expect(result).toContain('### Verdict: ❌ REQUEST CHANGES')
  })

  it('truncates very long content', () => {
    const reviewWithManyIssues: StructuredReview = {
      ...mockStructuredReview,
      issues: Array(100).fill(mockStructuredReview.issues[0]),
    }

    const result = formatForPRComment(reviewWithManyIssues, { maxLength: 1000 })

    expect(result.length).toBeLessThanOrEqual(1000)
    expect(result).toContain('truncated')
  })

  it('shows APPROVE verdict with checkmark', () => {
    const approvedReview: StructuredReview = {
      ...mockStructuredReview,
      verdict: {
        ...mockStructuredReview.verdict,
        recommendation: 'APPROVE',
      },
    }

    const result = formatForPRComment(approvedReview)

    expect(result).toContain('### Verdict: ✅ APPROVE')
  })

  it('shows NEEDS_DISCUSSION verdict with warning', () => {
    const discussionReview: StructuredReview = {
      ...mockStructuredReview,
      verdict: {
        ...mockStructuredReview.verdict,
        recommendation: 'NEEDS_DISCUSSION',
      },
    }

    const result = formatForPRComment(discussionReview)

    expect(result).toContain('### Verdict: ⚠️ NEEDS DISCUSSION')
  })
})
