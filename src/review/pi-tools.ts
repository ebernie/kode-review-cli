/**
 * Pi extension that registers kode-review's read-only tools with the agent
 * session. Used during agentic review.
 *
 * Per-tool dispatch:
 *   - When the indexer is reachable, indexer-backed handlers are registered.
 *   - When the indexer is NOT reachable, filesystem-backed handlers are
 *     registered for the five search/structural tools, and `get_call_graph`
 *     degrades to a stub that reports `available: false`.
 *   - The two git-backed tools (`get_commits`, `get_file_history`) are always
 *     registered.
 *
 * The handler shapes are identical across both branches, so the prompt and
 * the model do not need to care which is in use.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { IndexerClient } from '../indexer/client.js'
import { exec as runProcess } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import {
  readFileHandler,
  searchCodeIndexerHandler,
  searchCodeFsHandler,
  findDefinitionsIndexerHandler,
  findDefinitionsFsHandler,
  findUsagesIndexerHandler,
  findUsagesFsHandler,
  getCallGraphIndexerHandler,
  getCallGraphFsHandler,
  type GetCallGraphInput,
  getImpactIndexerHandler,
  getImpactFsHandler,
  getCommitsHandler,
  getFileHistoryHandler,
  isRipgrepAvailable,
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
  rgAvailable: boolean
  defaultBase: string
}

const READ_FILE_DESCRIPTION =
  'Read file content from the repository. Returns file contents with line numbers. ' +
  'Use for examining specific files mentioned in the diff or related to the changes.'

const SEARCH_CODE_DESCRIPTION =
  'Search for code by identifier or natural-language query. ' +
  'Uses semantic+keyword search when the indexer is available, ripgrep otherwise.'

const FIND_DEFINITIONS_DESCRIPTION =
  'Find where a symbol (class, function, variable, type) is defined in the repository.'

const FIND_USAGES_DESCRIPTION =
  'Find where a symbol is used (called, instantiated, referenced) across the repository.'

const GET_CALL_GRAPH_DESCRIPTION =
  'Get the call graph for a function — what it calls and what calls it. ' +
  'May return available:false when the indexer is not loaded.'

const GET_IMPACT_DESCRIPTION =
  'Analyse import dependencies for a file. Shows what files depend on the target. ' +
  'May return isPartial:true when running without the indexer (direct importers only).'

const GET_COMMITS_DESCRIPTION =
  'List commits in a ref range (default: merge-base..HEAD) with author, sha, and subject.'

const GET_FILE_HISTORY_DESCRIPTION =
  'List the most recent commits that touched a specific file.'

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
 * Resolve the default base ref for `get_commits`. Tries origin/HEAD, origin/main,
 * origin/master in order; falls back to `HEAD~20` so the tool still returns
 * something useful in shallow / detached-head CI checkouts.
 */
async function resolveDefaultBase(repoRoot: string): Promise<string> {
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const verify = await runProcess('git', ['rev-parse', '--verify', candidate], { cwd: repoRoot })
    if (verify.exitCode === 0) {
      const mb = await runProcess('git', ['merge-base', 'HEAD', candidate], { cwd: repoRoot })
      if (mb.exitCode === 0) return mb.stdout.trim()
    }
  }
  return 'HEAD~20'
}

/**
 * Build the kode-review extension factory.
 *
 * Pass the result via `DefaultResourceLoader.extensionFactories: [factory]`
 * when constructing the agent session.
 */
export function createKodeReviewToolsExtension(
  ctx: ToolContext,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI) => {
    // Resolve setup state defensively — a failure in any one probe must not
    // block the session. Each probe owns its own fallback rather than letting
    // a rejection propagate up Promise.all and abort the entire factory.
    const [gitignore, rgAvailable, defaultBase] = await Promise.all([
      loadGitignore(ctx.repoRoot).catch((err: unknown) => {
        logger.warn(`Failed to load .gitignore — continuing without it: ${(err as Error).message}`)
        return ignore()
      }),
      isRipgrepAvailable().catch(() => false),
      resolveDefaultBase(ctx.repoRoot).catch((err: unknown) => {
        logger.warn(`Could not resolve default git base — falling back to HEAD~20: ${(err as Error).message}`)
        return 'HEAD~20'
      }),
    ])

    const resolved: ResolvedToolContext = {
      ...ctx,
      gitignore,
      indexerClient: ctx.indexerUrl ? new IndexerClient(ctx.indexerUrl) : null,
      rgAvailable,
      defaultBase,
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

    const haveIndexer = resolved.indexerClient !== null
    const haveSearch = haveIndexer || resolved.rgAvailable

    if (haveIndexer) {
      logger.info('Agentic tools: indexer-backed (8 tools registered).')
    } else if (resolved.rgAvailable) {
      logger.info(
        'Agentic tools: ripgrep + git fallbacks (8 tools registered; ' +
          'get_call_graph/get_impact run in degraded mode without the indexer).',
      )
    } else {
      logger.warn(
        'Agentic mode: neither indexer nor ripgrep is available — ' +
          'only read_file, get_call_graph (degraded), get_commits, and get_file_history will be registered. ' +
          'Install ripgrep (`brew install ripgrep`) for code search fallbacks.',
      )
    }

    if (haveSearch) {
      pi.registerTool({
        name: 'search_code',
        label: 'Search code',
        description: SEARCH_CODE_DESCRIPTION,
        parameters: Type.Object({
          query: Type.String({ description: 'Natural-language query or code identifier' }),
          limit: Type.Optional(Type.Number({ description: 'Maximum results (default: 10, max: 20)' })),
        }),
        execute: async (_toolCallId, params) => {
          const result = resolved.indexerClient
            ? await searchCodeIndexerHandler(params, resolved.indexerClient, resolved.repoUrl, resolved.branch)
            : await searchCodeFsHandler(params, resolved.repoRoot)
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
          const result = resolved.indexerClient
            ? await findDefinitionsIndexerHandler(params, resolved.indexerClient, resolved.repoUrl, resolved.branch)
            : await findDefinitionsFsHandler(params, resolved.repoRoot)
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
          const result = resolved.indexerClient
            ? await findUsagesIndexerHandler(params, resolved.indexerClient, resolved.repoUrl, resolved.branch)
            : await findUsagesFsHandler(params, resolved.repoRoot)
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
          const result = resolved.indexerClient
            ? await getImpactIndexerHandler(params, resolved.indexerClient, resolved.repoUrl, resolved.branch)
            : await getImpactFsHandler(params, resolved.repoRoot)
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
        },
      })
    }

    // get_call_graph is always registered — fs path is a stub that signals
    // unavailability with stable schema.
    pi.registerTool({
      name: 'get_call_graph',
      label: 'Get call graph',
      description: GET_CALL_GRAPH_DESCRIPTION,
      parameters: Type.Object({
        functionName: Type.String({ description: 'Function name to analyse' }),
        depth: Type.Optional(Type.Number({ description: 'Graph traversal depth (default: 2)' })),
        direction: Type.Optional(
          Type.Union(
            [Type.Literal('callers'), Type.Literal('callees'), Type.Literal('both')],
            { description: 'callers | callees | both' },
          ),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const input: GetCallGraphInput = params as GetCallGraphInput
        const result = resolved.indexerClient
          ? await getCallGraphIndexerHandler(input, resolved.indexerClient, resolved.repoUrl, resolved.branch)
          : await getCallGraphFsHandler(input)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    // Always-on git tools.
    pi.registerTool({
      name: 'get_commits',
      label: 'Get commits',
      description: GET_COMMITS_DESCRIPTION,
      parameters: Type.Object({
        base: Type.Optional(Type.String({ description: 'Base ref (default: merge-base with origin/HEAD)' })),
        head: Type.Optional(Type.String({ description: 'Head ref (default: HEAD)' })),
        includeBody: Type.Optional(Type.Boolean({ description: 'Include full commit body (default: false)' })),
        limit: Type.Optional(Type.Number({ description: 'Maximum commits (default: 20, max: 100)' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await getCommitsHandler(params, resolved.repoRoot, resolved.defaultBase)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })

    pi.registerTool({
      name: 'get_file_history',
      label: 'Get file history',
      description: GET_FILE_HISTORY_DESCRIPTION,
      parameters: Type.Object({
        filePath: Type.String({ description: 'Path to the file (relative to repository root)' }),
        limit: Type.Optional(Type.Number({ description: 'Maximum commits (default: 10, max: 50)' })),
        includeBody: Type.Optional(Type.Boolean({ description: 'Include full commit body (default: false)' })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await getFileHistoryHandler(params, resolved.repoRoot)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: {} }
      },
    })
  }
}
