/**
 * Pins the sensitive-path filter on the indexer-backed agent tools.
 *
 * The fs-backed variants get a real ripgrep-on-tmpdir test elsewhere
 * (search-code-fs.test.ts). The indexer-backed handlers route through a
 * client we can't run live in unit tests, so we feed each one a stubbed
 * client that returns rows for both a benign path and a sensitive one,
 * and assert the sensitive rows are dropped before the handler returns.
 *
 * Each handler is tested independently so a missing filter on any single
 * handler is caught individually — not masked by a pass on a sibling.
 */

import { describe, it, expect } from 'vitest'
import { searchCodeHandler } from '../search-code-indexer.js'
import { findDefinitionsHandler } from '../find-definitions-indexer.js'
import { findUsagesHandler } from '../find-usages-indexer.js'
import { getCallGraphHandler } from '../get-call-graph-indexer.js'
import { getImpactHandler } from '../get-impact-indexer.js'
import type { IndexerClient } from '../../../indexer/client.js'
import type {
  HybridSearchResult,
  HybridMatch,
  DefinitionLookupResult,
  DefinitionLocation,
  UsageLookupResult,
  UsageLocation,
  CallGraphResult,
  CallGraphNode,
  ImportTree,
} from '../../../indexer/types.js'

const benignMatch: HybridMatch = {
  filePath: 'src/app.ts',
  content: 'export const SECRET_TOKEN = readFromEnv()',
  lineStart: 1,
  lineEnd: 1,
  chunkType: null,
  symbolNames: ['SECRET_TOKEN'],
  vectorScore: 0.9,
  keywordScore: 0.9,
  rrfScore: 0.9,
  sources: ['vector', 'keyword'],
}

const sensitiveMatches: HybridMatch[] = [
  { ...benignMatch, filePath: '.env', content: 'SECRET_TOKEN=leaked-prod-value' },
  {
    ...benignMatch,
    filePath: 'config/application-prod.yml',
    content: 'secret_token: leaked-prod-yml-value',
  },
  { ...benignMatch, filePath: 'keys/server.pem', content: '-----BEGIN PRIVATE KEY-----' },
  { ...benignMatch, filePath: 'home/.ssh/id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----' },
  {
    ...benignMatch,
    filePath: 'auth/credentials.json',
    content: '{"private_key":"leaked-gcp"}',
  },
]

const benignDefinition: DefinitionLocation = {
  filePath: 'src/app.ts',
  lineStart: 10,
  lineEnd: 20,
  content: 'export function readSecret() { return process.env.SECRET_TOKEN }',
  chunkType: null,
  isReexport: false,
  reexportSource: null,
}

const sensitiveDefinitions: DefinitionLocation[] = [
  { ...benignDefinition, filePath: '.env', content: 'SECRET_TOKEN=leaked-env-defn' },
  {
    ...benignDefinition,
    filePath: 'config/application-prod.yml',
    content: 'secret_token: leaked-app-prod',
  },
]

const benignUsage: UsageLocation = {
  filePath: 'src/app.ts',
  lineStart: 30,
  lineEnd: 30,
  content: 'const token = readSecret()',
  chunkType: null,
  usageType: 'references',
  isDynamic: false,
}

const sensitiveUsages: UsageLocation[] = [
  { ...benignUsage, filePath: '.env', content: 'SECRET_TOKEN=leaked-env-usage' },
  {
    ...benignUsage,
    filePath: 'keys/server.pem',
    content: '-----BEGIN PRIVATE KEY-----leaked-pem',
  },
]

function makeHybridClient(matches: HybridMatch[]): IndexerClient {
  return {
    async hybridSearch(): Promise<HybridSearchResult> {
      return {
        query: 'SECRET_TOKEN',
        quotedPhrases: [],
        matches,
        totalCount: matches.length,
        vectorWeight: 0.5,
        keywordWeight: 0.5,
        fallbackUsed: false,
      }
    },
  } as unknown as IndexerClient
}

function makeDefinitionsClient(defs: DefinitionLocation[]): IndexerClient {
  return {
    async lookupDefinitions(): Promise<DefinitionLookupResult> {
      return { symbol: 'readSecret', definitions: defs, totalCount: defs.length }
    },
  } as unknown as IndexerClient
}

function makeUsagesClient(usages: UsageLocation[]): IndexerClient {
  return {
    async lookupUsages(): Promise<UsageLookupResult> {
      return { symbol: 'readSecret', usages, totalCount: usages.length }
    },
  } as unknown as IndexerClient
}

describe('searchCodeHandler (indexer-backed) — sensitive path filter', () => {
  it('drops sensitive paths from the indexer results', async () => {
    const client = makeHybridClient([benignMatch, ...sensitiveMatches])
    const out = await searchCodeHandler(
      { query: 'SECRET_TOKEN' },
      client,
      'https://example.com/r',
    )
    expect(out.results.map((r) => r.path)).toEqual(['src/app.ts'])
  })

  it('returns no sensitive content even if a sensitive path were mis-classified', async () => {
    const client = makeHybridClient([benignMatch, ...sensitiveMatches])
    const out = await searchCodeHandler(
      { query: 'SECRET_TOKEN' },
      client,
      'https://example.com/r',
    )
    for (const r of out.results) {
      expect(r.content).not.toMatch(/leaked-prod-value|leaked-prod-yml-value|BEGIN .* PRIVATE KEY|leaked-gcp/)
    }
  })

  it('totalMatches reflects the filtered count, not the raw response total', async () => {
    const client = makeHybridClient([benignMatch, ...sensitiveMatches])
    const out = await searchCodeHandler(
      { query: 'SECRET_TOKEN' },
      client,
      'https://example.com/r',
    )
    // 6 raw matches → 1 surviving the filter
    expect(out.totalMatches).toBe(1)
    expect(out.totalMatches).toBe(out.results.length)
  })

  it('returns an empty result set when every match is sensitive', async () => {
    const client = makeHybridClient(sensitiveMatches)
    const out = await searchCodeHandler(
      { query: 'SECRET_TOKEN' },
      client,
      'https://example.com/r',
    )
    expect(out.results).toEqual([])
    expect(out.totalMatches).toBe(0)
  })
})

describe('findDefinitionsHandler (indexer-backed) — sensitive path filter', () => {
  it('drops sensitive paths from definition lookups', async () => {
    const client = makeDefinitionsClient([benignDefinition, ...sensitiveDefinitions])
    const out = await findDefinitionsHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.definitions.map((d) => d.path)).toEqual(['src/app.ts'])
    expect(out.totalCount).toBe(1)
  })

  it('does not leak sensitive content in any returned definition', async () => {
    const client = makeDefinitionsClient([benignDefinition, ...sensitiveDefinitions])
    const out = await findDefinitionsHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    for (const d of out.definitions) {
      expect(d.content).not.toMatch(/leaked-env-defn|leaked-app-prod/)
    }
  })

  it('returns an empty result set with totalCount=0 when every definition is sensitive', async () => {
    // Pins that `totalCount` is re-derived from the post-filter set, not
    // copied from the client's raw response. A regression that keeps the
    // raw count would surface here as `totalCount: 2, definitions: []` —
    // which would mislead downstream callers about how many hits exist.
    const client = makeDefinitionsClient(sensitiveDefinitions)
    const out = await findDefinitionsHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.definitions).toEqual([])
    expect(out.totalCount).toBe(0)
  })
})

const benignCallerNode: CallGraphNode = {
  id: 'node-benign',
  name: 'callBenign',
  filePath: 'src/caller.ts',
  lineStart: 10,
  lineEnd: 12,
  depth: 1,
}
const sensitiveCallerNodes: CallGraphNode[] = [
  { ...benignCallerNode, id: 'node-env', name: 'callFromEnv', filePath: '.env' },
  { ...benignCallerNode, id: 'node-pem', name: 'callFromPem', filePath: 'keys/server.pem' },
  {
    ...benignCallerNode,
    id: 'node-app-prod',
    name: 'callFromAppProd',
    filePath: 'config/application-prod.yml',
  },
]

function makeCallGraphClient(
  callers: CallGraphNode[],
  callees: CallGraphNode[],
): IndexerClient {
  return {
    async getCallGraph(): Promise<CallGraphResult> {
      return {
        function: 'readSecret',
        direction: 'both',
        depth: 2,
        nodes: [...callers, ...callees],
        edges: [],
        totalNodes: callers.length + callees.length,
        totalEdges: 0,
        callers,
        callees,
      }
    },
  } as unknown as IndexerClient
}

function makeImportTreeClient(tree: ImportTree): IndexerClient {
  return {
    async getImportTree(): Promise<ImportTree> {
      return tree
    },
  } as unknown as IndexerClient
}

describe('getCallGraphHandler (indexer-backed) — sensitive path filter', () => {
  it('drops sensitive paths from callers and callees', async () => {
    const client = makeCallGraphClient(
      [benignCallerNode, ...sensitiveCallerNodes],
      [benignCallerNode, ...sensitiveCallerNodes],
    )
    const out = await getCallGraphHandler(
      { functionName: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.callers.map((n) => n.path)).toEqual(['src/caller.ts'])
    expect(out.callees.map((n) => n.path)).toEqual(['src/caller.ts'])
  })

  it('recomputes totalNodes from the filtered sets, not from the raw response', async () => {
    // Pre-fix the handler copied `result.totalNodes` straight from the
    // client. Now it must equal callers.length + callees.length, both of
    // which run through the filter.
    const client = makeCallGraphClient(
      [benignCallerNode, ...sensitiveCallerNodes],
      sensitiveCallerNodes,
    )
    const out = await getCallGraphHandler(
      { functionName: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.totalNodes).toBe(out.callers.length + out.callees.length)
    expect(out.totalNodes).toBe(1) // only benignCallerNode survives
  })

  it('returns empty caller and callee arrays when every node is sensitive', async () => {
    const client = makeCallGraphClient(sensitiveCallerNodes, sensitiveCallerNodes)
    const out = await getCallGraphHandler(
      { functionName: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.callers).toEqual([])
    expect(out.callees).toEqual([])
    expect(out.totalNodes).toBe(0)
  })
})

describe('getImpactHandler (indexer-backed) — sensitive path filter', () => {
  const benignFiles = ['src/app.ts', 'src/utils.ts']
  const sensitiveFiles = [
    '.env',
    'config/application-prod.yml',
    'keys/server.pem',
    'auth/credentials.json',
  ]

  it('drops sensitive paths from every dependency list', async () => {
    const client = makeImportTreeClient({
      targetFile: 'src/main.ts',
      directImports: [...benignFiles, ...sensitiveFiles],
      directImporters: [...benignFiles, ...sensitiveFiles],
      indirectImports: [...benignFiles, ...sensitiveFiles],
      indirectImporters: [...benignFiles, ...sensitiveFiles],
    })
    const out = await getImpactHandler(
      { filePath: 'src/main.ts' },
      client,
      'https://example.com/r',
    )
    expect(out.directImports).toEqual(benignFiles)
    expect(out.directImporters).toEqual(benignFiles)
    expect(out.indirectImports).toEqual(benignFiles)
    expect(out.indirectImporters).toEqual(benignFiles)
  })

  it('recomputes totalDependents and isHighImpact from the filtered importer lists', async () => {
    // Pre-fix the handler combined raw lengths. After filtering, the
    // dependents count must reflect only benign importers.
    const client = makeImportTreeClient({
      targetFile: 'src/main.ts',
      directImports: [],
      directImporters: [
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'src/d.ts',
        'src/e.ts',
        '.env',
      ],
      indirectImports: [],
      indirectImporters: [],
    })
    const out = await getImpactHandler(
      { filePath: 'src/main.ts' },
      client,
      'https://example.com/r',
    )
    // 5 benign importers (the threshold is >= 5) → isHighImpact should be true
    expect(out.directImporters).toHaveLength(5)
    expect(out.totalDependents).toBe(5)
    expect(out.isHighImpact).toBe(true)
    expect(out.directImporters).not.toContain('.env')
  })

  it('flips isHighImpact off when the filter drops dependents below the threshold', async () => {
    // 4 benign + 2 sensitive = 6 raw, but only 4 survive — must NOT be flagged
    // high-impact. This is the load-bearing case for moving the threshold
    // evaluation AFTER the filter.
    const client = makeImportTreeClient({
      targetFile: 'src/main.ts',
      directImports: [],
      directImporters: [
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'src/d.ts',
        '.env',
        'keys/server.pem',
      ],
      indirectImports: [],
      indirectImporters: [],
    })
    const out = await getImpactHandler(
      { filePath: 'src/main.ts' },
      client,
      'https://example.com/r',
    )
    expect(out.directImporters).toHaveLength(4)
    expect(out.totalDependents).toBe(4)
    expect(out.isHighImpact).toBe(false)
  })
})

describe('findUsagesHandler (indexer-backed) — sensitive path filter', () => {
  it('drops sensitive paths from usage lookups', async () => {
    const client = makeUsagesClient([benignUsage, ...sensitiveUsages])
    const out = await findUsagesHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.usages.map((u) => u.path)).toEqual(['src/app.ts'])
    expect(out.totalCount).toBe(1)
  })

  it('does not leak sensitive content in any returned usage', async () => {
    const client = makeUsagesClient([benignUsage, ...sensitiveUsages])
    const out = await findUsagesHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    for (const u of out.usages) {
      expect(u.content).not.toMatch(/leaked-env-usage|BEGIN .* PRIVATE KEY|leaked-pem/)
    }
  })

  it('returns an empty result set with totalCount=0 when every usage is sensitive', async () => {
    // Mirror of the findDefinitions all-sensitive test — pins that
    // totalCount is recomputed from the filtered list, not copied from
    // the client's response.
    const client = makeUsagesClient(sensitiveUsages)
    const out = await findUsagesHandler(
      { symbol: 'readSecret' },
      client,
      'https://example.com/r',
    )
    expect(out.usages).toEqual([])
    expect(out.totalCount).toBe(0)
  })
})
