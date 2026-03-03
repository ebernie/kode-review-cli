/**
 * Best-effort parser to extract structured data from AI review markdown.
 * Falls back gracefully when parsing fails.
 */
import type {
  StructuredReview,
  ReviewIssue,
  ReviewVerdict,
  Severity,
  Confidence,
  Verdict,
  MergeDecision,
  IssueCounts,
} from './types.js'

/**
 * Attempt to parse review content into structured data.
 * Returns null if parsing fails completely.
 */
export function parseReviewContent(content: string): StructuredReview | null {
  if (!content || typeof content !== 'string') {
    return null
  }

  const summary = extractSummary(content)
  const issues = extractIssues(content)
  const positives = extractPositives(content)
  const verdict = extractVerdict(content)

  // Require at least a summary or some issues to consider parsing successful
  if (!summary && issues.length === 0 && !verdict) {
    return null
  }

  return {
    summary: summary || 'No summary provided',
    issues,
    positives,
    verdict: verdict || {
      recommendation: 'NEEDS_DISCUSSION',
      confidence: 'LOW',
      mergeDecision: 'CONDITIONAL_MERGE',
      rationale: 'Could not parse verdict from review',
    },
    metadata: {
      timestamp: new Date().toISOString(),
      scope: 'local',
      agentic: false,
    },
  }
}

/**
 * Extract summary section from review content
 */
export function extractSummary(content: string): string {
  // Try to match "### Summary" or "## Summary" section
  const summaryMatch = content.match(/#{2,3}\s*Summary\s*\n+([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/mi)

  if (summaryMatch && summaryMatch[1]) {
    return summaryMatch[1].trim()
  }

  // Fallback: Try to extract first paragraph before any headers
  const firstParagraphMatch = content.match(/^([^#\n][^\n]*(?:\n[^#\n][^\n]*)*)/m)
  if (firstParagraphMatch && firstParagraphMatch[1]) {
    const text = firstParagraphMatch[1].trim()
    // Only return if it looks like a summary (reasonable length, no code blocks)
    if (text.length > 20 && text.length < 1000 && !text.includes('```')) {
      return text
    }
  }

  return ''
}

/**
 * Extract all issues from review content
 */
export function extractIssues(content: string): ReviewIssue[] {
  const issues: ReviewIssue[] = []

  // Pattern 1: Standard issue format with **[SEVERITY: ...]**
  const issueBlockPattern = /\*\*\[(?:SEVERITY:\s*)?(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*\s*-?\s*([^:\n]+?):\s*([^\n]+)\n([\s\S]*?)(?=\*\*\[(?:SEVERITY:\s*)?(?:CRITICAL|HIGH|MEDIUM|LOW)\]|#{2,3}\s|---|$)/gi

  let match
  while ((match = issueBlockPattern.exec(content)) !== null) {
    const [, severity, category, title, body] = match
    const issue = parseIssueBlock(
      severity.toUpperCase() as Severity,
      category.trim(),
      title.trim(),
      body
    )
    if (issue) {
      issues.push(issue)
    }
  }

  // Pattern 2: Alternative format with just severity header
  if (issues.length === 0) {
    const altPattern = /(?:^|\n)(?:\*\*|__)?(CRITICAL|HIGH|MEDIUM|LOW)(?:\*\*|__)?[:\s-]+([^\n]+)\n([\s\S]*?)(?=(?:\n(?:\*\*|__)?(CRITICAL|HIGH|MEDIUM|LOW)|#{2,3}\s|---|$))/gi

    while ((match = altPattern.exec(content)) !== null) {
      const [, severity, titleLine, body] = match

      // Split title line into category and title if possible
      const colonIndex = titleLine.indexOf(':')
      let category = 'General'
      let title = titleLine.trim()

      if (colonIndex > 0 && colonIndex < 50) {
        category = titleLine.substring(0, colonIndex).trim()
        title = titleLine.substring(colonIndex + 1).trim()
      }

      const issue = parseIssueBlock(severity.toUpperCase() as Severity, category, title, body)
      if (issue) {
        issues.push(issue)
      }
    }
  }

  return issues
}

/**
 * Parse an individual issue block
 */
function parseIssueBlock(
  severity: Severity,
  category: string,
  title: string,
  body: string
): ReviewIssue | null {
  if (!title) {
    return null
  }

  // Extract file and line number
  const fileMatch = body.match(/File:\s*`?([^`\n:]+?)(?::(\d+)(?:-(\d+))?)?`?\s*\n/i)
  const file = fileMatch?.[1]?.trim()
  const line = fileMatch?.[2] ? parseInt(fileMatch[2], 10) : undefined
  const endLine = fileMatch?.[3] ? parseInt(fileMatch[3], 10) : undefined

  // Extract description (Problem section or first paragraph)
  const problemMatch = body.match(/Problem:\s*\n?([\s\S]*?)(?=\n(?:Problematic Code|Suggested Fix|Confidence|$))/i)
  let description = problemMatch?.[1]?.trim() || ''

  // Fallback: use first paragraph of body
  if (!description) {
    const firstPara = body.split(/\n\n/)[0]
    if (firstPara && !firstPara.startsWith('```')) {
      description = firstPara.trim()
    }
  }

  // Extract code snippet
  const codeMatch = body.match(/Problematic Code:\s*\n```[\w]*\n([\s\S]*?)```/i)
  const codeSnippet = codeMatch?.[1]?.trim()

  // Extract suggested fix
  const suggestMatch = body.match(/Suggested Fix:\s*\n```[\w]*\n([\s\S]*?)```/i)
  const suggestion = suggestMatch?.[1]?.trim()

  // Extract confidence
  const confidenceMatch = body.match(/Confidence:\s*(HIGH|MEDIUM|LOW)/i)
  const confidence: Confidence = (confidenceMatch?.[1]?.toUpperCase() as Confidence) || 'MEDIUM'

  return {
    severity,
    category,
    title,
    file,
    line,
    endLine,
    description: description || title,
    codeSnippet,
    suggestion,
    confidence,
  }
}

/**
 * Extract positive observations from review content
 */
export function extractPositives(content: string): string[] {
  const positives: string[] = []

  // Try to match "### Positive Observations" or similar section
  // First try to capture until the next header (##/###)
  let positivesSectionMatch = content.match(
    /#{2,3}\s*Positive\s+Observations?\s*\n+([\s\S]*?)\n(?=#{2,3}\s)/i
  )

  // If no next header found, capture everything after the section header
  if (!positivesSectionMatch) {
    positivesSectionMatch = content.match(
      /#{2,3}\s*Positive\s+Observations?\s*\n+([\s\S]*)/i
    )
  }

  if (positivesSectionMatch && positivesSectionMatch[1]) {
    const section = positivesSectionMatch[1]

    // Extract bullet points - match lines starting with - or *
    const lines = section.split('\n')
    for (const line of lines) {
      const bulletMatch = line.match(/^\s*[-*•]\s+(.+)/)
      if (bulletMatch && bulletMatch[1]) {
        const text = bulletMatch[1].trim()
        if (text.length > 5) {
          positives.push(text)
        }
      }
    }

    // Fallback: split by newlines if no bullets found
    if (positives.length === 0) {
      const nonEmptyLines = section.split('\n').filter(line => line.trim().length > 10)
      positives.push(...nonEmptyLines.slice(0, 5).map(l => l.trim()))
    }
  }

  return positives
}

/**
 * Extract verdict section from review content
 */
export function extractVerdict(content: string): ReviewVerdict | null {
  // Look for the Final Verdict section - capture everything until next section or end
  const verdictSectionMatch = content.match(
    /#{2,3}\s*Final\s+Verdict\s*\n([\s\S]*)/mi
  )

  if (!verdictSectionMatch || !verdictSectionMatch[1]) {
    // Try simpler patterns
    return extractVerdictFromSimplePatterns(content)
  }

  const section = verdictSectionMatch[1]

  // Extract recommendation
  const recommendationMatch = section.match(
    /RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/i
  )
  const recommendation: Verdict = (recommendationMatch?.[1]?.toUpperCase() as Verdict) || 'NEEDS_DISCUSSION'

  // Extract confidence
  const confidenceMatch = section.match(/Confidence\s*(?:Level)?:\s*(HIGH|MEDIUM|LOW)/i)
  const confidence: Confidence = (confidenceMatch?.[1]?.toUpperCase() as Confidence) || 'MEDIUM'

  // Extract merge decision - support both underscored and non-underscored variants
  const mergeMatch = section.match(
    /Merge\s*Decision:\s*(SAFE[_\s]?TO[_\s]?MERGE|DO[_\s]?NOT[_\s]?MERGE|CONDITIONAL[_\s]?MERGE)/i
  )
  let mergeDecision: MergeDecision = 'CONDITIONAL_MERGE'
  if (mergeMatch?.[1]) {
    const normalized = mergeMatch[1].toUpperCase().replace(/\s+/g, '_')
    if (normalized.includes('SAFE') && normalized.includes('MERGE')) {
      mergeDecision = 'SAFE_TO_MERGE'
    } else if (normalized.includes('DO') && normalized.includes('NOT')) {
      mergeDecision = 'DO_NOT_MERGE'
    } else if (normalized.includes('CONDITIONAL')) {
      mergeDecision = 'CONDITIONAL_MERGE'
    }
  }

  // Extract rationale
  const rationaleMatch = section.match(/Rationale:\s*(.+?)(?=\n\n|\nIssues|\Z)/is)
  const rationale = rationaleMatch?.[1]?.trim() || ''

  // Extract issue summary
  const issueSummary = extractIssueSummary(section)

  return {
    recommendation,
    confidence,
    mergeDecision,
    rationale,
    issueSummary,
  }
}

/**
 * Fallback verdict extraction for simpler formats
 */
function extractVerdictFromSimplePatterns(content: string): ReviewVerdict | null {
  // Try to find just a recommendation anywhere in the content
  const recommendationMatch = content.match(
    /(?:RECOMMENDATION|Verdict|Decision):\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/i
  )

  if (!recommendationMatch) {
    return null
  }

  const recommendation = recommendationMatch[1].toUpperCase() as Verdict

  // Try to extract merge decision
  const mergeMatch = content.match(
    /Merge\s*Decision:\s*(SAFE_TO_MERGE|DO_NOT_MERGE|CONDITIONAL_MERGE)/i
  )
  const mergeDecision: MergeDecision = mergeMatch
    ? (mergeMatch[1].toUpperCase() as MergeDecision)
    : recommendation === 'APPROVE'
    ? 'SAFE_TO_MERGE'
    : recommendation === 'REQUEST_CHANGES'
    ? 'DO_NOT_MERGE'
    : 'CONDITIONAL_MERGE'

  return {
    recommendation,
    confidence: 'MEDIUM',
    mergeDecision,
    rationale: '',
  }
}

/**
 * Extract issue summary counts from verdict section
 */
function extractIssueSummary(section: string): IssueCounts | undefined {
  // Try pattern: "X CRITICAL, Y HIGH, Z MEDIUM, W LOW"
  const summaryMatch = section.match(
    /(\d+)\s*CRITICAL,?\s*(\d+)\s*HIGH,?\s*(\d+)\s*MEDIUM,?\s*(\d+)\s*LOW/i
  )

  if (summaryMatch) {
    return {
      critical: parseInt(summaryMatch[1], 10),
      high: parseInt(summaryMatch[2], 10),
      medium: parseInt(summaryMatch[3], 10),
      low: parseInt(summaryMatch[4], 10),
    }
  }

  // Try pattern: "Issues Summary: X CRITICAL..."
  const altMatch = section.match(
    /Issues?\s*Summary:?\s*(\d+)\s*CRITICAL,?\s*(\d+)\s*HIGH,?\s*(\d+)\s*MEDIUM,?\s*(\d+)\s*LOW/i
  )

  if (altMatch) {
    return {
      critical: parseInt(altMatch[1], 10),
      high: parseInt(altMatch[2], 10),
      medium: parseInt(altMatch[3], 10),
      low: parseInt(altMatch[4], 10),
    }
  }

  return undefined
}

/**
 * Count issues by severity from a list of issues
 */
export function countIssuesBySeverity(issues: ReviewIssue[]): IssueCounts {
  const counts: IssueCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const issue of issues) {
    const key = issue.severity.toLowerCase() as keyof IssueCounts
    counts[key]++
  }
  return counts
}
