/**
 * Review engine — runs a code review through a pi `AgentSession`.
 *
 * Two public entry points:
 * - `runReview`: text-only review (no tools, no system prompt override).
 * - `runAgenticReview`: registers kode-review's read-only tools and uses
 *   the agentic system prompt so the model can explore the codebase.
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
import { attachReviewListener } from './session-events.js'
import { extractReviewContent } from './response.js'

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_AGENTIC_TIMEOUT_SEC = 120
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
}

export interface AgenticReviewOptions extends ReviewOptions {
  repoRoot: string
  repoUrl: string
  branch?: string
  /** When omitted, only `read_file` is registered (indexer-dependent tools are skipped). */
  indexerUrl?: string
  /** Maximum tool-call iterations before pi forces a text-only response. */
  maxIterations?: number
  /** Hard ceiling in seconds for the whole review. Default: 120. */
  timeout?: number
}

export interface ReviewResult {
  content: string
}

export interface AgenticReviewResult {
  content: string
  toolCallCount: number
  truncated: boolean
  truncationReason?: string
}

/**
 * Resolve the model the user wants for this review.
 *
 * Priority:
 *  1. `--model provider/id` (or `--model id` matching a known provider)
 *  2. First available model from pi's registry (i.e. one with valid creds)
 *
 * Throws `NO_PI_AUTH` when no model has usable credentials.
 */
async function resolveModel(
  modelRegistry: ModelRegistry,
  modelPattern: string | undefined,
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
    const slashIdx = modelPattern.indexOf('/')
    if (slashIdx > 0) {
      const provider = modelPattern.slice(0, slashIdx)
      const id = modelPattern.slice(slashIdx + 1)
      const exact = available.find((m) => m.provider === provider && m.id === id)
      if (exact) return exact as Model<Api>
    } else {
      const byId = available.find((m) => m.id === modelPattern)
      if (byId) return byId as Model<Api>
    }
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
}

interface RunOutcome {
  content: string
  toolCallCount: number
  truncated: boolean
}

async function runWithPi(opts: RunOptions): Promise<RunOutcome> {
  const authStorage = AuthStorage.create()
  const modelRegistry = ModelRegistry.create(authStorage)
  const model = await resolveModel(modelRegistry, opts.modelPattern)
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

  const listener = attachReviewListener(session)

  const timeoutHandle: { id: NodeJS.Timeout | null } = { id: null }
  const reviewTimeout = new AppError(
    `Review did not complete within ${opts.timeoutMs / 1000}s.`,
    { category: 'review', recoveryHint: 'Re-run with a longer --agentic-timeout, or check that the chosen model is responding.' },
  )
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle.id = setTimeout(() => reject(reviewTimeout), opts.timeoutMs)
  })

  try {
    await Promise.race([session.prompt(opts.userPrompt), timeout, listener.done])
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

  const content = extractReviewContent(session.state.messages)
  const toolCallCount = listener.toolCallCount
  const truncated = opts.maxIterations !== undefined && toolCallCount >= opts.maxIterations

  return { content, toolCallCount, truncated }
}

/**
 * Run a basic (text-only) code review.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const promptOptions: ReviewPromptOptions = {
    context: options.context,
    diffContent: options.diffContent,
    prMrInfo: options.prMrInfo,
    semanticContext: options.semanticContext,
    prDescriptionSummary: options.prDescriptionSummary,
    projectStructureContext: options.projectStructureContext,
  }

  const outcome = await runWithPi({
    userPrompt: buildReviewPrompt(promptOptions),
    modelPattern: options.model,
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })

  return { content: outcome.content }
}

/**
 * Run an agentic code review with kode-review tools registered.
 */
export async function runAgenticReview(
  options: AgenticReviewOptions,
): Promise<AgenticReviewResult> {
  const promptOptions: AgenticPromptOptions = {
    diffContent: options.diffContent,
    context: options.context,
    prMrInfo: options.prMrInfo,
    prDescriptionSummary: options.prDescriptionSummary,
    projectStructureContext: options.projectStructureContext,
  }

  const maxIterations = options.maxIterations ?? DEFAULT_AGENTIC_MAX_ITERATIONS
  const timeoutSec = options.timeout ?? DEFAULT_AGENTIC_TIMEOUT_SEC

  if (!options.indexerUrl) {
    logger.warn('Indexer URL not provided — only `read_file` will be available to the agent.')
  }

  const outcome = await runWithPi({
    userPrompt: buildAgenticPrompt(promptOptions),
    modelPattern: options.model,
    cwd: options.repoRoot,
    systemPromptOverride: AGENTIC_SYSTEM_PROMPT,
    toolContext: {
      repoRoot: options.repoRoot,
      repoUrl: options.repoUrl,
      indexerUrl: options.indexerUrl,
      branch: options.branch,
    },
    timeoutMs: timeoutSec * 1000,
    maxIterations,
  })

  return {
    content: outcome.content,
    toolCallCount: outcome.toolCallCount,
    truncated: outcome.truncated,
    truncationReason: outcome.truncated
      ? `Maximum iteration limit (${maxIterations}) reached`
      : undefined,
  }
}
