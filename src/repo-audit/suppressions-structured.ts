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
import { readFileSafe, shouldSuppressAtLine } from '../review/suppressions.js'
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
  const kept: Finding[] = []
  const byFile = new Map<string, number>()
  let suppressedCount = 0
  // Cache key is `finding.file` verbatim. If two findings on the same file
  // arrive with different path encodings (e.g., `./foo.ts` vs `foo.ts`) the
  // cache misses; the impact is a redundant readFileSafe call, never a
  // correctness issue (the path-guarded read is idempotent).
  const fileCache = new Map<string, string | null>()

  for (const f of findings) {
    let content: string | null | undefined = fileCache.get(f.file)
    if (content === undefined) {
      content = await readFileSafe(repoRoot, f.file)
      fileCache.set(f.file, content)
    }
    if (content !== null && shouldSuppressAtLine(content, f.lineStart)) {
      suppressedCount += 1
      byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
      continue
    }
    kept.push(f)
  }

  return { kept, suppressedCount, byFile }
}
