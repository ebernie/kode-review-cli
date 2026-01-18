export { detectPlatform, getCurrentBranch, isGitRepository, type VcsPlatform } from './detect.js'
export {
  isGhInstalled,
  isGhAuthenticated,
  getGitHubPRs,
  getGitHubPRDiff,
  getGitHubPRInfo,
  type PullRequest,
  type PullRequestInfo,
} from './github.js'
export {
  isGlabInstalled,
  isGlabAuthenticated,
  getGitLabMRs,
  getGitLabMRDiff,
  getGitLabMRInfo,
  type MergeRequest,
  type MergeRequestInfo,
} from './gitlab.js'
