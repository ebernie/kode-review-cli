#!/usr/bin/env node
/**
 * kode-review MCP Server
 *
 * Provides file reading and code indexer tools to AI agents via Model Context Protocol.
 * This server is designed to be spawned as a child process by the agentic review engine.
 *
 * Usage:
 *   node kode-review-mcp.js --repo /path/to/repo --indexer http://localhost:8080
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

import { IndexerClient } from '../indexer/client.js'
import {
  readFileHandler,
  readFileSchema,
  searchCodeHandler,
  searchCodeSchema,
  findDefinitionsHandler,
  findDefinitionsSchema,
  findUsagesHandler,
  findUsagesSchema,
  getCallGraphHandler,
  getCallGraphSchema,
  getImpactHandler,
  getImpactSchema,
  type ReadFileInput,
  type SearchCodeInput,
  type FindDefinitionsInput,
  type FindUsagesInput,
  type GetCallGraphInput,
  type GetImpactInput,
} from './tools/index.js'

// =============================================================================
// Configuration
// =============================================================================

interface ServerConfig {
  repoRoot: string
  indexerUrl?: string  // Optional - when not provided, only read_file tool is available
  repoUrl: string
  branch?: string
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2)
  const config: Partial<ServerConfig> = {}

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--repo':
        config.repoRoot = args[++i]
        break
      case '--indexer':
        config.indexerUrl = args[++i]
        break
      case '--repo-url':
        config.repoUrl = args[++i]
        break
      case '--branch':
        config.branch = args[++i]
        break
    }
  }

  if (!config.repoRoot) {
    throw new Error('--repo is required')
  }
  // indexerUrl is optional - if not provided, only read_file tool will be available
  if (!config.repoUrl) {
    throw new Error('--repo-url is required')
  }

  return config as ServerConfig
}

// =============================================================================
// MCP Server Implementation
// =============================================================================

async function main(): Promise<void> {
  const config = parseArgs()

  // Conditionally create IndexerClient only when indexer URL is provided
  const indexerClient = config.indexerUrl
    ? new IndexerClient(config.indexerUrl)
    : null

  if (!indexerClient) {
    console.error('Indexer URL not provided - only read_file tool will be available')
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'kode-review-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register list_tools handler
  // Dynamically register tools based on indexer availability
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [readFileSchema as Tool]

    // Only register indexer-dependent tools when indexer is available
    if (indexerClient) {
      tools.push(
        searchCodeSchema as Tool,
        findDefinitionsSchema as Tool,
        findUsagesSchema as Tool,
        getCallGraphSchema as Tool,
        getImpactSchema as Tool,
      )
    }

    return { tools }
  })

  // Register call_tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      switch (name) {
        case 'read_file': {
          const input = args as unknown as ReadFileInput
          const result = await readFileHandler(input, config.repoRoot)
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        case 'search_code': {
          if (!indexerClient) {
            return {
              content: [{ type: 'text', text: 'Error: Indexer not available. This tool requires the indexer to be running.' }],
              isError: true,
            }
          }
          const input = args as unknown as SearchCodeInput
          const result = await searchCodeHandler(
            input,
            indexerClient,
            config.repoUrl,
            config.branch
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        case 'find_definitions': {
          if (!indexerClient) {
            return {
              content: [{ type: 'text', text: 'Error: Indexer not available. This tool requires the indexer to be running.' }],
              isError: true,
            }
          }
          const input = args as unknown as FindDefinitionsInput
          const result = await findDefinitionsHandler(
            input,
            indexerClient,
            config.repoUrl,
            config.branch
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        case 'find_usages': {
          if (!indexerClient) {
            return {
              content: [{ type: 'text', text: 'Error: Indexer not available. This tool requires the indexer to be running.' }],
              isError: true,
            }
          }
          const input = args as unknown as FindUsagesInput
          const result = await findUsagesHandler(
            input,
            indexerClient,
            config.repoUrl,
            config.branch
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        case 'get_call_graph': {
          if (!indexerClient) {
            return {
              content: [{ type: 'text', text: 'Error: Indexer not available. This tool requires the indexer to be running.' }],
              isError: true,
            }
          }
          const input = args as unknown as GetCallGraphInput
          const result = await getCallGraphHandler(
            input,
            indexerClient,
            config.repoUrl,
            config.branch
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        case 'get_impact': {
          if (!indexerClient) {
            return {
              content: [{ type: 'text', text: 'Error: Indexer not available. This tool requires the indexer to be running.' }],
              isError: true,
            }
          }
          const input = args as unknown as GetImpactInput
          const result = await getImpactHandler(
            input,
            indexerClient,
            config.repoUrl,
            config.branch
          )
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  // Start server with stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log to stderr (stdout is for MCP protocol)
  console.error('kode-review MCP server started')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
