/**
 * Output module for formatting and writing review results
 */

// Types
export type {
  OutputFormat,
  Severity,
  Verdict,
  MergeDecision,
  Confidence,
  ReviewIssue,
  IssueCounts,
  ReviewVerdict,
  ReviewMetadata,
  StructuredReview,
  ReviewOutput,
  FormatterOptions,
  WriteOptions,
} from './types.js'

// Parser
export {
  parseReviewContent,
  extractSummary,
  extractIssues,
  extractPositives,
  extractVerdict,
  countIssuesBySeverity,
} from './parser.js'

// Formatters
export {
  formatAsText,
  formatAsJson,
  formatAsMarkdown,
  formatForPRComment,
  SEVERITY_ICONS,
} from './formatters.js'

// Writer
export {
  writeReviewOutput,
  getFormattedContent,
} from './writer.js'
