/**
 * Pi extension that registers kode-review's read-only tools with the
 * agent session. Used during agentic review.
 *
 * The handlers themselves live in `src/review/tools/` and are unchanged
 * from the previous (MCP-based) implementation. This file exists solely
 * to translate them into the shape pi expects.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { IndexerClient } from '../indexer/client.js'
import {
  readFileHandler,
  searchCodeHandler,
  findDefinitionsHandler,
  findUsagesHandler,
  getCallGraphHandler,
  getImpactHandler,
} from './tools/index.js'

export interface ToolContext {
  repoRoot: string
  repoUrl: string
  indexerUrl?: string
  branch?: string
}

interface ResolvedToolContext extends ToolContext {
  gitignore: Ignore
  indexerClient: IndexerClient | null
}

const READ_FILE_DESCRIPTION =
  'Read file content from the repository. Returns file contents with line numbers. ' +
  'Use for examining specific files mentioned in the diff or related to the changes.'

const SEARCH_CODE_DESCRIPTION =
  'Search for code using hybrid semantic + keyword search. ' +
  'Use to find related code, implementations, patterns, or specific functionality.'

const FIND_DEFINITIONS_DESCRIPTION =
  'Find where a symbol (class, function, variable, type) is defined in the repository.'

const FIND_USAGES_DESCRIPTION =
  'Find where a symbol is used (called, instantiated, referenced) across the repository.'

const GET_CALL_GRAPH_DESCRIPTION =
  'Get the call graph for a function — what it calls and what calls it.'

const GET_IMPACT_DESCRIPTION =
  'Analyse import dependencies for a file. Shows what files depend on the target ' +
  '(importers) and what the target depends on (imports). Useful for blast-radius analysis.'

async function loadGitignore(repoRoot: string): Promise<Ignore> {
  const ig = ignore()
  try {
    const content = await readFile(join(repoRoot, '.gitignore'), 'utf-8')
    ig.add(content)
  } catch {
    // No .gitignore — all files are accessible (except sensitive patterns
    // hard-coded inside readFileHandler).
  }
  return ig
}

/**
 * Build the kode-review extension factory.
 *
 * Pass the result via `DefaultResourceLoader.extensionFactories: [factory]`
 * when constructing the agent session.
 */
export function createKodeReviewToolsExtension(
  ctx: ToolContext,
): (pi: ExtensionAPI) => void | Promise<void> {
  return async (pi: ExtensionAPI) => {
    const resolved: ResolvedToolContext = {
      ...ctx,
      gitignore: await loadGitignore(ctx.repoRoot),
      indexerClient: ctx.indexerUrl ? new IndexerClient(ctx.indexerUrl) : null,
    }

    // read_file is always available
    pi.registerTool({
      name: 'read_file',
      label: 'Read file',
      description: READ_FILE_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: 'Path to the file (relative to repository root or absolute)' }),
        startLine: Type.Optional(Type.Number({ description: 'Starting line number (1-based, default: 1)' })),
        maxLines: Type.Optional(Type.Number({ description: 'Maximum lines to return (default: 500, max: 1000)' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await readFileHandler(params, resolved.repoRoot, resolved.gitignore)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    // Indexer-dependent tools are only registered when the indexer is reachable.
    if (!resolved.indexerClient) return
    const client = resolved.indexerClient

    pi.registerTool({
      name: 'search_code',
      label: 'Search code',
      description: SEARCH_CODE_DESCRIPTION,
      parameters: Type.Object({
        query: Type.String({ description: 'Natural-language query or code identifier' }),
        limit: Type.Optional(Type.Number({ description: 'Maximum results (default: 10, max: 20)' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await searchCodeHandler(params, client, resolved.repoUrl, resolved.branch)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    pi.registerTool({
      name: 'find_definitions',
      label: 'Find definitions',
      description: FIND_DEFINITIONS_DESCRIPTION,
      parameters: Type.Object({
        symbol: Type.String({ description: 'Symbol name to look up (class, function, variable, type)' }),
        limit: Type.Optional(Type.Number({ description: 'Maximum results' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await findDefinitionsHandler(params, client, resolved.repoUrl, resolved.branch)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    pi.registerTool({
      name: 'find_usages',
      label: 'Find usages',
      description: FIND_USAGES_DESCRIPTION,
      parameters: Type.Object({
        symbol: Type.String({ description: 'Symbol name to look up' }),
        limit: Type.Optional(Type.Number({ description: 'Maximum results' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await findUsagesHandler(params, client, resolved.repoUrl, resolved.branch)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    pi.registerTool({
      name: 'get_call_graph',
      label: 'Get call graph',
      description: GET_CALL_GRAPH_DESCRIPTION,
      parameters: Type.Object({
        functionName: Type.String({ description: 'Function name to analyse' }),
        depth: Type.Optional(Type.Number({ description: 'Graph traversal depth (default: 2)' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await getCallGraphHandler(params, client, resolved.repoUrl, resolved.branch)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    pi.registerTool({
      name: 'get_impact',
      label: 'Get impact',
      description: GET_IMPACT_DESCRIPTION,
      parameters: Type.Object({
        filePath: Type.String({ description: 'Path to the file to analyse (relative to repository root)' }),
      }),
      execute: async (_toolCallId, params) => {
        const result = await getImpactHandler(params, client, resolved.repoUrl, resolved.branch)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })
  }
}
