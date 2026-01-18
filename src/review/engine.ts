import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk'
import { getConfig } from '../config/index.js'
import { buildReviewPrompt, type ReviewPromptOptions } from './prompt.js'
import { logger } from '../utils/logger.js'

export interface ReviewOptions {
  /** Diff content to review */
  diffContent: string
  /** Context description */
  context: string
  /** PR/MR info as JSON string */
  prMrInfo?: string
  /** Override provider */
  provider?: string
  /** Override model */
  model?: string
  /** Override variant */
  variant?: string
}

export interface ReviewResult {
  /** The review text output */
  content: string
  /** Token usage info */
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Run a code review using OpenCode SDK
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const config = getConfig()

  // Use overrides or config values
  const provider = options.provider ?? config.provider
  const model = options.model ?? config.model
  const variant = options.variant ?? config.variant

  logger.info(`Starting review with ${provider}/${model}${variant ? `:${variant}` : ''}`)

  // Build the prompt
  const promptOptions: ReviewPromptOptions = {
    context: options.context,
    diffContent: options.diffContent,
    prMrInfo: options.prMrInfo,
  }
  const prompt = buildReviewPrompt(promptOptions)

  // Start OpenCode server and client
  const { client, server } = await createOpencode({
    port: 0, // Random available port
    timeout: 30000, // 30 second timeout for server start
  })

  try {
    // Create a session
    const sessionResult = await client.session.create({
      body: { title: 'Code Review' },
    })

    if (!sessionResult.data) {
      throw new Error('Failed to create session')
    }

    const sessionId = sessionResult.data.id

    // Build model specification
    const modelSpec: { providerID: string; modelID: string; variant?: string } = {
      providerID: provider,
      modelID: model,
    }

    if (variant) {
      modelSpec.variant = variant
    }

    // Send the review prompt
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: modelSpec,
        parts: [{ type: 'text', text: prompt }],
      },
    })

    if (!result.data) {
      throw new Error('Failed to get review response')
    }

    // Extract text content from parts
    const content = result.data.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')

    return {
      content,
    }
  } finally {
    // Always clean up the server
    server.close()
  }
}

/**
 * Run a review by connecting to an existing OpenCode server
 */
export async function runReviewWithServer(
  serverUrl: string,
  options: ReviewOptions
): Promise<ReviewResult> {
  const config = getConfig()

  const provider = options.provider ?? config.provider
  const model = options.model ?? config.model
  const variant = options.variant ?? config.variant

  logger.info(`Connecting to server at ${serverUrl}`)
  logger.info(`Using ${provider}/${model}${variant ? `:${variant}` : ''}`)

  const client = createOpencodeClient({
    baseUrl: serverUrl,
  })

  const promptOptions: ReviewPromptOptions = {
    context: options.context,
    diffContent: options.diffContent,
    prMrInfo: options.prMrInfo,
  }
  const prompt = buildReviewPrompt(promptOptions)

  // Create session and send prompt
  const sessionResult = await client.session.create({
    body: { title: 'Code Review' },
  })

  if (!sessionResult.data) {
    throw new Error('Failed to create session')
  }

  const modelSpec: { providerID: string; modelID: string; variant?: string } = {
    providerID: provider,
    modelID: model,
  }

  if (variant) {
    modelSpec.variant = variant
  }

  const result = await client.session.prompt({
    path: { id: sessionResult.data.id },
    body: {
      model: modelSpec,
      parts: [{ type: 'text', text: prompt }],
    },
  })

  if (!result.data) {
    throw new Error('Failed to get review response')
  }

  const content = result.data.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

  return { content }
}
