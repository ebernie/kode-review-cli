/**
 * Unified review posting for GitHub and GitLab
 */
import { logger } from '../utils/logger.js'
import type { StructuredReview, ReviewIssue, Verdict } from '../output/types.js'
import { formatForPRComment, SEVERITY_ICONS } from '../output/formatters.js'
import {
  postGitHubPRComment,
  postGitHubPRLineComment,
  getGitHubPRContext,
  submitGitHubPRReview,
  type GitHubReviewEvent,
  type GitHubPRContext,
} from './github.js'
import {
  postGitLabMRComment,
  postGitLabMRLineComment,
  getGitLabMRContext,
  setGitLabMRApproval,
  unapproveGitLabMR,
  type GitLabMRContext,
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
  inlineCommentsFailed: number
  inlineCommentsAttempted: number
  approvalStatusSet: boolean
  errors: string[]
}

/**
 * Post a code review to a PR/MR
 */
export async function postReviewToPR(
  review: StructuredReview,
  options: PostReviewOptions
): Promise<PostReviewResult> {
  const result: PostReviewResult = {
    success: false,
    commentPosted: false,
    inlineCommentsPosted: 0,
    inlineCommentsFailed: 0,
    inlineCommentsAttempted: 0,
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

    result.inlineCommentsAttempted = issuesWithLocation.length

    if (issuesWithLocation.length > 0) {
      logger.info(`Posting ${issuesWithLocation.length} inline comment(s)...`)

      // Pre-fetch context once to avoid N+1 API calls
      const ctxResult = platform === 'github'
        ? await getGitHubPRContext(identifier)
        : await getGitLabMRContext(identifier)

      if (!ctxResult.success) {
        // Context fetch failed — every intended inline comment is a failure.
        // Callers need this surfaced; debug-level logging is invisible at default verbosity.
        result.inlineCommentsFailed = issuesWithLocation.length
        const msg = `Failed to fetch PR/MR context for inline comments: ${ctxResult.error}`
        result.errors.push(msg)
        logger.warn(msg)
      } else {
        const ctx = ctxResult.context
        for (const issue of issuesWithLocation) {
          const inlineBody = formatInlineComment(issue)
          const inlineResult = platform === 'github'
            ? await postGitHubPRLineComment(identifier, inlineBody, issue.file!, issue.line!, 'RIGHT', ctx as GitHubPRContext)
            : await postGitLabMRLineComment(identifier, inlineBody, issue.file!, issue.line!, ctx as GitLabMRContext)

          if (inlineResult.success) {
            result.inlineCommentsPosted++
          } else {
            result.inlineCommentsFailed++
            const msg = `Inline comment failed (${issue.file}:${issue.line}): ${inlineResult.error}`
            result.errors.push(msg)
            logger.warn(msg)
          }
        }
      }

      if (result.inlineCommentsPosted > 0) {
        logger.success(`Posted ${result.inlineCommentsPosted}/${result.inlineCommentsAttempted} inline comment(s)`)
      }
      if (result.inlineCommentsFailed > 0) {
        logger.warn(`${result.inlineCommentsFailed} inline comment(s) failed`)
      }
    }
  }

  // Set approval status based on verdict, with severity-count ground-truth gate
  if (setApprovalStatus) {
    const effective = effectiveVerdictForApproval(review)
    if (effective.downgraded) {
      result.errors.push(effective.reason!)
      logger.warn(effective.reason!)
    }
    const approvalResult = await setApprovalStatusForReview(
      identifier,
      platform,
      effective.verdict,
    )

    if (approvalResult.success) {
      result.approvalStatusSet = true
      logger.success(`Review status set: ${effective.verdict}`)
    } else if (approvalResult.error) {
      result.errors.push(`Failed to set approval status: ${approvalResult.error}`)
    }
  }

  // Overall success if at least the main comment was posted
  result.success = result.commentPosted
  return result
}

/**
 * The `setApprovalStatusForReview` call publishes a verdict to GitHub/GitLab.
 * Mirror the same severity-count ground truth that `resolveCiExitCode`
 * applies to the CI exit code: if there is any CRITICAL or HIGH issue in
 * the review, an APPROVE verdict from the model is downgraded to
 * NEEDS_DISCUSSION (becomes COMMENT on GitHub / no-op on GitLab).
 * The model's recommendation is advisory; the count axis is the ground truth.
 */
function effectiveVerdictForApproval(
  review: { verdict: { recommendation: Verdict }; issues: { severity: string }[] },
): { verdict: Verdict; downgraded: boolean; reason?: string } {
  const declared = review.verdict.recommendation
  if (declared !== 'APPROVE') return { verdict: declared, downgraded: false }

  const critical = review.issues.filter(i => i.severity === 'CRITICAL').length
  const high = review.issues.filter(i => i.severity === 'HIGH').length
  if (critical > 0 || high > 0) {
    return {
      verdict: 'NEEDS_DISCUSSION', // becomes COMMENT on GitHub / no-op on GitLab
      downgraded: true,
      reason: `APPROVE downgraded: ${critical} critical, ${high} high issue(s) present`,
    }
  }
  return { verdict: declared, downgraded: false }
}

/**
 * Format an issue as an inline comment
 */
function formatInlineComment(issue: ReviewIssue): string {
  const parts: string[] = []

  parts.push(`${SEVERITY_ICONS[issue.severity]} **${issue.severity}**: ${issue.title}`)
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
  verdict: Verdict
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
    if (verdict === 'APPROVE') {
      return setGitLabMRApproval(identifier, true)
    } else {
      // GitLab has no native "request changes" verb, and the severity gate
      // can downgrade an APPROVE verdict to NEEDS_DISCUSSION when CRITICAL/HIGH
      // issues are present. In both cases the desired postcondition is the same:
      // the MR must NOT be approved. Revoke any prior bot approval idempotently
      // (succeeds if there was no prior approval) so a stale APPROVE never
      // contradicts the current review verdict.
      return unapproveGitLabMR(identifier)
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
