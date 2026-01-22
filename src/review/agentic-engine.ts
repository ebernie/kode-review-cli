/**
 * Agentic review engine
 *
 * Uses OpenCode SDK with MCP (Model Context Protocol) to provide the AI agent
 * with tools for dynamically exploring the codebase during review.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createOpencode, createOpencodeClient, type TextPart, type AgentConfig } from '@opencode-ai/sdk'
import { getConfig } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { AGENTIC_SYSTEM_PROMPT, buildAgenticPrompt, type AgenticPromptOptions } from './agentic-prompt.js'

// Get the directory of this module for locating the MCP server
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface AgenticReviewOptions {
  /** Diff content to review */
  diffContent: string
  /** Context description */
  context: string
  /** Repository root path */
  repoRoot: string
  /** Repository URL for indexer queries */
  repoUrl: string
  /** Current branch */
  branch?: string
  /** Indexer API URL (optional - when not provided, only read_file tool is available) */
  indexerUrl?: string
  /** PR/MR info as JSON string */
  prMrInfo?: string
  /** PR/MR description summary */
  prDescriptionSummary?: string
  /** Project structure context */
  projectStructureContext?: string
  /** Override provider */
  provider?: string
  /** Override model */
  model?: string
  /** Override variant */
  variant?: string
  /** Maximum tool call iterations */
  maxIterations?: number
  /** Timeout in seconds */
  timeout?: number
}

export interface AgenticReviewResult {
  /** The review text output */
  content: string
  /** Number of tool calls made */
  toolCallCount: number
  /** Whether the review was truncated due to limits */
  truncated: boolean
  /** Reason for truncation if applicable */
  truncationReason?: string
}

/**
 * Build the MCP server command for the OpenCode SDK
 *
 * Note: In the production build, this file is bundled into dist/index.js
 * and the MCP server is at dist/mcp/kode-review-mcp.js. The __dirname
 * for the bundled file is 'dist/', so the path is 'mcp/kode-review-mcp.js'
 * relative to __dirname.
 */
function getMcpServerCommand(
  repoRoot: string,
  repoUrl: string,
  indexerUrl?: string,
  branch?: string
): string[] {
  const mcpServerPath = join(__dirname, 'mcp', 'kode-review-mcp.js')

  const command = [
    'node',
    mcpServerPath,
    '--repo', repoRoot,
    '--repo-url', repoUrl,
  ]

  // Only add indexer argument when URL is provided
  if (indexerUrl) {
    command.push('--indexer', indexerUrl)
  }

  if (branch) {
    command.push('--branch', branch)
  }

  return command
}

/**
 * Run an agentic code review with dynamic codebase exploration
 */
export async function runAgenticReview(
  options: AgenticReviewOptions
): Promise<AgenticReviewResult> {
  const config = getConfig()

  // Use overrides or config values
  const provider = options.provider ?? config.provider
  const model = options.model ?? config.model
  const variant = options.variant ?? config.variant
  const maxIterations = options.maxIterations ?? 10
  const timeoutSec = options.timeout ?? 120

  logger.info(`Starting agentic review with ${provider}/${model}${variant ? `:${variant}` : ''}`)
  logger.info(`Max iterations: ${maxIterations}, Timeout: ${timeoutSec}s`)

  // Build the prompt
  const promptOptions: AgenticPromptOptions = {
    diffContent: options.diffContent,
    context: options.context,
    prMrInfo: options.prMrInfo,
    prDescriptionSummary: options.prDescriptionSummary,
    projectStructureContext: options.projectStructureContext,
  }
  const userPrompt = buildAgenticPrompt(promptOptions)

  // Start OpenCode server
  const { client, server } = await createOpencode({
    port: 0, // Random available port
    timeout: 30000,
  })

  try {
    // Configure the agent with maxSteps to enforce iteration limit
    // This limits the number of tool call iterations before forcing a text-only response
    const agentConfig: AgentConfig = {
      maxSteps: maxIterations,
      // Allow all tool permissions for the review agent
      permission: {
        edit: 'deny',      // No file edits - review only
        bash: 'deny',      // No shell commands
        webfetch: 'deny',  // No web fetching
      },
    }

    await client.config.update({
      body: {
        agent: {
          general: agentConfig,
          build: agentConfig,
        },
      },
    })
    logger.debug(`Configured agent with maxSteps=${maxIterations}`)

    // Register the MCP server with OpenCode
    // The SDK manages the MCP server lifecycle - no need to spawn manually
    const mcpCommand = getMcpServerCommand(
      options.repoRoot,
      options.repoUrl,
      options.indexerUrl,  // Optional - when not provided, only read_file tool is available
      options.branch
    )

    // Log tool availability
    if (options.indexerUrl) {
      logger.debug('Full tool suite available (indexer connected)')
    } else {
      logger.warn('Limited tools available: only read_file (indexer not running)')
    }

    logger.debug(`Registering MCP server: ${mcpCommand.join(' ')}`)

    try {
      await client.mcp.add({
        body: {
          name: 'kode-review-tools',
          config: {
            type: 'local',
            command: mcpCommand,
            enabled: true,
          },
        },
      })
      logger.debug('Registered MCP server with OpenCode')
    } catch (mcpError) {
      // Fail fast if MCP registration fails - agentic mode requires at least read_file tool
      throw new Error(
        `Failed to register MCP tools with OpenCode: ${mcpError}\n` +
        'Agentic review requires tool access.'
      )
    }

    // Create a session
    const sessionResult = await client.session.create({
      body: { title: 'Agentic Code Review' },
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

    // Send the review prompt with system prompt
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: modelSpec,
        system: AGENTIC_SYSTEM_PROMPT,
        parts: [{ type: 'text', text: userPrompt }],
      },
    })

    if (!result.data) {
      throw new Error('Failed to get review response')
    }

    // Extract text content from parts
    const content = result.data.parts
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n')

    // Count tool calls from the response
    // OpenCode SDK uses 'tool' type for tool invocations
    let toolCallCount = 0
    for (const part of result.data.parts) {
      if (part.type === 'tool') {
        toolCallCount++
      }
    }

    // Check if the review was truncated due to hitting maxSteps
    // The SDK will force a text-only response when maxSteps is reached
    const truncated = toolCallCount >= maxIterations
    const truncationReason = truncated
      ? `Maximum iteration limit (${maxIterations}) reached`
      : undefined

    if (truncated) {
      logger.warn(`Agentic review truncated: ${truncationReason}`)
    }

    return {
      content,
      toolCallCount,
      truncated,
      truncationReason,
    }
  } finally {
    // Clean up OpenCode server (this also cleans up MCP servers managed by the SDK)
    server.close()
  }
}

/**
 * Run an agentic review by connecting to an existing OpenCode server
 */
export async function runAgenticReviewWithServer(
  serverUrl: string,
  options: Omit<AgenticReviewOptions, 'indexerUrl'> & { indexerUrl?: string }
): Promise<AgenticReviewResult> {
  const config = getConfig()

  const provider = options.provider ?? config.provider
  const model = options.model ?? config.model
  const variant = options.variant ?? config.variant

  logger.info(`Connecting to server at ${serverUrl}`)
  logger.info(`Using ${provider}/${model}${variant ? `:${variant}` : ''}`)

  const client = createOpencodeClient({
    baseUrl: serverUrl,
  })

  // Build the prompt
  const promptOptions: AgenticPromptOptions = {
    diffContent: options.diffContent,
    context: options.context,
    prMrInfo: options.prMrInfo,
    prDescriptionSummary: options.prDescriptionSummary,
    projectStructureContext: options.projectStructureContext,
  }
  const userPrompt = buildAgenticPrompt(promptOptions)

  // Note: When attaching to an existing server, MCP tools may need to be
  // registered separately. This is a simplified version that assumes
  // the server already has the tools available or we proceed without them.

  // Create session and send prompt
  const sessionResult = await client.session.create({
    body: { title: 'Agentic Code Review' },
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
      system: AGENTIC_SYSTEM_PROMPT,
      parts: [{ type: 'text', text: userPrompt }],
    },
  })

  if (!result.data) {
    throw new Error('Failed to get review response')
  }

  const content = result.data.parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

  return {
    content,
    toolCallCount: 0, // Can't track without MCP integration
    truncated: false,
  }
}
