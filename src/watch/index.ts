export {
  type ReviewRequest,
  type ReviewRequestKey,
  type ReviewOutcome,
  type WatchConfig,
  type Platform,
  type DetectionResult,
  makeReviewRequestKey,
  formatReviewRequest,
} from './types.js'

export { WatchStateManager } from './state.js'

export { detectReviewRequests, type DetectorConfig } from './detector.js'

export { startWatchMode, type WatchModeOptions } from './watcher.js'
