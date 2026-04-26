import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../../indexer/client.js', () => ({
  IndexerClient: vi.fn().mockImplementation((baseUrl: string) => ({
    baseUrl,
  })),
}))

import { createKodeReviewToolsExtension } from '../pi-tools.js'

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
  })

  it('always registers the read_file tool, even without an indexer URL', async () => {
    const pi = createFakePi()
    const factory = createKodeReviewToolsExtension({
      repoRoot: testRepoRoot,
      repoUrl: 'https://github.com/x/y',
    })
    await factory(pi as never)

    expect(pi.tools.map((t) => t.name)).toEqual(['read_file'])
  })

  it('registers all six tools when indexerUrl is provided', async () => {
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
      'get_impact',
      'read_file',
      'search_code',
    ])
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

  afterEach(async () => {
    await rm(testRepoRoot, { recursive: true, force: true })
  })
})

import { afterEach } from 'vitest'
