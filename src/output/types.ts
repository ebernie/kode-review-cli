/**
 * Output formatting types for structured review data
 */

export type OutputFormat = 'text' | 'json' | 'markdown'

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'NEEDS_DISCUSSION'
export type MergeDecision = 'SAFE_TO_MERGE' | 'DO_NOT_MERGE' | 'CONDITIONAL_MERGE'
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'

/**
 * A single issue found during code review
 */
export interface ReviewIssue {
  severity: Severity
  category: string
  title: string
  file?: string
  line?: number
  endLine?: number
  description: string
  codeSnippet?: string
  suggestion?: string
  confidence: Confidence
}

/**
 * Issue counts by severity level
 */
export interface IssueCounts {
  critical: number
  high: number
  medium: number
  low: number
}

/**
 * Review verdict with recommendation and merge decision
 */
export interface ReviewVerdict {
  recommendation: Verdict
  confidence: Confidence
  mergeDecision: MergeDecision
  rationale: string
  issueSummary?: IssueCounts
}

/**
 * Metadata about the review execution
 */
export interface ReviewMetadata {
  timestamp: string
  scope: 'local' | 'pr' | 'both'
  agentic: boolean
  toolCalls?: number
  truncated?: boolean
  truncationReason?: string
  model?: string
  provider?: string
  prNumber?: number
  mrIid?: number
  branch?: string
}

/**
 * Fully parsed structured review data
 */
export interface StructuredReview {
  summary: string
  issues: ReviewIssue[]
  positives: string[]
  verdict: ReviewVerdict
  metadata: ReviewMetadata
}

/**
 * Complete review output with raw and optionally parsed data
 */
export interface ReviewOutput {
  /** Original markdown content from AI */
  raw: string
  /** Parsed structured data (best-effort, may be undefined if parsing fails) */
  structured?: StructuredReview
}

/**
 * Options for formatting output
 */
export interface FormatterOptions {
  /** Include metadata (timestamp, model info) in output */
  includeMetadata?: boolean
  /** Include raw markdown in JSON output */
  includeRaw?: boolean
  /** More detailed output */
  verbose?: boolean
}

/**
 * Options for writing review output
 */
export interface WriteOptions {
  format: OutputFormat
  outputFile?: string
  quiet?: boolean
}
