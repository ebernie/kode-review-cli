/**
 * Prompt construction for repo-scope feature review.
 *
 * Reuses the existing persona system prompts (general / security / architect /
 * test-auditor) but adapts them with:
 *   1. A short "FEATURE REVIEW MODE" suffix appended to the system prompt
 *      that tells the model to treat the diff-mode anti-hallucination rules
 *      as "owned/context files visible here OR obtained via tools" rather
 *      than "the diff."
 *   2. A user prompt body structured around the feature record + capped
 *      file contents, rather than around a diff.
 *
 * Hard caps mirror clawpatch (MAX_OWNED_FILES_IN_PROMPT=12, MAX_CONTEXT_FILES_IN_PROMPT=24).
 * Files that exceed the cap are listed by path with a "use read_file to view"
 * hint — the agent can still reach them, but they don't bloat the seed.
 */
import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { FINDINGS_BLOCK_INSTRUCTIONS } from '../review/index.js'
import { readFileSafe } from '../review/suppressions.js'
import { assertWithinRepo } from '../review/tools/path-guard.js'
import { REPO_AUDIT_DEFAULTS, type FeatureRecord } from './types.js'

/**
 * XML attribute escaper — guards against feature paths / reasons containing
 * `"`, `<`, `>`, `&`, `'` from corrupting the `<file path="..." reason="...">`
 * wrappers we use to delimit inlined file content in the prompt.
 *
 * Exported so sibling prompt builders (`revalidation-prompts.ts`) share the
 * same escaping semantics.
 */
export function escXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Pick a fence delimiter that does not appear as a complete sequence in the
 * file body. Starts at 3 backticks and grows to longest-run-plus-one whenever
 * the body contains a longer run. Stops file content (e.g. a markdown README
 * containing ```code```) from prematurely closing the fence and letting
 * downstream text become instructions to the model.
 */
export function pickFence(body: string): string {
  const runs = body.match(/`{3,}/g)
  if (!runs) return '```'
  let longest = 0
  for (const r of runs) longest = Math.max(longest, r.length)
  return '`'.repeat(longest + 1)
}

/**
 * Minimal sensitive-path predicate for prompt inlining. Mirrors the most
 * common patterns from `src/review/tools/read-file.ts` but is intentionally
 * narrower — we only need to catch the exfiltration class where an in-repo
 * symlink points at a credential-bearing file. Path components are matched
 * exactly (case-insensitive on the basename for extensions / known names).
 *
 * This is a defense-in-depth check after realpath containment. The primary
 * boundary is `readFileForPrompt`'s realpath/repo-root verification — this
 * function exists to close the in-repo-symlink-to-sensitive subcase.
 */
function isSensitivePathForPrompt(relPath: string): boolean {
  const parts = relPath.split(sep).filter(Boolean)
  const basename = parts[parts.length - 1] ?? ''
  const lower = basename.toLowerCase()

  // Path-component matches: .git, .ssh, .aws, .gnupg, .docker, .env*, etc.
  for (const part of parts) {
    if (part === '.git' || part === '.ssh' || part === '.aws' ||
        part === '.gnupg' || part === '.docker' || part === '.npmrc' ||
        part === '.pypirc') {
      return true
    }
    if (part === '.env' || (part.startsWith('.env.') &&
        part !== '.env.example' && part !== '.env.sample' && part !== '.env.template')) {
      return true
    }
  }

  // Basename: private-key extensions (with .pub exempt), SSH basenames,
  // service-account / credentials JSON.
  const SENSITIVE_EXTS = ['.pem', '.key', '.p12', '.pfx']
  if (!lower.endsWith('.pub')) {
    for (const ext of SENSITIVE_EXTS) {
      if (lower.endsWith(ext)) return true
    }
  }
  if (lower === 'id_rsa' || lower === 'id_ed25519' ||
      lower === 'id_ecdsa' || lower === 'id_dsa') {
    return true
  }
  if (/(^|[-_.])service[-_]?account.*\.json$/i.test(lower)) return true
  if (/(^|[-_.])credentials?\.json$/i.test(lower)) return true

  return false
}

/**
 * Read a file for inclusion in the model-bound prompt with strict realpath
 * verification: a symlink that resolves outside the repository is rejected,
 * even if the original path was within. This is stricter than `readFileSafe`,
 * which is appropriate for suppression-marker checking (content is never sent
 * to the model) but inappropriate here — we must never inline `/etc/passwd`
 * or similar via a malicious in-repo symlink.
 */
export async function readFileForPrompt(repoRoot: string, relPath: string): Promise<string | null> {
  let safe: string
  try {
    safe = assertWithinRepo(repoRoot, relPath)
  } catch {
    return null
  }
  const candidate = resolve(repoRoot, safe)
  let realFile: string
  let realRoot: string
  try {
    realFile = await realpath(candidate)
    realRoot = await realpath(repoRoot)
  } catch {
    return null
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    return null
  }
  // Even in-repo symlinks must not point at sensitive files (e.g., a symlink
  // `src/innocuous.ts → .env` would otherwise leak secrets into the prompt,
  // since Node's readFile follows symlinks transparently).
  const realRelative = relative(realRoot, realFile)
  if (isSensitivePathForPrompt(realRelative)) {
    return null
  }
  return readFileSafe(repoRoot, relPath)
}

/**
 * Suffix appended to a reviewer's system prompt when invoked in feature mode.
 *
 * Kept short and additive: it does not contradict the persona's own
 * instructions — it only re-targets the anti-hallucination rules from "the
 * diff" to "the files visible in this prompt or reachable via tools."
 */
export const FEATURE_REVIEW_MODE_SUFFIX = `
## FEATURE REVIEW MODE (added by --scope repo)

You are reviewing one **feature** of a codebase, not a diff. Adapt your
context rules accordingly:

- Treat the owned_files and context_files sections of the user message as
  the equivalent of "the diff" — they are the primary surface for citation.
- You also have access to file/search/git tools. Findings cited from files
  obtained via tool calls are valid, provided you read them in this session.
- "Reviewing the whole feature" does not mean enumerating every concern —
  prioritise the highest-impact issues. Cap your output at the most
  actionable findings (the persona's existing severity rubric applies).
- The feature's declared trust_boundaries tell you what attack surface it
  crosses; use them to focus rather than to gate (every persona still
  applies its own criteria).
`.trim()

/**
 * Wrap raw file content in a fenced, language-hinted block. The language
 * hint is best-effort: it gives the model a syntax cue but does not
 * structurally rely on accuracy.
 */
export function langHintFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c',
    h: 'c', hpp: 'cpp', swift: 'swift', md: 'markdown', json: 'json',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash', bash: 'bash',
  }
  return map[ext] ?? ''
}

export interface BuiltFeaturePrompt {
  /** The full system prompt suffix to append after the persona's template. */
  systemSuffix: string
  /** The user prompt body, structured around the feature. */
  userPrompt: string
  /** Files actually inlined (subset of feature.ownedFiles + contextFiles). */
  inlinedFiles: string[]
  /** Files referenced but not inlined (over the per-section cap). */
  deferredFiles: string[]
}

export interface BuildFeaturePromptOptions {
  feature: FeatureRecord
  repoRoot: string
  maxOwnedFiles?: number
  maxContextFiles?: number
}

/**
 * Build the (system suffix, user prompt) pair for reviewing one feature.
 *
 * - Reads file contents from disk (the orchestrator could pre-read, but a
 *   single feature is small and the simplification is worth it).
 * - Unreadable files are listed under a "deferred" header so the agent
 *   knows to try them with tools rather than assume they're absent.
 */
export async function buildFeatureReviewPrompt(
  opts: BuildFeaturePromptOptions,
): Promise<BuiltFeaturePrompt> {
  const { feature, repoRoot } = opts
  const maxOwned = opts.maxOwnedFiles ?? REPO_AUDIT_DEFAULTS.MAX_OWNED_FILES_IN_PROMPT
  const maxContext = opts.maxContextFiles ?? REPO_AUDIT_DEFAULTS.MAX_CONTEXT_FILES_IN_PROMPT

  const ownedHead = feature.ownedFiles.slice(0, maxOwned)
  const ownedTail = feature.ownedFiles.slice(maxOwned)
  const contextHead = feature.contextFiles.slice(0, maxContext)
  const contextTail = feature.contextFiles.slice(maxContext)

  const inlinedFiles: string[] = []
  const deferredFiles: string[] = []

  const parts: string[] = []
  parts.push('## Feature Under Review')
  parts.push('')
  parts.push('<feature_metadata>')
  parts.push(`featureId: ${escXmlAttr(feature.featureId)}`)
  parts.push(`title: ${escXmlAttr(feature.title)}`)
  parts.push(`kind: ${escXmlAttr(feature.kind)}`)
  parts.push(`confidence: ${escXmlAttr(feature.confidence)}`)
  parts.push(`summary: ${escXmlAttr(feature.summary)}`)
  if (feature.entrypoints.length > 0) {
    parts.push('entrypoints:')
    for (const e of feature.entrypoints) {
      const bits = [escXmlAttr(e.path)]
      if (e.symbol) bits.push(`symbol=${escXmlAttr(e.symbol)}`)
      if (e.route) bits.push(`route=${escXmlAttr(e.route)}`)
      if (e.command) bits.push(`command=${escXmlAttr(e.command)}`)
      parts.push(`  - ${bits.join('  ')}`)
    }
  }
  if (feature.trustBoundaries.length > 0) {
    // trustBoundaries is z.enum-validated against TRUST_BOUNDARIES — safe raw.
    parts.push(`trust_boundaries: ${feature.trustBoundaries.join(', ')}`)
  }
  if (feature.tags.length > 0) {
    parts.push(`tags: ${feature.tags.map(escXmlAttr).join(', ')}`)
  }
  parts.push('</feature_metadata>')
  parts.push('')

  // Owned files
  parts.push('## Owned Files')
  parts.push('')
  for (const ref of ownedHead) {
    const body = await readFileForPrompt(repoRoot, ref.path)
    const pathAttr = escXmlAttr(ref.path)
    const reasonAttr = escXmlAttr(ref.reason)
    if (body === null) {
      deferredFiles.push(ref.path)
      parts.push(`<file path="${pathAttr}" reason="${reasonAttr}" deferred="true" />`)
      parts.push('')
      continue
    }
    inlinedFiles.push(ref.path)
    const fence = pickFence(body)
    parts.push(`<file path="${pathAttr}" reason="${reasonAttr}">`)
    parts.push(fence + langHintFromPath(ref.path))
    parts.push(body)
    parts.push(fence)
    parts.push('</file>')
    parts.push('')
  }
  if (ownedTail.length > 0) {
    parts.push('### Additional owned files (use read_file to view)')
    for (const ref of ownedTail) {
      deferredFiles.push(ref.path)
      parts.push(`- ${ref.path}  (${ref.reason})`)
    }
    parts.push('')
  }

  // Context files
  if (feature.contextFiles.length > 0) {
    parts.push('## Context Files (tests, related code, docs)')
    parts.push('')
    for (const ref of contextHead) {
      const body = await readFileForPrompt(repoRoot, ref.path)
      const pathAttr = escXmlAttr(ref.path)
      const reasonAttr = escXmlAttr(ref.reason)
      if (body === null) {
        deferredFiles.push(ref.path)
        parts.push(`<file path="${pathAttr}" reason="${reasonAttr}" deferred="true" />`)
        parts.push('')
        continue
      }
      inlinedFiles.push(ref.path)
      const fence = pickFence(body)
      parts.push(`<file path="${pathAttr}" reason="${reasonAttr}">`)
      parts.push(fence + langHintFromPath(ref.path))
      parts.push(body)
      parts.push(fence)
      parts.push('</file>')
      parts.push('')
    }
    if (contextTail.length > 0) {
      parts.push('### Additional context files (use read_file to view)')
      for (const ref of contextTail) {
        deferredFiles.push(ref.path)
        parts.push(`- ${ref.path}  (${ref.reason})`)
      }
      parts.push('')
    }
  }

  // Tests
  if (feature.tests.length > 0) {
    parts.push('## Tests')
    parts.push('')
    parts.push('<tests>')
    for (const t of feature.tests) {
      const bits = [t.path]
      if (t.command) bits.push(`run via: ${t.command}`)
      parts.push(`- ${bits.join('  ')}`)
    }
    parts.push('</tests>')
    parts.push('')
  }

  parts.push('## Output Instructions')
  parts.push('')
  parts.push(
    'Apply your persona\'s severity rubric. Emit findings only with concrete evidence ' +
      'from files visible above OR files you read via tools in this session. Cap your output ' +
      `at ${REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE} findings — pick the most impactful.`,
  )
  parts.push('')
  // Structured-output contract: downstream parsers REQUIRE this block.
  parts.push(FINDINGS_BLOCK_INSTRUCTIONS)

  return {
    systemSuffix: FEATURE_REVIEW_MODE_SUFFIX,
    userPrompt: parts.join('\n'),
    inlinedFiles,
    deferredFiles,
  }
}

