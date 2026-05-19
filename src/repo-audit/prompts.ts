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
import { FINDINGS_BLOCK_INSTRUCTIONS } from '../review/index.js'
import { readFileSafe } from '../review/suppressions.js'
import { REPO_AUDIT_DEFAULTS, type FeatureRecord } from './types.js'

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
function langHintFromPath(path: string): string {
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
  parts.push(`featureId: ${feature.featureId}`)
  parts.push(`title: ${feature.title}`)
  parts.push(`kind: ${feature.kind}`)
  parts.push(`confidence: ${feature.confidence}`)
  parts.push(`summary: ${feature.summary}`)
  if (feature.entrypoints.length > 0) {
    parts.push('entrypoints:')
    for (const e of feature.entrypoints) {
      const bits = [e.path]
      if (e.symbol) bits.push(`symbol=${e.symbol}`)
      if (e.route) bits.push(`route=${e.route}`)
      if (e.command) bits.push(`command=${e.command}`)
      parts.push(`  - ${bits.join('  ')}`)
    }
  }
  if (feature.trustBoundaries.length > 0) {
    parts.push(`trust_boundaries: ${feature.trustBoundaries.join(', ')}`)
  }
  if (feature.tags.length > 0) {
    parts.push(`tags: ${feature.tags.join(', ')}`)
  }
  parts.push('</feature_metadata>')
  parts.push('')

  // Owned files
  parts.push('## Owned Files')
  parts.push('')
  for (const ref of ownedHead) {
    const body = await readFileSafe(repoRoot, ref.path)
    if (body === null) {
      deferredFiles.push(ref.path)
      parts.push(`<file path="${ref.path}" reason="${ref.reason}" deferred="true" />`)
      parts.push('')
      continue
    }
    inlinedFiles.push(ref.path)
    parts.push(`<file path="${ref.path}" reason="${ref.reason}">`)
    parts.push('```' + langHintFromPath(ref.path))
    parts.push(body)
    parts.push('```')
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
      const body = await readFileSafe(repoRoot, ref.path)
      if (body === null) {
        deferredFiles.push(ref.path)
        parts.push(`<file path="${ref.path}" reason="${ref.reason}" deferred="true" />`)
        parts.push('')
        continue
      }
      inlinedFiles.push(ref.path)
      parts.push(`<file path="${ref.path}" reason="${ref.reason}">`)
      parts.push('```' + langHintFromPath(ref.path))
      parts.push(body)
      parts.push('```')
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

