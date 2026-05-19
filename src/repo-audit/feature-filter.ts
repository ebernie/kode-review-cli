/**
 * --since <ref> filter for repo-scope review.
 *
 * Reduces the feature set to features whose `ownedFiles[].path` intersects
 * the set of files changed in `<ref>...HEAD`. Used to scope incremental
 * re-audits to features actually touched by recent commits.
 *
 * Mirrors clawpatch's `--since` semantics: the file set comes from a
 * three-dot range (changes on HEAD since branching from <ref>), which is
 * the right answer for re-review after rebasing.
 */
import { exec as runCommand } from '../utils/exec.js'
import type { FeatureRecord } from './types.js'

export interface FilterBySinceResult {
  /** Features that intersect the touched-file set. */
  matched: FeatureRecord[]
  /** Files reported as changed by git. */
  touchedFiles: string[]
}

/**
 * Return the set of files changed in `<ref>...HEAD`. Throws if the ref
 * cannot be resolved — callers should surface this to the user clearly
 * rather than silently fall back to "all features."
 */
export async function touchedFilesSince(
  repoRoot: string,
  ref: string,
): Promise<string[]> {
  const result = await runCommand(
    'git',
    ['diff', '--name-only', `${ref}...HEAD`],
    { cwd: repoRoot },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --name-only ${ref}...HEAD failed (exit ${result.exitCode}): ` +
        `${result.stderr.trim() || '(no stderr)'}`,
    )
  }
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Reduce `features` to those whose owned files overlap the change set since
 * `ref`. Features with zero ownedFiles never match (they have no surface to
 * touch); features whose only-changed files are in contextFiles are
 * deliberately excluded — context is a hint, not a re-review trigger.
 */
export async function filterFeaturesBySince(
  features: FeatureRecord[],
  repoRoot: string,
  ref: string,
): Promise<FilterBySinceResult> {
  const touched = await touchedFilesSince(repoRoot, ref)
  if (touched.length === 0) {
    return { matched: [], touchedFiles: [] }
  }
  const touchedSet = new Set(touched)
  const matched = features.filter((f) =>
    f.ownedFiles.some((fileRef) => touchedSet.has(fileRef.path)),
  )
  return { matched, touchedFiles: touched }
}
