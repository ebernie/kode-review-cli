/**
 * Suppression filter: drops review findings whose source line is annotated
 * with a `kode-review: ignore` magic comment. Always-on; disable with
 * --no-suppressions.
 *
 * Marker grammar (case-sensitive on the keyword, whitespace-tolerant):
 *   <any-comment-syntax> kode-review: ignore         → suppresses this line AND the line below
 *   <any-comment-syntax> kode-review: ignore-file    → suppresses every finding in the file
 *
 * Files referenced by findings are read via the project's path guard so
 * traversal cannot leak the existence of files outside repoRoot.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWithinRepo } from './tools/path-guard.js'
import type { ReviewSummary } from './ci-mode.js'

const IGNORE_RE = /kode-review:\s*ignore(?!-file)/
const IGNORE_FILE_RE = /kode-review:\s*ignore-file/
const ISSUE_BLOCK_RE = /\*\*\[SEVERITY:\s*(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*[\s\S]*?(?=\n\*\*\[SEVERITY|\n### |\nIssues Summary:|\nRECOMMENDATION:|$)/g
const SEVERITY_HEAD_RE = /\*\*\[SEVERITY:\s*(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/
const FILE_LINE_RE = /File:\s*([^\s:]+):(\d+)/
const ISSUES_SUMMARY_RE = /Issues Summary:\s*(\d+)\s*CRITICAL,\s*(\d+)\s*HIGH,\s*(\d+)\s*MEDIUM,\s*(\d+)\s*LOW/i
const VERDICT_RE = /RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION)/

export function hasIgnoreMarker(line: string): boolean {
  return IGNORE_RE.test(line)
}

export function hasIgnoreFileMarker(content: string): boolean {
  return IGNORE_FILE_RE.test(content)
}

export interface FilterResult {
  filtered: string
  suppressedCount: number
  summary: ReviewSummary
}

async function readFileSafe(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    // assertWithinRepo returns a path relative to repoRoot when the input is
    // safe (or throws on traversal). Use node:path.join so trailing slashes
    // and platform separators are handled correctly.
    const safe = assertWithinRepo(repoRoot, relPath)
    return await readFile(join(repoRoot, safe), 'utf-8')
  } catch {
    return null
  }
}

function shouldSuppress(content: string, line: number): boolean {
  if (hasIgnoreFileMarker(content)) return true
  const lines = content.split('\n')
  // 1-based line indexing. Marker on `line` suppresses `line`; marker on
  // `line-1` suppresses `line` (next-line idiom).
  const here = lines[line - 1] ?? ''
  const above = lines[line - 2] ?? ''
  return hasIgnoreMarker(here) || hasIgnoreMarker(above)
}

function decrementSeverity(severity: string, counts: ReviewSummary['issuesByCount']): void {
  const s = severity.toLowerCase() as keyof ReviewSummary['issuesByCount']
  if (s in counts && counts[s] > 0) counts[s] -= 1
}

export async function filterSuppressedFindings(
  reviewMarkdown: string,
  repoRoot: string,
): Promise<FilterResult> {
  const summaryMatch = reviewMarkdown.match(ISSUES_SUMMARY_RE)
  const counts: ReviewSummary['issuesByCount'] = {
    critical: summaryMatch ? Number(summaryMatch[1]) : 0,
    high: summaryMatch ? Number(summaryMatch[2]) : 0,
    medium: summaryMatch ? Number(summaryMatch[3]) : 0,
    low: summaryMatch ? Number(summaryMatch[4]) : 0,
  }
  const verdictMatch = reviewMarkdown.match(VERDICT_RE)
  const verdict = verdictMatch?.[1] ?? 'NEEDS_DISCUSSION'

  let suppressedCount = 0
  const dropped: string[] = []

  // Cache file reads so a single file with many findings doesn't get re-read.
  const fileCache = new Map<string, string | null>()

  const blocks = reviewMarkdown.match(ISSUE_BLOCK_RE) ?? []
  for (const block of blocks) {
    const severityMatch = block.match(SEVERITY_HEAD_RE)
    const fileLineMatch = block.match(FILE_LINE_RE)
    if (!severityMatch || !fileLineMatch) continue
    const [, severity] = severityMatch
    const path = fileLineMatch[1]
    const line = Number(fileLineMatch[2])

    let fileContent: string | null | undefined = fileCache.get(path)
    if (fileContent === undefined) {
      fileContent = await readFileSafe(repoRoot, path)
      fileCache.set(path, fileContent)
    }

    if (fileContent && shouldSuppress(fileContent, line)) {
      dropped.push(block)
      decrementSeverity(severity, counts)
      suppressedCount += 1
    }
  }

  let filtered = reviewMarkdown
  for (const block of dropped) {
    filtered = filtered.replace(block, '')
  }

  // Rewrite the Issues Summary line.
  if (summaryMatch) {
    filtered = filtered.replace(
      ISSUES_SUMMARY_RE,
      `Issues Summary: ${counts.critical} CRITICAL, ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW`,
    )
  }

  if (suppressedCount > 0) {
    const noun = suppressedCount === 1 ? 'finding' : 'findings'
    filtered = filtered.trimEnd() + `\n\nSuppressed: ${suppressedCount} ${noun} via \`kode-review: ignore\` markers.\n`
  }

  return {
    filtered,
    suppressedCount,
    summary: { verdict, issuesByCount: counts },
  }
}
