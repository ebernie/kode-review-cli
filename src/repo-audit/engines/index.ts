/**
 * Engines for `--scope repo`. Two implementations:
 *   - kode-agent: default; runs runAgenticReview() per feature with tools.
 *   - clawpatch:  escape hatch; shells out to `clawpatch review`.
 *
 * Both produce kode-review's canonical Finding[] schema; the caller writes
 * them to .kode-review/findings/ regardless of which engine produced them.
 */
export * from './kode-agent.js'
