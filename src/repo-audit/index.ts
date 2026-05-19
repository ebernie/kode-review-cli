/**
 * Public surface for `--scope repo` whole-codebase review.
 *
 * Architecture: clawpatch-powered mapper, kode-review-cli–powered reviewer.
 *   - clawpatch owns `.clawpatch/` (project state, feature decomposition).
 *   - kode-review-cli owns `.kode-review/` (findings, locks, run history),
 *     the prompt, the agent loop, the tool set, and the personas.
 */
export * from './types.js'
export * from './state.js'
export * from './install.js'
export * from './clawpatch-cli.js'
export * from './features.js'
export * from './suppressions-structured.js'
export * from './persona-dispatch.js'
export * from './prompts.js'
export * from './engines/index.js'
export * from './orchestrator.js'
export * from './feature-filter.js'
export * from './report.js'
