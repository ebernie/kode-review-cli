/**
 * Review engine — runs a code review through a pi `AgentSession`.
 *
 * Two public entry points:
 * - `runReview`: text-only review (no tools). Honors `options.systemPrompt`
 *   and `options.userPromptOverride` for callers that want to substitute
 *   the role/body (persona dispatch).
 * - `runAgenticReview`: registers kode-review's read-only tools and runs
 *   the agentic loop. Defaults to the agentic system prompt + diff prompt
 *   builder, but also honors `options.systemPrompt` and
 *   `options.userPromptOverride` (used by --scope repo persona review).
 *
 * Both share the same underlying lifecycle (auth gate, session creation,
 * event collection, response extraction, dispose).
 */

import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
} from '@mariozechner/pi-coding-agent'
import type { Api, Model } from '@mariozechner/pi-ai'
import { logger } from '../utils/logger.js'
import { AppError } from '../utils/errors.js'
import { buildReviewPrompt, type ReviewPromptOptions } from './prompt.js'
import {
  AGENTIC_SYSTEM_PROMPT,
  buildAgenticPrompt,
  type AgenticPromptOptions,
} from './agentic-prompt.js'
import { createKodeReviewToolsExtension, type ToolContext } from './pi-tools.js'
import { attachReviewListener, type ReviewProgress } from './session-events.js'
import { extractReviewContent } from './response.js'
import { aggregateUsage, type UsageTotals } from './usage.js'
import { parseFindingsBlock } from './finding-parser.js'
import type { Finding } from './finding-schema.js'
import { summarizeBoundariesForFiles } from './trust-boundaries.js'

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_AGENTIC_TIMEOUT_SEC = 600
const DEFAULT_AGENTIC_MAX_ITERATIONS = 10

export interface ReviewOptions {
  diffContent: string
  context: string
  prMrInfo?: string
  semanticContext?: string
  prDescriptionSummary?: string
  projectStructureContext?: string
  /** Pi model pattern, e.g. "anthropic/claude-sonnet-4-6". Default: pi's preferred model. */
  model?: string
  /**
   * Optional progress callback. Fired on every pi tool start/end event;
   * callers are expected to throttle if surfacing to a spinner / UI.
   */
  onProgress?: (progress: ReviewProgress) => void
  /**
   * Optional system prompt override. When set, the model's behaviour is
   * driven by this string instead of pi's default. Used by reviewer personas
   * to inject their own role definition while keeping the data-section user
   * prompt shared across reviewers.
   */
  systemPrompt?: string
  /**
   * Optional user prompt override. When set, this string is sent as the user
   * prompt instead of the legacy `buildReviewPrompt(...)` output. Callers
   * that supply `systemPrompt` should usually also supply this so the data
   * sections aren't duplicated.
   */
  userPromptOverride?: string
  /** Override the default timeout in ms. */
  timeoutMs?: number
}

export interface AgenticReviewOptions extends ReviewOptions {
  repoRoot: string
  repoUrl: string
  branch?: string
  /** When omitted, only `read_file` is registered (indexer-dependent tools are skipped). */
  indexerUrl?: string
  /** Maximum tool-call iterations before pi forces a text-only response. */
  maxIterations?: number
  /** Hard ceiling in seconds for the whole review. Default: 600. */
  timeout?: number
}

export interface ReviewResult {
  content: string
  usage: UsageTotals
  findings: Finding[]
}

export interface AgenticReviewResult {
  content: string
  toolCallCount: number
  truncated: boolean
  truncationReason?: string
  usage: UsageTotals
  findings: Finding[]
}

function findModel(
  available: ReadonlyArray<Model<Api>>,
  pattern: string,
): Model<Api> | undefined {
  const slashIdx = pattern.indexOf('/')
  if (slashIdx > 0) {
    const provider = pattern.slice(0, slashIdx)
    const id = pattern.slice(slashIdx + 1)
    return available.find((m) => m.provider === provider && m.id === id) as
      | Model<Api>
      | undefined
  }
  return available.find((m) => m.id === pattern) as Model<Api> | undefined
}

/**
 * Read pi's configured default model. Project settings (cwd/.pi/settings.json)
 * take precedence over global (~/.pi/agent/settings.json), matching pi's own
 * resolution order. Returns "provider/id" when both fields are set, just "id"
 * when only the model is set, or undefined when no preference exists.
 *
 * `defaultProvider` and `defaultModel` are treated as a *pair* per scope —
 * we never cross-mix a project model with a global provider (and vice versa),
 * since the synthesized "globalProvider/projectModel" pattern would silently
 * fail registry lookup and fall through to first-available.
 *
 * Never throws — pi settings missing/malformed means "no preference", not an
 * error. The fallback to first-available handles it.
 */
function readPiDefaultPattern(cwd: string): string | undefined {
  try {
    const sm = SettingsManager.create(cwd, getAgentDir())
    const project = sm.getProjectSettings()
    const global = sm.getGlobalSettings()
    return scopedPattern(project) ?? scopedPattern(global)
  } catch {
    return undefined
  }
}

function scopedPattern(settings: {
  defaultProvider?: string
  defaultModel?: string
}): string | undefined {
  if (!settings.defaultModel) return undefined
  if (settings.defaultProvider) return `${settings.defaultProvider}/${settings.defaultModel}`
  return settings.defaultModel
}

/**
 * Resolve the model the user wants for this review.
 *
 * Priority (highest → lowest):
 *  1. `--model provider/id` (or `--model id`) — hard error if not in registry
 *  2. `KODE_REVIEW_MODEL` env var — warn and fall through if not in registry
 *  3. pi's `defaultProvider/defaultModel` (`~/.pi/agent/settings.json`,
 *     project-scoped overrides take precedence) — warn and fall through
 *  4. First available model from pi's registry
 *
 * Throws `NO_PI_AUTH` when no model has usable credentials.
 */
async function resolveModel(
  modelRegistry: ModelRegistry,
  modelPattern: string | undefined,
  cwd: string,
): Promise<Model<Api>> {
  const available = await modelRegistry.getAvailable()
  if (available.length === 0) {
    throw new AppError(
      'No pi provider has usable credentials.',
      {
        category: 'review',
        recoveryHint: 'Run `pi` and use `/login` to set one up, then re-run kode-review.',
      },
    )
  }

  if (modelPattern) {
    const m = findModel(available, modelPattern)
    if (m) return m
    const examples = available
      .slice(0, 5)
      .map((m) => `${m.provider}/${m.id}`)
      .join(', ')
    throw new AppError(
      `Model "${modelPattern}" is not available in pi.`,
      {
        category: 'review',
        recoveryHint: `Available: ${examples}${available.length > 5 ? ', …' : ''}`,
      },
    )
  }

  const envPattern = process.env.KODE_REVIEW_MODEL?.trim()
  if (envPattern) {
    const m = findModel(available, envPattern)
    if (m) return m
    logger.warn(
      `KODE_REVIEW_MODEL="${envPattern}" not currently available in pi — falling back.`,
    )
  }

  const piPattern = readPiDefaultPattern(cwd)
  if (piPattern) {
    const m = findModel(available, piPattern)
    if (m) return m
    logger.warn(
      `Pi default model "${piPattern}" not currently available — falling back to first available model.`,
    )
  }

  return available[0] as Model<Api>
}

interface RunOptions {
  userPrompt: string
  modelPattern: string | undefined
  cwd: string
  systemPromptOverride?: string
  toolContext?: ToolContext
  timeoutMs: number
  maxIterations?: number
  onProgress?: (progress: ReviewProgress) => void
}

interface RunOutcome {
  content: string
  toolCallCount: number
  truncated: boolean
  usage: UsageTotals
}

async function runWithPi(opts: RunOptions): Promise<RunOutcome> {
  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  const model = await resolveModel(modelRegistry, opts.modelPattern, opts.cwd)
  logger.info(`Using model ${model.provider}/${model.id}`)

  const extensionFactories: Array<(pi: ExtensionAPI) => void | Promise<void>> = []
  if (opts.toolContext) {
    extensionFactories.push(createKodeReviewToolsExtension(opts.toolContext))
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    extensionFactories,
    systemPromptOverride: opts.systemPromptOverride
      ? () => opts.systemPromptOverride!
      : undefined,
    appendSystemPromptOverride: () => [],
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    authStorage,
    modelRegistry,
    model,
    noTools: opts.toolContext ? 'builtin' : 'all',
    resourceLoader,
    sessionManager: SessionManager.inMemory(opts.cwd),
  })

  const listener = attachReviewListener(session, { onProgress: opts.onProgress })

  const timeoutHandle: { id: NodeJS.Timeout | null } = { id: null }
  const reviewTimeout = new AppError(
    `Review did not complete within ${opts.timeoutMs / 1000}s.`,
    { category: 'review', recoveryHint: 'Re-run with a longer --agentic-timeout, or check that the chosen model is responding.' },
  )
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle.id = setTimeout(() => reject(reviewTimeout), opts.timeoutMs)
  })

  let content: string
  let toolCallCount: number
  // Initialize to zeroed totals so any future early-return path before the
  // try block still produces a valid (n/a) usage report.
  let usage: UsageTotals = aggregateUsage([])
  try {
    await Promise.race([session.prompt(opts.userPrompt), timeout, listener.done])
    // Read state BEFORE the finally block disposes the session. pi's current
    // dispose() leaves state intact, but reading after dispose() is a fragile
    // pattern that future SDK versions could break.
    content = extractReviewContent(session.state.messages)
    toolCallCount = listener.toolCallCount
    usage = aggregateUsage(session.state.messages)
  } catch (err) {
    if (err === reviewTimeout) {
      try {
        await session.abort()
      } catch (abortErr) {
        logger.debug(`abort() after timeout failed: ${String(abortErr)}`)
      }
    }
    throw err
  } finally {
    if (timeoutHandle.id) clearTimeout(timeoutHandle.id)
    listener.unsubscribe()
    session.dispose()
  }

  const truncated = opts.maxIterations !== undefined && toolCallCount >= opts.maxIterations
  return { content, toolCallCount, truncated, usage }
}

/**
 * Run a basic (text-only) code review.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  let userPrompt: string
  if (options.userPromptOverride !== undefined) {
    userPrompt = options.userPromptOverride
  } else {
    const promptOptions: ReviewPromptOptions = {
      context: options.context,
      diffContent: options.diffContent,
      prMrInfo: options.prMrInfo,
      semanticContext: options.semanticContext,
      prDescriptionSummary: options.prDescriptionSummary,
      projectStructureContext: options.projectStructureContext,
      trustBoundarySummary: buildTrustBoundarySummary(options.diffContent),
    }
    userPrompt = buildReviewPrompt(promptOptions)
  }

  const outcome = await runWithPi({
    userPrompt,
    modelPattern: options.model,
    cwd: process.cwd(),
    systemPromptOverride: options.systemPrompt,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onProgress: options.onProgress,
  })

  return {
    content: outcome.content,
    usage: outcome.usage,
    findings: extractFindings(outcome.content),
  }
}

/**
 * Run an agentic code review with kode-review tools registered.
 *
 * `systemPrompt` and `userPromptOverride` on the options are honored when
 * provided: callers (personas, repo-scope feature review) can substitute a
 * different role + body while keeping the tool-enabled agent loop.
 */
export async function runAgenticReview(
  options: AgenticReviewOptions,
): Promise<AgenticReviewResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_AGENTIC_MAX_ITERATIONS
  const timeoutSec = options.timeout ?? DEFAULT_AGENTIC_TIMEOUT_SEC

  let userPrompt: string
  if (options.userPromptOverride !== undefined) {
    userPrompt = options.userPromptOverride
  } else {
    const promptOptions: AgenticPromptOptions = {
      diffContent: options.diffContent,
      context: options.context,
      prMrInfo: options.prMrInfo,
      prDescriptionSummary: options.prDescriptionSummary,
      projectStructureContext: options.projectStructureContext,
    }
    userPrompt = buildAgenticPrompt(promptOptions)
  }

  const outcome = await runWithPi({
    userPrompt,
    modelPattern: options.model,
    cwd: options.repoRoot,
    systemPromptOverride: options.systemPrompt ?? AGENTIC_SYSTEM_PROMPT,
    toolContext: {
      repoRoot: options.repoRoot,
      repoUrl: options.repoUrl,
      indexerUrl: options.indexerUrl,
      branch: options.branch,
    },
    timeoutMs: timeoutSec * 1000,
    maxIterations,
    onProgress: options.onProgress,
  })

  return {
    content: outcome.content,
    toolCallCount: outcome.toolCallCount,
    truncated: outcome.truncated,
    truncationReason: outcome.truncated
      ? `Maximum iteration limit (${maxIterations}) reached`
      : undefined,
    usage: outcome.usage,
    findings: extractFindings(outcome.content),
  }
}

/**
 * Parse the fenced kode-findings block from the assistant's text output.
 *
 * Never throws — missing/invalid blocks log a warning and return [].
 * Downstream consumers treat zero findings the same regardless of cause.
 */
function extractFindings(content: string): Finding[] {
  const parsed = parseFindingsBlock(content)
  if (parsed.error === 'missing') {
    logger.warn(
      'Review output missing kode-findings block; downstream consumers will see zero structured findings.',
    )
  } else if (parsed.error) {
    logger.warn(
      `Review output kode-findings block failed validation (${parsed.error}): ${parsed.detail ?? ''}`,
    )
  }
  return parsed.findings
}

const DIFF_FILE_RE = /^diff --git a\/(\S+) b\/\S+/gm

function filesInDiff(diff: string): string[] {
  const seen = new Set<string>()
  DIFF_FILE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DIFF_FILE_RE.exec(diff)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

// Used by the non-agentic runReview path only; agentic reviews infer
// boundaries from the codebase via tool calls.
function buildTrustBoundarySummary(diff: string): string | undefined {
  const files = filesInDiff(diff)
  if (files.length === 0) return undefined
  const summary = summarizeBoundariesForFiles(files)
  if (summary.size === 0) return undefined
  const lines: string[] = []
  for (const [boundary, paths] of summary) {
    lines.push(`${boundary}: ${paths.join(', ')}`)
  }
  return lines.join('\n')
}
