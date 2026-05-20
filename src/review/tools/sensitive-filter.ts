/**
 * Shared sensitive-path filter for read-only agent tools.
 *
 * `read_file` performs its own sensitive-path / symlink / gitignore checks
 * before reading. Tools that bypass `read_file` and return file contents
 * directly from ripgrep matches or indexer rows (search_code,
 * find_definitions, find_usages) need to apply the same denylist here so
 * matches in .env, application-prod.yml, id_rsa, etc. never reach the model.
 *
 * Threat model: an indexed repository may contain a tracked secrets file —
 * configuration leak, mis-committed credentials. Returning the matching
 * line content to a tool-enabled LLM exposes that secret to the model and,
 * downstream, to any PR comment the model emits.
 */

import { isSensitivePath } from './read-file.js'

/**
 * Drop entries whose `path` matches a sensitive-file pattern.
 *
 * Pure: returns a new array. Generic over the result shape — callers retain
 * their own field types (definitions, usages, search hits).
 *
 * The path is expected to be repo-relative. An absolute path is still
 * checked component-by-component (the underlying `isSensitivePath` walks
 * path parts), so handlers receiving paths from an indexer or other
 * external source do not need to pre-normalize. They MUST NOT rely on a
 * downstream `read_file` call to serve as a second guard — these handlers
 * return content directly.
 */
export function filterSensitivePaths<T extends { path: string }>(
  results: ReadonlyArray<T>,
): T[] {
  return results.filter((r) => !isSensitivePath(r.path))
}

/**
 * String-array variant of {@link filterSensitivePaths}. Used by handlers
 * whose response shape is `string[]` rather than `{ path }[]` — e.g.
 * `get_impact` returns importer/importee lists as bare path strings.
 */
export function filterSensitivePathStrings(paths: ReadonlyArray<string>): string[] {
  return paths.filter((p) => !isSensitivePath(p))
}
