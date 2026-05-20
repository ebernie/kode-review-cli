import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StructuredReview } from '../../output/types.js'

// Mock the VCS modules before importing
vi.mock('../github.js', () => ({
  postGitHubPRComment: vi.fn(),
  postGitHubPRLineComment: vi.fn(),
  getGitHubPRContext: vi.fn(),
  submitGitHubPRReview: vi.fn(),
}))

vi.mock('../gitlab.js', () => ({
  postGitLabMRComment: vi.fn(),
  postGitLabMRLineComment: vi.fn(),
  getGitLabMRContext: vi.fn(),
  setGitLabMRApproval: vi.fn(),
  unapproveGitLabMR: vi.fn(),
}))

// Mock logger to suppress output during tests
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}))

// Import after mocks
import { postReviewToPR, postSimpleComment } from '../post-review.js'
import {
  postGitHubPRComment,
  postGitHubPRLineComment,
  getGitHubPRContext,
  submitGitHubPRReview,
} from '../github.js'
import {
  postGitLabMRComment,
  postGitLabMRLineComment,
  getGitLabMRContext,
  setGitLabMRApproval,
  unapproveGitLabMR,
} from '../gitlab.js'

// Get mock references
const mockPostGitHubPRComment = postGitHubPRComment as unknown as ReturnType<typeof vi.fn>
const mockPostGitHubPRLineComment = postGitHubPRLineComment as unknown as ReturnType<typeof vi.fn>
const mockGetGitHubPRContext = getGitHubPRContext as unknown as ReturnType<typeof vi.fn>
const mockSubmitGitHubPRReview = submitGitHubPRReview as unknown as ReturnType<typeof vi.fn>
const mockPostGitLabMRComment = postGitLabMRComment as unknown as ReturnType<typeof vi.fn>
const mockPostGitLabMRLineComment = postGitLabMRLineComment as unknown as ReturnType<typeof vi.fn>
const mockGetGitLabMRContext = getGitLabMRContext as unknown as ReturnType<typeof vi.fn>
const mockSetGitLabMRApproval = setGitLabMRApproval as unknown as ReturnType<typeof vi.fn>
const mockUnapproveGitLabMR = unapproveGitLabMR as unknown as ReturnType<typeof vi.fn>

const mockReview: StructuredReview = {
  summary: 'Test review summary.',
  issues: [
    {
      severity: 'CRITICAL',
      category: 'Security',
      title: 'SQL injection',
      file: 'src/db.ts',
      line: 45,
      description: 'User input not sanitized.',
      suggestion: 'Use parameterized queries.',
      confidence: 'HIGH',
    },
    {
      severity: 'HIGH',
      category: 'Logic',
      title: 'Missing null check',
      file: 'src/utils.ts',
      line: 23,
      description: 'Potential null reference.',
      confidence: 'MEDIUM',
    },
    {
      severity: 'LOW',
      category: 'Style',
      title: 'Inconsistent naming',
      // No file/line - should not get inline comment
      description: 'Variable naming inconsistent.',
      confidence: 'LOW',
    },
  ],
  positives: ['Good test coverage'],
  verdict: {
    recommendation: 'REQUEST_CHANGES',
    confidence: 'HIGH',
    mergeDecision: 'DO_NOT_MERGE',
    rationale: 'Critical security issue must be fixed.',
  },
  metadata: {
    timestamp: '2024-01-15T10:30:00Z',
    scope: 'pr',
    agentic: false,
  },
}

describe('postReviewToPR', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default mocks for inline comment support
    mockGetGitHubPRContext.mockResolvedValue({
      success: true,
      context: { owner: 'test-owner', repo: 'test-repo', commitId: 'abc123' },
    })
    mockGetGitLabMRContext.mockResolvedValue({
      success: true,
      context: { projectPath: 'test%2Fproject', baseSha: 'base', headSha: 'head', startSha: 'start' },
    })
    mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
    mockPostGitLabMRLineComment.mockResolvedValue({ success: true })
    mockSubmitGitHubPRReview.mockResolvedValue({ success: true })
    mockSetGitLabMRApproval.mockResolvedValue({ success: true })
    mockUnapproveGitLabMR.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('GitHub', () => {
    it('posts main comment to PR', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
      })

      expect(result.success).toBe(true)
      expect(result.commentPosted).toBe(true)
      expect(mockPostGitHubPRComment).toHaveBeenCalledWith(42, expect.stringContaining('Automated Code Review'))
    })

    it('posts inline comments for issues with file/line', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
        postInlineComments: true,
      })

      // Should post 2 inline comments (for issues with file/line)
      expect(result.inlineCommentsPosted).toBe(2)
      expect(mockPostGitHubPRLineComment).toHaveBeenCalledTimes(2)

      // Verify first inline comment (includes side and pre-fetched context)
      expect(mockPostGitHubPRLineComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining('SQL injection'),
        'src/db.ts',
        45,
        'RIGHT',
        expect.objectContaining({ owner: 'test-owner', repo: 'test-repo' })
      )
    })

    it('submits REQUEST_CHANGES review when verdict is REQUEST_CHANGES', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
        setApprovalStatus: true,
      })

      expect(result.approvalStatusSet).toBe(true)
      expect(mockSubmitGitHubPRReview).toHaveBeenCalledWith(42, '', 'REQUEST_CHANGES')
    })

    it('submits APPROVE review when verdict is APPROVE and no CRITICAL/HIGH issues', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      // Use a review with no CRITICAL or HIGH issues — severity gate must pass APPROVE through
      const approvedReview: StructuredReview = {
        ...mockReview,
        issues: [
          {
            severity: 'LOW',
            category: 'Style',
            title: 'Minor style issue',
            description: 'Naming inconsistency.',
            confidence: 'LOW',
          },
        ],
        verdict: { ...mockReview.verdict, recommendation: 'APPROVE' },
      }

      await postReviewToPR(approvedReview, {
        prNumber: 42,
        platform: 'github',
        setApprovalStatus: true,
        postInlineComments: false,
      })

      expect(mockSubmitGitHubPRReview).toHaveBeenCalledWith(42, '', 'APPROVE')
    })

    it('returns error when PR number is missing', async () => {
      const result = await postReviewToPR(mockReview, {
        platform: 'github',
      })

      expect(result.success).toBe(false)
      expect(result.errors).toContain('PR number is required for GitHub')
    })

    it('handles comment posting failure', async () => {
      mockPostGitHubPRComment.mockResolvedValue({
        success: false,
        error: 'Network error',
      })

      const result = await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
      })

      expect(result.success).toBe(false)
      expect(result.commentPosted).toBe(false)
      expect(result.errors).toContain('Failed to post comment: Network error')
    })

    it('respects maxInlineComments option', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
        postInlineComments: true,
        maxInlineComments: 1,
      })

      // Should only post 1 inline comment due to limit
      expect(mockPostGitHubPRLineComment).toHaveBeenCalledTimes(1)
    })

    it('skips inline comments when postInlineComments is false', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      await postReviewToPR(mockReview, {
        prNumber: 42,
        platform: 'github',
        postInlineComments: false,
      })

      expect(mockPostGitHubPRLineComment).not.toHaveBeenCalled()
    })
  })

  describe('GitLab', () => {
    it('posts main comment to MR', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockPostGitLabMRLineComment.mockResolvedValue({ success: true })
      mockSetGitLabMRApproval.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        mrIid: 123,
        platform: 'gitlab',
      })

      expect(result.success).toBe(true)
      expect(result.commentPosted).toBe(true)
      expect(mockPostGitLabMRComment).toHaveBeenCalledWith(123, expect.stringContaining('Automated Code Review'))
    })

    it('posts inline comments to MR', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockPostGitLabMRLineComment.mockResolvedValue({ success: true })
      mockSetGitLabMRApproval.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        mrIid: 123,
        platform: 'gitlab',
        postInlineComments: true,
      })

      expect(result.inlineCommentsPosted).toBe(2)
      expect(mockPostGitLabMRLineComment).toHaveBeenCalledTimes(2)
    })

    it('approves MR when verdict is APPROVE and no CRITICAL/HIGH issues', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockSetGitLabMRApproval.mockResolvedValue({ success: true })

      // Use a review with no CRITICAL or HIGH issues — severity gate must pass APPROVE through
      const approvedReview: StructuredReview = {
        ...mockReview,
        issues: [
          {
            severity: 'LOW',
            category: 'Style',
            title: 'Minor style issue',
            description: 'Naming inconsistency.',
            confidence: 'LOW',
          },
        ],
        verdict: { ...mockReview.verdict, recommendation: 'APPROVE' },
      }

      await postReviewToPR(approvedReview, {
        mrIid: 123,
        platform: 'gitlab',
        setApprovalStatus: true,
        postInlineComments: false,
      })

      expect(mockSetGitLabMRApproval).toHaveBeenCalledWith(123, true)
    })

    it('calls unapproveGitLabMR for REQUEST_CHANGES to revoke any prior bot approval', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockUnapproveGitLabMR.mockResolvedValue({ success: true })

      const result = await postReviewToPR(mockReview, {
        mrIid: 123,
        platform: 'gitlab',
        setApprovalStatus: true,
        postInlineComments: false,
      })

      // Must revoke any prior approval — not silently ignore REQUEST_CHANGES
      expect(mockUnapproveGitLabMR).toHaveBeenCalledWith(123)
      // Must not approve while doing so
      expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
      expect(result.approvalStatusSet).toBe(true)
    })

    it('returns error when MR IID is missing', async () => {
      const result = await postReviewToPR(mockReview, {
        platform: 'gitlab',
      })

      expect(result.success).toBe(false)
      expect(result.errors).toContain('MR IID is required for GitLab')
    })
  })
})

describe('postReviewToPR — inline comment failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGitHubPRContext.mockResolvedValue({
      success: true,
      context: { owner: 'test-owner', repo: 'test-repo', commitId: 'abc123' },
    })
    mockPostGitHubPRComment.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records inline comment failures in result.inlineCommentsFailed and result.errors', async () => {
    mockPostGitHubPRLineComment
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'API rate limit' })
      .mockResolvedValueOnce({ success: false, error: 'Not found' })

    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [
          { severity: 'LOW', category: 'Style', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any,
          { severity: 'LOW', category: 'Style', title: 'b', description: '', confidence: 'HIGH', file: 'b.ts', line: 2 } as any,
          { severity: 'LOW', category: 'Style', title: 'c', description: '', confidence: 'HIGH', file: 'c.ts', line: 3 } as any,
        ],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 123, setApprovalStatus: false },
    )

    expect(result.inlineCommentsAttempted).toBe(3)
    expect(result.inlineCommentsPosted).toBe(1)
    expect(result.inlineCommentsFailed).toBe(2)
    // Exactly 2 errors — one per failed inline comment, not more
    expect(result.errors).toHaveLength(2)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/API rate limit/),
        expect.stringMatching(/Not found/),
      ]),
    )
    expect(mockPostGitHubPRLineComment).toHaveBeenCalledTimes(3)
  })

  it('records a context-fetch failure as N failures (one per eligible issue), no line-comment calls', async () => {
    mockGetGitHubPRContext.mockResolvedValue({ success: false, error: 'PR not found' })

    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [
          { severity: 'LOW', category: 'Style', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any,
          { severity: 'LOW', category: 'Style', title: 'b', description: '', confidence: 'HIGH', file: 'b.ts', line: 2 } as any,
        ],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 123, setApprovalStatus: false },
    )

    expect(result.inlineCommentsAttempted).toBe(2)
    expect(result.inlineCommentsPosted).toBe(0)
    expect(result.inlineCommentsFailed).toBe(2)
    // Exactly one error for the context-fetch failure, not one per issue
    expect(result.errors).toHaveLength(1)
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/PR not found/)]))
    // Line-comment API was never called — the context failure short-circuited it
    expect(mockPostGitHubPRLineComment).not.toHaveBeenCalled()
  })

  it('leaves inlineCommentsFailed at 0 when all inline comments succeed', async () => {
    mockPostGitHubPRLineComment.mockResolvedValue({ success: true })

    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [
          { severity: 'LOW', category: 'Style', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any,
          { severity: 'LOW', category: 'Style', title: 'b', description: '', confidence: 'HIGH', file: 'b.ts', line: 2 } as any,
        ],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 123, setApprovalStatus: false },
    )

    expect(result.inlineCommentsAttempted).toBe(2)
    expect(result.inlineCommentsPosted).toBe(2)
    expect(result.inlineCommentsFailed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('sets all inline counters to 0 and makes no API calls when postInlineComments is false', async () => {
    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [
          { severity: 'LOW', category: 'Style', title: 'a', description: '', confidence: 'HIGH', file: 'a.ts', line: 1 } as any,
        ],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 123, setApprovalStatus: false, postInlineComments: false },
    )

    expect(result.inlineCommentsAttempted).toBe(0)
    expect(result.inlineCommentsPosted).toBe(0)
    expect(result.inlineCommentsFailed).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(mockGetGitHubPRContext).not.toHaveBeenCalled()
    expect(mockPostGitHubPRLineComment).not.toHaveBeenCalled()
  })
})

describe('postSimpleComment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('posts to GitHub when platform is github', async () => {
    mockPostGitHubPRComment.mockResolvedValue({ success: true })

    const result = await postSimpleComment('Test message', {
      prNumber: 42,
      platform: 'github',
    })

    expect(result.success).toBe(true)
    expect(mockPostGitHubPRComment).toHaveBeenCalledWith(42, 'Test message')
  })

  it('posts to GitLab when platform is gitlab', async () => {
    mockPostGitLabMRComment.mockResolvedValue({ success: true })

    const result = await postSimpleComment('Test message', {
      mrIid: 123,
      platform: 'gitlab',
    })

    expect(result.success).toBe(true)
    expect(mockPostGitLabMRComment).toHaveBeenCalledWith(123, 'Test message')
  })

  it('returns error for invalid configuration', async () => {
    const result = await postSimpleComment('Test message', {
      platform: 'github',
      // Missing prNumber
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid platform or missing identifier')
  })
})

describe('postReviewToPR — severity gate on auto-approve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostGitHubPRComment.mockResolvedValue({ success: true })
    mockPostGitLabMRComment.mockResolvedValue({ success: true })
    mockSubmitGitHubPRReview.mockResolvedValue({ success: true })
    mockSetGitLabMRApproval.mockResolvedValue({ success: true })
    mockUnapproveGitLabMR.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downgrades GitHub APPROVE to COMMENT when there is a CRITICAL issue', async () => {
    const result = await postReviewToPR(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        issues: [{ severity: 'CRITICAL', title: 'sql injection', description: '', confidence: 'HIGH', category: 'Security' } as any],
        summary: 'test',
        positives: [],
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 7, postInlineComments: false, setApprovalStatus: true },
    )

    // Must NOT submit APPROVE — the CRITICAL issue should have blocked it
    expect(mockSubmitGitHubPRReview).not.toHaveBeenCalledWith(7, '', 'APPROVE')
    // The downgrade reason must be surfaced in result.errors
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/downgrad/i),
    ]))
  })

  it('downgrades GitHub APPROVE to COMMENT when there is a HIGH issue', async () => {
    await postReviewToPR(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        issues: [{ severity: 'HIGH', title: 'auth bypass', description: '', confidence: 'HIGH', category: 'Security' } as any],
        summary: 'test',
        positives: [],
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 7, postInlineComments: false, setApprovalStatus: true },
    )

    expect(mockSubmitGitHubPRReview).not.toHaveBeenCalledWith(7, '', 'APPROVE')
  })

  it('lets GitHub APPROVE through when issues are MEDIUM/LOW only', async () => {
    await postReviewToPR(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        issues: [{ severity: 'MEDIUM', title: 'naming', description: '', confidence: 'HIGH', category: 'Style' } as any],
        summary: 'test',
        positives: [],
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 7, postInlineComments: false, setApprovalStatus: true },
    )

    expect(mockSubmitGitHubPRReview).toHaveBeenCalledWith(7, '', 'APPROVE')
  })

  it('downgrades GitLab APPROVE to unapprove when there is a CRITICAL issue', async () => {
    mockUnapproveGitLabMR.mockResolvedValue({ success: true })

    await postReviewToPR(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        issues: [{ severity: 'CRITICAL', title: 'rce', description: '', confidence: 'HIGH', category: 'Security' } as any],
        summary: 'test',
        positives: [],
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 7, postInlineComments: false, setApprovalStatus: true },
    )

    // Must NOT approve when CRITICAL is present...
    expect(mockSetGitLabMRApproval).not.toHaveBeenCalledWith(7, true)
    // ...AND must actively revoke any prior bot approval so the MR doesn't
    // sit in "approved" state contradicting the new review verdict.
    expect(mockUnapproveGitLabMR).toHaveBeenCalledWith(7)
  })

  it('lets APPROVE through when there are zero issues', async () => {
    await postReviewToPR(
      {
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        issues: [],
        summary: 'test',
        positives: [],
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 7, postInlineComments: false, setApprovalStatus: true },
    )

    expect(mockSubmitGitHubPRReview).toHaveBeenCalledWith(7, '', 'APPROVE')
  })
})

describe('postReviewToPR — GitLab REQUEST_CHANGES revokes prior approval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUnapproveGitLabMR.mockResolvedValue({ success: true })
    mockSetGitLabMRApproval.mockResolvedValue({ success: true })
    mockPostGitLabMRComment.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls unapproveGitLabMR when verdict is REQUEST_CHANGES on GitLab', async () => {
    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'REQUEST_CHANGES', reasoning: '', confidence: 'HIGH', mergeDecision: 'DO_NOT_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 42, setApprovalStatus: true },
    )

    // Must actively revoke any prior approval when flagging REQUEST_CHANGES
    expect(mockUnapproveGitLabMR).toHaveBeenCalledWith(42)
    // Must NOT simultaneously approve
    expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
    expect(result.approvalStatusSet).toBe(true)
  })

  it('calls setGitLabMRApproval(42, true) when verdict is APPROVE on GitLab', async () => {
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 42, setApprovalStatus: true },
    )

    expect(mockSetGitLabMRApproval).toHaveBeenCalledWith(42, true)
    // Must not call unapprove when approving
    expect(mockUnapproveGitLabMR).not.toHaveBeenCalled()
  })

  it('calls unapproveGitLabMR on NEEDS_DISCUSSION to clear any prior approval', async () => {
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'NEEDS_DISCUSSION', reasoning: '', confidence: 'HIGH', mergeDecision: 'CONDITIONAL_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 42, setApprovalStatus: true },
    )

    // GitLab can only express APPROVE or not-APPROVE. NEEDS_DISCUSSION means
    // the bot wants the MR in the not-APPROVE state. Revoke any prior approval
    // (idempotent on "not approved"); never call setGitLabMRApproval(_, true).
    expect(mockUnapproveGitLabMR).toHaveBeenCalledWith(42)
    expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
  })

  it('does not call unapproveGitLabMR when setApprovalStatus is false', async () => {
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'REQUEST_CHANGES', reasoning: '', confidence: 'HIGH', mergeDecision: 'DO_NOT_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 42, setApprovalStatus: false },
    )

    // If caller opts out of approval management, neither function is called
    expect(mockUnapproveGitLabMR).not.toHaveBeenCalled()
    expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
  })
})

/**
 * Regression tests for D-5a: `setApprovalStatus` defaults to `false`.
 *
 * Pre-fix the field defaulted to `true`, which meant a caller that
 * merely asked to post a review comment would also trigger an actual
 * GitHub APPROVE / GitLab approve action whenever the model emitted
 * an APPROVE verdict. Prompt-injection in untrusted PR/MR content
 * could exploit this to coerce a bot account into approving attacker-
 * controlled changes.
 *
 * The fix flips the default to `false` so the privileged mutation
 * requires explicit caller opt-in (CliOptions.autoApprove via
 * --auto-approve).
 */
describe('postReviewToPR — default setApprovalStatus is false (D-5a)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostGitHubPRComment.mockResolvedValue({ success: true })
    mockPostGitLabMRComment.mockResolvedValue({ success: true })
    mockGetGitHubPRContext.mockResolvedValue({ success: true, context: {} })
    mockGetGitLabMRContext.mockResolvedValue({ success: true, context: {} })
  })

  it('does NOT call submitGitHubPRReview when setApprovalStatus is omitted (GitHub, APPROVE verdict)', async () => {
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 1, postInlineComments: false },
    )
    // Pre-fix this test would FAIL: submitGitHubPRReview would have been
    // called with 'APPROVE' because setApprovalStatus defaulted to true.
    expect(mockSubmitGitHubPRReview).not.toHaveBeenCalled()
  })

  it('does NOT call setGitLabMRApproval when setApprovalStatus is omitted (GitLab, APPROVE verdict)', async () => {
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'gitlab', mrIid: 1, postInlineComments: false },
    )
    expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
    // unapproveGitLabMR is *also* gated by setApprovalStatus (the
    // helper runs the GitLab approval branch only when the flag is on),
    // so it must not fire either.
    expect(mockUnapproveGitLabMR).not.toHaveBeenCalled()
  })

  it('does NOT call submitGitHubPRReview when setApprovalStatus is omitted (REQUEST_CHANGES verdict)', async () => {
    // Same default applies regardless of verdict — model-derived
    // REQUEST_CHANGES is also a "platform-visible mutation" and must
    // not run without explicit opt-in.
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'REQUEST_CHANGES', reasoning: '', confidence: 'HIGH', mergeDecision: 'DO_NOT_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 1, postInlineComments: false },
    )
    expect(mockSubmitGitHubPRReview).not.toHaveBeenCalled()
  })

  it('still posts the review comment when setApprovalStatus is omitted (default-off only gates approval)', async () => {
    // Affirmative companion to the negative assertions above:
    // verify the comment still posts. A regression that flipped the
    // default to "do nothing at all" would silently break the
    // happy path.
    const result = await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 1, postInlineComments: false },
    )
    expect(mockPostGitHubPRComment).toHaveBeenCalledTimes(1)
    expect(result.commentPosted).toBe(true)
    expect(result.approvalStatusSet).toBe(false)
  })

  it('still calls submitGitHubPRReview when setApprovalStatus is explicitly true (opt-in works)', async () => {
    // The opt-in path must remain functional — flipping the default to
    // false must not also break callers that explicitly request the
    // approval mutation (e.g., CI with --auto-approve).
    mockSubmitGitHubPRReview.mockResolvedValue({ success: true })
    await postReviewToPR(
      {
        summary: 'test',
        positives: [],
        issues: [],
        verdict: { recommendation: 'APPROVE', reasoning: '', confidence: 'HIGH', mergeDecision: 'SAFE_TO_MERGE', rationale: '' },
        metadata: { timestamp: '', scope: 'pr', agentic: false },
      } as any,
      { platform: 'github', prNumber: 1, postInlineComments: false, setApprovalStatus: true },
    )
    expect(mockSubmitGitHubPRReview).toHaveBeenCalledWith(1, '', 'APPROVE')
  })
})
