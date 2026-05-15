/**
 * Reviewer registry.
 *
 * A "reviewer" is a named persona with its own system prompt. The CLI exposes
 * reviewers via `--reviewer <name[,name2,...]>` and runs them in parallel,
 * each in its own pi `AgentSession`.
 *
 * Reviewer names resolve in this order:
 *   1. User-defined  — any `<name>.md` in the user reviewers directory
 *      (see `getUserReviewersDir()`). A user file with the same name as a
 *      built-in overrides the built-in. A user file with a new name adds a
 *      new reviewer.
 *   2. Built-in      — shipped templates under `templates/<name>.md`.
 *
 * The registry intentionally keeps reviewer metadata small. The full prompt
 * lives in the template file so users can diff/customise it.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Name of the user reviewers subdirectory under the kode-review config root. */
const USER_REVIEWERS_SUBDIR = 'reviewers'

/** Built-in reviewer names. The order here is the order used by `all`. */
export const BUILTIN_REVIEWER_NAMES = [
  'general',
  'security',
  'architect',
  'doc-reviewer',
  'test-auditor',
] as const

export type BuiltinReviewerName = typeof BUILTIN_REVIEWER_NAMES[number]

/** Description shown by `--help` / discovery commands. */
export const BUILTIN_REVIEWER_DESCRIPTIONS: Record<BuiltinReviewerName, string> = {
  'general': 'Thorough general-purpose review (security, bugs, quality, conventions).',
  'security': 'Application security: vulnerabilities, authn/authz, secrets, dependencies.',
  'architect': 'Architecture compliance, design quality, and simplicity (YAGNI).',
  'doc-reviewer': 'Public API documentation: presence, accuracy, completeness.',
  'test-auditor': 'Test quality and coverage; flags anti-gaming patterns.',
}

export interface ReviewerInfo {
  /** Reviewer slug used on the CLI. */
  name: string
  /** True if shipped with kode-review; false if loaded from the user dir. */
  builtin: boolean
  /** Absolute path to the markdown template used as the system prompt. */
  templatePath: string
  /** Short description for `--help` / discovery output. */
  description: string
}

/** Absolute path to the directory shipped with kode-review's built-in templates. */
export function getBuiltinTemplatesDir(): string {
  // This file is compiled to dist/index.js by tsup; tsup's onSuccess hook
  // copies templates/*.md to dist/reviewers/templates/. In source, the
  // templates live next to this file.
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, 'templates')
}

/**
 * Absolute path to the user reviewers directory.
 *
 * Resolution:
 *   1. `$KODE_REVIEW_REVIEWERS_DIR` if set.
 *   2. `$XDG_CONFIG_HOME/kode-review/reviewers` if set.
 *   3. `~/.config/kode-review/reviewers`.
 *
 * The directory is not created here — discovery is best-effort and tolerates
 * the directory not existing.
 */
export function getUserReviewersDir(): string {
  const envOverride = process.env.KODE_REVIEW_REVIEWERS_DIR
  if (envOverride && envOverride.length > 0) return envOverride

  const xdg = process.env.XDG_CONFIG_HOME
  const configRoot = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(configRoot, 'kode-review', USER_REVIEWERS_SUBDIR)
}

/**
 * Names of reviewer slugs that resolve to a user-defined template. Order is
 * stable (alphabetical) so `all` produces predictable output.
 */
export function listUserReviewerNames(): string[] {
  const dir = getUserReviewersDir()
  if (!existsSync(dir)) return []

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.toLowerCase().endsWith('.md'))
    .map((entry) => entry.slice(0, -3))
    .filter((name) => isValidReviewerName(name))
    .sort()
}

/**
 * Reviewer slugs are restricted to a conservative character set so they're
 * safe for filenames, CLI flags, and output filename derivation. Names are
 * lowercase-only: case-insensitive matching against a lowercase built-in
 * list and case-sensitive filesystems would otherwise disagree on Linux
 * vs macOS (e.g. `Security` would resolve on macOS, fail on Linux).
 */
export function isValidReviewerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)
}

/**
 * Resolve a single reviewer name to its template path + metadata.
 * Throws when the name isn't valid or no template can be found.
 */
export function resolveReviewer(name: string): ReviewerInfo {
  if (!isValidReviewerName(name)) {
    throw new Error(
      `Invalid reviewer name: "${name}". Reviewer names may contain letters, digits, underscore, and hyphen, must start with a letter or digit, and be at most 64 characters.`,
    )
  }

  const userPath = join(getUserReviewersDir(), `${name}.md`)
  if (existsSync(userPath)) {
    const builtin = (BUILTIN_REVIEWER_NAMES as readonly string[]).includes(name)
    return {
      name,
      builtin: false,
      templatePath: userPath,
      description: builtin
        ? `${BUILTIN_REVIEWER_DESCRIPTIONS[name as BuiltinReviewerName]} (user override)`
        : 'User-defined reviewer.',
    }
  }

  if ((BUILTIN_REVIEWER_NAMES as readonly string[]).includes(name)) {
    const builtinName = name as BuiltinReviewerName
    return {
      name: builtinName,
      builtin: true,
      templatePath: join(getBuiltinTemplatesDir(), `${name}.md`),
      description: BUILTIN_REVIEWER_DESCRIPTIONS[builtinName],
    }
  }

  throw new Error(
    `Unknown reviewer: "${name}". Built-in reviewers: ${BUILTIN_REVIEWER_NAMES.join(
      ', ',
    )}. To define your own, drop a prompt at ${join(getUserReviewersDir(), `${name}.md`)}.`,
  )
}

/**
 * Every reviewer currently available — built-ins plus user-defined.
 * User overrides of built-ins are listed once (as overrides).
 * Order: built-ins first (in their canonical order), then extra user-defined
 * reviewers (alphabetical).
 */
export function listAvailableReviewers(): ReviewerInfo[] {
  const userNames = new Set(listUserReviewerNames())
  const result: ReviewerInfo[] = []

  for (const name of BUILTIN_REVIEWER_NAMES) {
    result.push(resolveReviewer(name))
  }
  for (const name of Array.from(userNames).sort()) {
    if ((BUILTIN_REVIEWER_NAMES as readonly string[]).includes(name)) continue
    result.push(resolveReviewer(name))
  }
  return result
}
