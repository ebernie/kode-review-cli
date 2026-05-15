import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// IndexerClient mock — each test can swap in its own behaviour by reassigning
// `mockClientImpl` before constructing the extension.
let mockClientImpl: Record<string, ReturnType<typeof vi.fn>> = {}

vi.mock('../../indexer/client.js', () => ({
  IndexerClient: vi.fn().mockImplementation((baseUrl: string) => ({
    baseUrl,
    ...mockClientImpl,
  })),
}))

// Ripgrep availability + search are mocked so registration tests don't depend
// on whether the host machine has rg installed. Tests that exercise the actual
// fs handlers against a real binary live in src/review/tools/__tests__ and skip
// when rg is genuinely missing.
let mockRgMatches: Array<{ path: string; line: number; text: string; matchText: string; column: number }> = []

vi.mock('../tools/ripgrep.js', async () => {
  const actual = await vi.importActual<typeof import('../tools/ripgrep.js')>('../tools/ripgrep.js')
  return {
    ...actual,
    isRipgrepAvailable: vi.fn(async () => true),
    ripgrepSearch: vi.fn(async () => mockRgMatches),
  }
})

import { createKodeReviewToolsExtension } from '../pi-tools.js'
import { isRipgrepAvailable } from '../tools/ripgrep.js'

const mockRgAvailable = isRipgrepAvailable as unknown as ReturnType<typeof vi.fn>

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (...args: unknown[]) => Promise<unknown>
}

interface FakePi {
  tools: RegisteredTool[]
  on: ReturnType<typeof vi.fn>
  registerTool: (tool: RegisteredTool) => void
  registerCommand: ReturnType<typeof vi.fn>
}

function createFakePi(): FakePi {
  const tools: RegisteredTool[] = []
  return {
    tools,
    on: vi.fn(),
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool)
    },
    registerCommand: vi.fn(),
  }
}

describe('createKodeReviewToolsExtension', () => {
  let testRepoRoot: string

  beforeEach(async () => {
    testRepoRoot = join(tmpdir(), `kode-review-pi-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testRepoRoot, { recursive: true })
    await writeFile(join(testRepoRoot, '.gitignore'), 'node_modules\ndist\n')
    mockClientImpl = {}
    mockRgAvailable.mockResolvedValue(true)
    mockRgMatches = []
  })

  it('always registers the 4 always-on tools (no indexer, no rg)', async () => {
    mockRgAvailable.mockResolvedValue(false)
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    expect(pi.tools.map((t) => t.name).sort()).toEqual([
      'get_call_graph',
      'get_commits',
      'get_file_history',
      'read_file',
    ])
  })

  it('registers all 8 tools when indexerUrl is provided', async () => {
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
      indexerUrl: 'http://localhost:8321',
      branch: 'main',
    })
    await factory(pi as never)

    expect(pi.tools.map((t) => t.name).sort()).toEqual([
      'find_definitions',
      'find_usages',
      'get_call_graph',
      'get_commits',
      'get_file_history',
      'get_impact',
      'read_file',
      'search_code',
    ])
  })

  it('registers all 8 tools when indexer is absent but rg is present (fs path)', async () => {
    mockRgAvailable.mockResolvedValue(true)
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    expect(pi.tools.map((t) => t.name).sort()).toEqual([
      'find_definitions',
      'find_usages',
      'get_call_graph',
      'get_commits',
      'get_file_history',
      'get_impact',
      'read_file',
      'search_code',
    ])
  })

  it('fs-path search_code execute() routes to the fs handler (matchTypes=["lexical"])', async () => {
    // Concrete behavioural assertion that the dispatch ternary is wired correctly:
    // when indexerUrl is absent, executing search_code must produce the fs-handler
    // output shape (matchTypes=['lexical']) — not the indexer one.
    mockRgAvailable.mockResolvedValue(true)
    mockRgMatches = [
      { path: 'sample.ts', line: 1, text: 'export const fsPathMarker = 1', matchText: 'fsPathMarker', column: 14 },
    ]
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)
    const searchCode = pi.tools.find((t) => t.name === 'search_code')!
    const result = (await searchCode.execute('id-1', { query: 'fsPathMarker' })) as {
      content: { type: string; text: string }[]
    }
    const parsed = JSON.parse(result.content[0].text) as {
      results: Array<{ matchTypes: string[]; path: string }>
      query: string
    }
    expect(parsed.query).toBe('fsPathMarker')
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].matchTypes).toEqual(['lexical'])
    expect(parsed.results[0].path).toBe('sample.ts')
  })

  it('get_call_graph stub execute() returns available:false when indexer is absent', async () => {
    mockRgAvailable.mockResolvedValue(false)
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)
    const callGraph = pi.tools.find((t) => t.name === 'get_call_graph')!
    const result = (await callGraph.execute('id-1', { functionName: 'foo' })) as {
      content: { type: string; text: string }[]
    }
    const parsed = JSON.parse(result.content[0].text) as {
      available: boolean
      reason: string
      callers: unknown[]
      callees: unknown[]
    }
    expect(parsed.available).toBe(false)
    expect(parsed.reason).toMatch(/indexer/i)
    expect(parsed.callers).toEqual([])
    expect(parsed.callees).toEqual([])
  })

  it('logs a warning when neither indexer nor rg is available', async () => {
    mockRgAvailable.mockResolvedValue(false)
    const { logger } = await import('../../utils/logger.js')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const pi = createFakePi()
      const factory = createKodeReviewToolsExtension({
        repoRoot: testRepoRoot,
        repoUrl: 'https://github.com/x/y',
      })
      await factory(pi as never)
      expect(warnSpy).toHaveBeenCalled()
      const message = warnSpy.mock.calls[0][0]
      expect(message).toMatch(/ripgrep/i)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('every registered tool has a non-empty description and a TypeBox parameters schema', async () => {
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
      indexerUrl: 'http://localhost:8321',
    })
    await factory(pi as never)

    for (const tool of pi.tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.label.length).toBeGreaterThan(0)
      // TypeBox object schemas expose `type: 'object'` and a `properties` map.
      const params = tool.parameters as { type?: string; properties?: Record<string, unknown> }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
  })

  it('read_file tool reads a file relative to the repo root through the handler', async () => {
    await writeFile(join(testRepoRoot, 'sample.ts'), 'const a = 1\nconst b = 2\n')
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    const readFile = pi.tools.find((t) => t.name === 'read_file')!
    const result = (await readFile.execute('id-1', { path: 'sample.ts' })) as {
      content: { type: string; text: string }[]
    }

    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('const a = 1')
    expect(result.content[0].text).toContain('const b = 2')
  })

  it('read_file refuses path traversal attempts', async () => {
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    const readFile = pi.tools.find((t) => t.name === 'read_file')!
    await expect(readFile.execute('id-1', { path: '../../etc/passwd' }))
      .rejects.toThrow(/Path traversal/)
  })

  it('read_file refuses absolute paths that resolve outside the repo root', async () => {
    // /etc/passwd is the canonical "host file" — it must never be readable
    // through this tool, even when given as an absolute path (the obvious
    // bypass for anyone who's heard of `..`-stripping).
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    const readFile = pi.tools.find((t) => t.name === 'read_file')!
    await expect(readFile.execute('id-1', { path: '/etc/passwd' }))
      .rejects.toThrow(/Path traversal/)
  })

  it('read_file refuses symlinks whose target resolves outside the repo root', async () => {
    // Defence in depth: even if the agent can drop a symlink inside repoRoot
    // pointing to /etc/passwd, the realpath() check must still refuse it.
    // Skip on platforms where the test process can't create symlinks (rare on
    // POSIX, common on locked-down Windows CI — we don't ship to Windows but
    // guard anyway so the suite never silently passes).
    const targetOutside = '/etc/passwd'
    const linkPath = join(testRepoRoot, 'sneaky-link.txt')
    try {
      await symlink(targetOutside, linkPath)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT') {
        // Cannot create the symlink (permission, or /etc/passwd missing) —
        // the platform-level guarantee we'd be testing isn't reachable.
        return
      }
      throw e
    }

    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    const readFile = pi.tools.find((t) => t.name === 'read_file')!
    await expect(readFile.execute('id-1', { path: 'sneaky-link.txt' }))
      .rejects.toThrow(/Path traversal/)
  })

  it('search_code execute() forwards through to IndexerClient.hybridSearch and JSON-stringifies the result', async () => {
    mockClientImpl.hybridSearch = vi.fn().mockResolvedValue({
      matches: [
        {
          filePath: 'src/auth.ts',
          lineStart: 10,
          lineEnd: 25,
          content: 'function login() { ... }',
          rrfScore: 0.91,
          sources: ['vector', 'bm25'],
        },
      ],
      totalCount: 1,
    })

    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
      indexerUrl: 'http://localhost:8321',
      branch: 'main',
    })
    await factory(pi as never)

    const searchCode = pi.tools.find((t) => t.name === 'search_code')!
    const result = (await searchCode.execute('id-1', { query: 'login' })) as {
      content: { type: string; text: string }[]
      details: Record<string, unknown>
    }

    expect(mockClientImpl.hybridSearch).toHaveBeenCalledWith('login', 'https://github.com/x/y', 'main', 10)
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text) as { results: unknown[]; query: string; totalMatches: number }
    expect(parsed.query).toBe('login')
    expect(parsed.totalMatches).toBe(1)
    expect((parsed.results as Array<{ path: string }>)[0].path).toBe('src/auth.ts')
  })

  it('propagates errors from indexer-backed tool handlers (does not swallow rejections)', async () => {
    mockClientImpl.hybridSearch = vi.fn().mockRejectedValue(new Error('Connection refused'))

    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
      indexerUrl: 'http://localhost:8321',
    })
    await factory(pi as never)

    const searchCode = pi.tools.find((t) => t.name === 'search_code')!
    await expect(searchCode.execute('id-1', { query: 'anything' })).rejects.toThrow(/Connection refused/)
  })

  afterEach(async () => {
    await rm(testRepoRoot, { recursive: true, force: true })
  })
})
