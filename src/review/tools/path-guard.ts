/**
 * Shared path-traversal guard for agentic tools that accept file paths from
 * the model. Untrusted model-provided paths must never escape repoRoot — even
 * when handed to `git log -- <path>` (which won't read the file but will leak
 * the existence of paths outside the tree) or to ripgrep import-pattern
 * lookups.
 *
 * For the fully-fledged check (sensitive-path filtering, gitignore, symlink
 * resolution), use the `read_file` handler instead — that tool actually reads
 * file contents and warrants the heavier guard.
 */

import { isAbsolute, relative, resolve } from 'node:path'

export function assertWithinRepo(repoRoot: string, inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required')
  }
  const normalizedRoot = resolve(repoRoot)
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(normalizedRoot, inputPath)
  const rel = relative(normalizedRoot, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${inputPath} resolves outside repository root`)
  }
  return rel
}
