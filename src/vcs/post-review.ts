/**
 * Unified review posting for GitHub and GitLab
 */
import { logger } from '../utils/logger.js'
import type { StructuredReview, ReviewIssue, Verdict } from '../output/types.js'
import { formatForPRComment } from '../output/formatters.js'
import {
  postGitHubPRComment,
  postGitHubPRLineComment,
  submitGitHubPRReview,
  type GitHubReviewEvent,
} from './github.js'
import {
  postGitLabMRComment,
  postGitLabMRLineComment,
  setGitLabMRApproval,
} from './gitlab.js'

export type Platform = 'github' | 'gitlab'

export interface PostReviewOptions {
  /** PR number for GitHub */
  prNumber?: number
  /** MR IID for GitLab */
  mrIid?: number
  /** VCS platform */
  platform: Platform
  /** Whether to post inline comments for issues with file/line info */
  postInlineComments?: boolean
  /** Whether to set approval status based on verdict */
  setApprovalStatus?: boolean
  /** Maximum number of inline comments to post */
  maxInlineComments?: number
}

export interface PostReviewResult {
  success: boolean
  commentPosted: boolean
  inlineCommentsPosted: number
  approvalStatusSet: boolean
  errors: string[]
}

/**
 * Post a code review to a PR/MR
 */
export async function postReviewToPR(
  review: StructuredReview,
  rawContent: string,
  options: PostReviewOptions
): Promise<PostReviewResult> {
  const result: PostReviewResult = {
    success: false,
    commentPosted: false,
    inlineCommentsPosted: 0,
    approvalStatusSet: false,
    errors: [],
  }

  const {
    prNumber,
    mrIid,
    platform,
    postInlineComments = true,
    setApprovalStatus = true,
    maxInlineComments = 10,
  } = options

  // Validate we have the right identifier
  if (platform === 'github' && !prNumber) {
    result.errors.push('PR number is required for GitHub')
    return result
  }
  if (platform === 'gitlab' && !mrIid) {
    result.errors.push('MR IID is required for GitLab')
    return result
  }

  const identifier = platform === 'github' ? prNumber! : mrIid!

  // Format the review for posting as a comment
  const commentBody = formatForPRComment(review)

  // Post main comment
  logger.info(`Posting review comment to ${platform === 'github' ? `PR #${identifier}` : `MR !${identifier}`}...`)

  const commentResult = platform === 'github'
    ? await postGitHubPRComment(identifier, commentBody)
    : await postGitLabMRComment(identifier, commentBody)

  if (commentResult.success) {
    result.commentPosted = true
    logger.success('Review comment posted')
  } else {
    result.errors.push(`Failed to post comment: ${commentResult.error}`)
    logger.error(`Failed to post comment: ${commentResult.error}`)
  }

  // Post inline comments for issues with file/line info
  if (postInlineComments) {
    const issuesWithLocation = review.issues
      .filter(issue => issue.file && issue.line)
      .slice(0, maxInlineComments)

    if (issuesWithLocation.length > 0) {
      logger.info(`Posting ${issuesWithLocation.length} inline comment(s)...`)

      for (const issue of issuesWithLocation) {
        const inlineBody = formatInlineComment(issue)
        const inlineResult = platform === 'github'
          ? await postGitHubPRLineComment(identifier, inlineBody, issue.file!, issue.line!)
          : await postGitLabMRLineComment(identifier, inlineBody, issue.file!, issue.line!)

        if (inlineResult.success) {
          result.inlineCommentsPosted++
        } else {
          // Don't fail the whole operation for inline comment failures
          logger.debug(`Failed to post inline comment: ${inlineResult.error}`)
        }
      }

      if (result.inlineCommentsPosted > 0) {
        logger.success(`Posted ${result.inlineCommentsPosted} inline comment(s)`)
      }
    }
  }

  // Set approval status based on verdict
  if (setApprovalStatus) {
    const approvalResult = await setApprovalStatusForReview(
      identifier,
      platform,
      review.verdict.recommendation,
      rawContent
    )

    if (approvalResult.success) {
      result.approvalStatusSet = true
      logger.success(`Review status set: ${review.verdict.recommendation}`)
    } else if (approvalResult.error) {
      result.errors.push(`Failed to set approval status: ${approvalResult.error}`)
    }
  }

  // Overall success if at least the main comment was posted
  result.success = result.commentPosted
  return result
}

/**
 * Format an issue as an inline comment
 */
function formatInlineComment(issue: ReviewIssue): string {
  const parts: string[] = []

  // Severity icon
  const icons = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🔵',
  }

  parts.push(`${icons[issue.severity]} **${issue.severity}**: ${issue.title}`)
  parts.push('')
  parts.push(issue.description)

  if (issue.suggestion) {
    parts.push('')
    parts.push('**Suggested fix:**')
    parts.push('```')
    parts.push(issue.suggestion)
    parts.push('```')
  }

  parts.push('')
  parts.push(`*Confidence: ${issue.confidence}*`)

  return parts.join('\n')
}

/**
 * Set approval status on PR/MR based on review verdict
 */
async function setApprovalStatusForReview(
  identifier: number,
  platform: Platform,
  verdict: Verdict,
  _reviewBody: string // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<{ success: boolean; error?: string }> {
  if (platform === 'github') {
    // Map verdict to GitHub review event
    const event: GitHubReviewEvent =
      verdict === 'APPROVE'
        ? 'APPROVE'
        : verdict === 'REQUEST_CHANGES'
        ? 'REQUEST_CHANGES'
        : 'COMMENT'

    // For COMMENT, we don't need to submit a review (already posted comment)
    if (event === 'COMMENT') {
      return { success: true }
    }

    return submitGitHubPRReview(identifier, '', event)
  } else {
    // GitLab: approve or don't approve based on verdict
    if (verdict === 'APPROVE') {
      return setGitLabMRApproval(identifier, true)
    } else if (verdict === 'REQUEST_CHANGES') {
      // GitLab doesn't have "request changes" - we just don't approve
      // The comment with issues serves as the feedback
      return { success: true }
    } else {
      // NEEDS_DISCUSSION - no approval action needed
      return { success: true }
    }
  }
}

/**
 * Post a simple comment without structured review
 * Useful for error messages or notifications
 */
export async function postSimpleComment(
  message: string,
  options: Pick<PostReviewOptions, 'prNumber' | 'mrIid' | 'platform'>
): Promise<{ success: boolean; error?: string }> {
  const { prNumber, mrIid, platform } = options

  if (platform === 'github' && prNumber) {
    return postGitHubPRComment(prNumber, message)
  } else if (platform === 'gitlab' && mrIid) {
    return postGitLabMRComment(mrIid, message)
  }

  return { success: false, error: 'Invalid platform or missing identifier' }
}
