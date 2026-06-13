/**
 * Structured suppression filter for repo-scope.
 *
 * The diff-scope filter in src/review/suppressions.ts operates on the LLM's
 * rendered markdown (regex over `**[SEVERITY: ...]**` blocks). Repo-scope
 * deals in `Finding[]` arrays directly, so we need a structured variant
 * that filters by `{file, lineStart}` against source-level `kode-review:
 * ignore` / `ignore-file` markers.
 *
 * Marker grammar is identical to the diff-scope filter:
 *   <comment> kode-review: ignore         → suppresses this line AND the next
 *   <comment> kode-review: ignore-file    → suppresses every finding in the file
 *
 * Shares readFileSafe + shouldSuppressAtLine with the diff filter so the two
 * cannot drift apart.
 */
import { filterSuppressedStructuredFindings } from '../review/suppressions.js'
import type { Finding } from '../review/finding-schema.js'

export interface StructuredFilterResult {
  kept: Finding[]
  suppressedCount: number
  /** Per-file count of suppressions, for logging. */
  byFile: Map<string, number>
}

/**
 * Drop findings whose source location is annotated with a suppression marker.
 *
 * - Each finding's `file` is read once (cached) per call.
 * - Files that fail to read (missing, traversal attempt) yield `kept: true` —
 *   absence of a marker file should not silently suppress findings.
 */
export async function filterSuppressedStructured(
  findings: Finding[],
  repoRoot: string,
): Promise<StructuredFilterResult> {
  return filterSuppressedStructuredFindings(findings, repoRoot)
}
