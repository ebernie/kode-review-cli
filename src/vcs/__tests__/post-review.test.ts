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

    it('submits APPROVE review when verdict is APPROVE', async () => {
      mockPostGitHubPRComment.mockResolvedValue({ success: true })
      mockPostGitHubPRLineComment.mockResolvedValue({ success: true })
      mockSubmitGitHubPRReview.mockResolvedValue({ success: true })

      const approvedReview: StructuredReview = {
        ...mockReview,
        verdict: { ...mockReview.verdict, recommendation: 'APPROVE' },
      }

      await postReviewToPR(approvedReview, {
        prNumber: 42,
        platform: 'github',
        setApprovalStatus: true,
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

    it('approves MR when verdict is APPROVE', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockSetGitLabMRApproval.mockResolvedValue({ success: true })

      const approvedReview: StructuredReview = {
        ...mockReview,
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

    it('does not call setApproval for REQUEST_CHANGES (GitLab has no equivalent)', async () => {
      mockPostGitLabMRComment.mockResolvedValue({ success: true })
      mockSetGitLabMRApproval.mockResolvedValue({ success: true })

      await postReviewToPR(mockReview, {
        mrIid: 123,
        platform: 'gitlab',
        setApprovalStatus: true,
        postInlineComments: false,
      })

      // Should not call setGitLabMRApproval for REQUEST_CHANGES
      expect(mockSetGitLabMRApproval).not.toHaveBeenCalled()
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
