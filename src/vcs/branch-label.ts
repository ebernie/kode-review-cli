/**
 * Resolve a human-readable branch label for review output.
 *
 * `git branch --show-current` returns empty in detached-HEAD state, which is
 * the norm for CI runs that check out by commit SHA. In those cases — and
 * whenever the caller has explicitly specified a PR/MR number — the branch
 * name is not needed for correctness (the PR is fetched by id) and we fall
 * back to the literal `HEAD` label.
 *
 * Interactive runs still throw on empty branch, because they typically rely
 * on the current branch for PR discovery and reviewing the wrong source is
 * worse than an early failure.
 */
export function resolveBranchLabel(
  branch: string | null | undefined,
  opts: { ci: boolean; pr?: string },
): string {
  if (branch) return branch
  if (opts.ci || opts.pr) return 'HEAD'
  throw new Error('Could not determine current branch')
}
