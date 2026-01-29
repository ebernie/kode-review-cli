export { detectPlatform, getCurrentBranch, isGitRepository, getRepoUrl, getRepoRoot, type VcsPlatform } from './detect.js'
export {
  isGhInstalled,
  isGhAuthenticated,
  getGitHubPRs,
  getGitHubPRDiff,
  getGitHubPRInfo,
  postGitHubPRComment,
  postGitHubPRLineComment,
  submitGitHubPRReview,
  type PullRequest,
  type PullRequestInfo,
  type GitHubReviewEvent,
} from './github.js'
export {
  isGlabInstalled,
  isGlabAuthenticated,
  getGitLabMRs,
  getGitLabMRDiff,
  getGitLabMRInfo,
  postGitLabMRComment,
  postGitLabMRLineComment,
  approveGitLabMR,
  revokeGitLabMRApproval,
  setGitLabMRApproval,
  type MergeRequest,
  type MergeRequestInfo,
} from './gitlab.js'
export {
  postReviewToPR,
  postSimpleComment,
  type Platform,
  type PostReviewOptions,
  type PostReviewResult,
} from './post-review.js'
