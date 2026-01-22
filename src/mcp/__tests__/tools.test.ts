import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  readFileHandler,
  searchCodeHandler,
  findDefinitionsHandler,
  findUsagesHandler,
  getCallGraphHandler,
  getImpactHandler,
  type ReadFileInput,
  type SearchCodeInput,
  type FindDefinitionsInput,
  type FindUsagesInput,
  type GetCallGraphInput,
  type GetImpactInput,
} from '../tools/index.js'
import type { IndexerClient } from '../../indexer/client.js'

// Mock IndexerClient for testing tool handlers that use it
type MockIndexerClient = {
  [K in keyof Pick<IndexerClient, 'hybridSearch' | 'lookupDefinitions' | 'lookupUsages' | 'getCallGraph' | 'getImportTree'>]: ReturnType<typeof vi.fn>
}

const createMockIndexerClient = (): MockIndexerClient => ({
  hybridSearch: vi.fn(),
  lookupDefinitions: vi.fn(),
  lookupUsages: vi.fn(),
  getCallGraph: vi.fn(),
  getImportTree: vi.fn(),
})

describe('MCP Tools', () => {
  describe('read_file tool', () => {
    let testDir: string

    beforeEach(async () => {
      // Create a temporary test directory
      testDir = join(tmpdir(), `mcp-test-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
    })

    afterEach(async () => {
      // Clean up test directory
      await rm(testDir, { recursive: true, force: true })
    })

    it('should read a file and return content with line numbers', async () => {
      // Create a test file
      const testFile = join(testDir, 'test.ts')
      const content = 'line 1\nline 2\nline 3\nline 4\nline 5'
      await writeFile(testFile, content)

      const input: ReadFileInput = { path: testFile }
      const result = await readFileHandler(input, testDir)

      expect(result.content).toContain('1: line 1')
      expect(result.content).toContain('2: line 2')
      expect(result.content).toContain('5: line 5')
      expect(result.totalLines).toBe(5)
      expect(result.truncated).toBe(false)
    })

    it('should handle relative paths correctly', async () => {
      // Create a nested test file
      const subdir = join(testDir, 'src')
      await mkdir(subdir)
      const testFile = join(subdir, 'file.ts')
      await writeFile(testFile, 'export const x = 1')

      const input: ReadFileInput = { path: 'src/file.ts' }
      const result = await readFileHandler(input, testDir)

      expect(result.content).toContain('export const x = 1')
      expect(result.path).toBe('src/file.ts')
    })

    it('should respect startLine parameter', async () => {
      const testFile = join(testDir, 'test.ts')
      const content = 'a\nb\nc\nd\ne'
      await writeFile(testFile, content)

      const input: ReadFileInput = { path: testFile, startLine: 3 }
      const result = await readFileHandler(input, testDir)

      expect(result.content).toContain('3: c')
      expect(result.content).toContain('4: d')
      expect(result.startLine).toBe(3)
    })

    it('should respect maxLines parameter', async () => {
      const testFile = join(testDir, 'test.ts')
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
      await writeFile(testFile, lines.join('\n'))

      const input: ReadFileInput = { path: testFile, maxLines: 10 }
      const result = await readFileHandler(input, testDir)

      expect(result.content.split('\n').length).toBe(10)
      expect(result.truncated).toBe(true)
      expect(result.endLine).toBe(10)
    })

    it('should prevent path traversal attacks with basic ../ pattern', async () => {
      const input: ReadFileInput = { path: '../../../etc/passwd' }

      await expect(readFileHandler(input, testDir)).rejects.toThrow(
        /path traversal detected/i
      )
    })

    it('should prevent absolute path attacks outside repo', async () => {
      const input: ReadFileInput = { path: '/etc/passwd' }

      await expect(readFileHandler(input, testDir)).rejects.toThrow(
        /path traversal detected/i
      )
    })

    it('should prevent double dot traversal in nested paths', async () => {
      // Create a valid subdirectory to make the traversal look legitimate
      const subdir = join(testDir, 'src')
      await mkdir(subdir)

      const input: ReadFileInput = { path: 'src/../../etc/passwd' }

      await expect(readFileHandler(input, testDir)).rejects.toThrow(
        /path traversal detected/i
      )
    })

    it('should prevent encoded path traversal', async () => {
      // Note: URL encoding may or may not be decoded by the path functions,
      // but we should handle both cases
      const input: ReadFileInput = { path: '..%2F..%2Fetc%2Fpasswd' }

      // Either it gets decoded and caught, or it fails as file not found
      await expect(readFileHandler(input, testDir)).rejects.toThrow()
    })

    it('should handle paths that start with repo prefix but escape', async () => {
      // e.g., if repo is /home/user/repo, a path like /home/user/repo-evil should fail
      const evilPath = testDir + '-evil/secret.txt'
      const input: ReadFileInput = { path: evilPath }

      await expect(readFileHandler(input, testDir)).rejects.toThrow(
        /path traversal detected/i
      )
    })

    it('should throw an error for non-existent files', async () => {
      const input: ReadFileInput = { path: 'nonexistent.ts' }

      await expect(readFileHandler(input, testDir)).rejects.toThrow()
    })

    it('should handle empty files gracefully', async () => {
      const testFile = join(testDir, 'empty.ts')
      await writeFile(testFile, '')

      const input: ReadFileInput = { path: testFile }
      const result = await readFileHandler(input, testDir)

      expect(result.totalLines).toBe(1) // Empty file has one empty line
      expect(result.truncated).toBe(false)
    })

    it('should handle startLine beyond file length', async () => {
      const testFile = join(testDir, 'short.ts')
      await writeFile(testFile, 'line1\nline2')

      const input: ReadFileInput = { path: testFile, startLine: 100 }
      const result = await readFileHandler(input, testDir)

      expect(result.content).toBe('')
      expect(result.startLine).toBe(100)
      expect(result.endLine).toBe(99) // endLine < startLine when no lines selected
    })

    describe('sensitive file protection', () => {
      it('should block access to .git directory', async () => {
        const gitDir = join(testDir, '.git')
        await mkdir(gitDir, { recursive: true })
        const gitConfig = join(gitDir, 'config')
        await writeFile(gitConfig, '[credential]\n  helper = store')

        const input: ReadFileInput = { path: '.git/config' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to nested .git paths', async () => {
        const gitDir = join(testDir, '.git', 'objects')
        await mkdir(gitDir, { recursive: true })
        const gitObject = join(gitDir, 'pack')
        await mkdir(gitObject)
        await writeFile(join(gitObject, 'test.pack'), 'binary data')

        const input: ReadFileInput = { path: '.git/objects/pack/test.pack' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to .env file', async () => {
        const envFile = join(testDir, '.env')
        await writeFile(envFile, 'SECRET_KEY=supersecret\nAPI_KEY=abc123')

        const input: ReadFileInput = { path: '.env' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to .env.local file', async () => {
        const envFile = join(testDir, '.env.local')
        await writeFile(envFile, 'LOCAL_SECRET=secret')

        const input: ReadFileInput = { path: '.env.local' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to .env.production file', async () => {
        const envFile = join(testDir, '.env.production')
        await writeFile(envFile, 'PROD_SECRET=secret')

        const input: ReadFileInput = { path: '.env.production' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should allow access to .env.example file', async () => {
        const envFile = join(testDir, '.env.example')
        await writeFile(envFile, 'SECRET_KEY=your_secret_here')

        const input: ReadFileInput = { path: '.env.example' }
        const result = await readFileHandler(input, testDir)
        expect(result.content).toContain('SECRET_KEY')
      })

      it('should block access to .npmrc file (npm tokens)', async () => {
        const npmrc = join(testDir, '.npmrc')
        await writeFile(npmrc, '//registry.npmjs.org/:_authToken=npm_token')

        const input: ReadFileInput = { path: '.npmrc' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to .env in subdirectories', async () => {
        const subDir = join(testDir, 'config')
        await mkdir(subDir)
        const envFile = join(subDir, '.env')
        await writeFile(envFile, 'NESTED_SECRET=secret')

        const input: ReadFileInput = { path: 'config/.env' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application.properties (Spring Boot)', async () => {
        const propsFile = join(testDir, 'src', 'main', 'resources', 'application.properties')
        await mkdir(join(testDir, 'src', 'main', 'resources'), { recursive: true })
        await writeFile(propsFile, 'spring.datasource.password=secret123')

        const input: ReadFileInput = { path: 'src/main/resources/application.properties' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application.yml (Spring Boot)', async () => {
        const ymlFile = join(testDir, 'application.yml')
        await writeFile(ymlFile, 'spring:\n  datasource:\n    password: secret')

        const input: ReadFileInput = { path: 'application.yml' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application.yaml (Spring Boot)', async () => {
        const yamlFile = join(testDir, 'application.yaml')
        await writeFile(yamlFile, 'spring:\n  datasource:\n    password: secret')

        const input: ReadFileInput = { path: 'application.yaml' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application-production.properties (Spring Boot profile)', async () => {
        const propsFile = join(testDir, 'application-production.properties')
        await writeFile(propsFile, 'spring.datasource.url=jdbc:mysql://prod-db:3306/app')

        const input: ReadFileInput = { path: 'application-production.properties' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application-prod.yml (Spring Boot profile)', async () => {
        const ymlFile = join(testDir, 'application-prod.yml')
        await writeFile(ymlFile, 'spring:\n  profiles: prod')

        const input: ReadFileInput = { path: 'application-prod.yml' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application-dev.yaml (Spring Boot profile)', async () => {
        const yamlFile = join(testDir, 'application-dev.yaml')
        await writeFile(yamlFile, 'spring:\n  profiles: dev')

        const input: ReadFileInput = { path: 'application-dev.yaml' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should block access to application-local-test.properties (compound profile)', async () => {
        const propsFile = join(testDir, 'application-local-test.properties')
        await writeFile(propsFile, 'test.secret=value')

        const input: ReadFileInput = { path: 'application-local-test.properties' }
        await expect(readFileHandler(input, testDir)).rejects.toThrow(/access denied.*sensitive/i)
      })

      it('should allow access to regular files', async () => {
        const regularFile = join(testDir, 'src', 'config.ts')
        await mkdir(join(testDir, 'src'))
        await writeFile(regularFile, 'export const config = { port: 3000 }')

        const input: ReadFileInput = { path: 'src/config.ts' }
        const result = await readFileHandler(input, testDir)
        expect(result.content).toContain('port: 3000')
      })

      it('should allow access to files with env in the name but not .env prefix', async () => {
        const envConfig = join(testDir, 'environment.ts')
        await writeFile(envConfig, 'export const env = process.env')

        const input: ReadFileInput = { path: 'environment.ts' }
        const result = await readFileHandler(input, testDir)
        expect(result.content).toContain('process.env')
      })
    })
  })

  describe('search_code tool', () => {
    it('should call hybridSearch with correct parameters', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.hybridSearch.mockResolvedValue({
        query: 'test query',
        quotedPhrases: [],
        matches: [
          {
            filePath: 'src/utils.ts',
            content: 'function test() {}',
            lineStart: 10,
            lineEnd: 12,
            chunkType: 'function',
            symbolNames: ['test'],
            vectorScore: 0.9,
            keywordScore: 0.8,
            rrfScore: 0.85,
            sources: ['vector', 'keyword'],
          },
        ],
        totalCount: 1,
        vectorWeight: 0.6,
        keywordWeight: 0.4,
        fallbackUsed: false,
      })

      const input: SearchCodeInput = { query: 'test query', limit: 5 }
      const result = await searchCodeHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      expect(mockClient.hybridSearch).toHaveBeenCalledWith(
        'test query',
        'https://github.com/test/repo',
        'main',
        5
      )
      expect(result.results).toHaveLength(1)
      expect(result.results[0].path).toBe('src/utils.ts')
      expect(result.results[0].score).toBe(0.85)
      expect(result.totalMatches).toBe(1)
    })

    it('should enforce maximum limit', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.hybridSearch.mockResolvedValue({
        query: 'test',
        quotedPhrases: [],
        matches: [],
        totalCount: 0,
        vectorWeight: 0.6,
        keywordWeight: 0.4,
        fallbackUsed: false,
      })

      const input: SearchCodeInput = { query: 'test', limit: 100 }
      await searchCodeHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo'
      )

      // Should cap at MAX_LIMIT (20)
      expect(mockClient.hybridSearch).toHaveBeenCalledWith(
        'test',
        'https://github.com/test/repo',
        undefined,
        20
      )
    })

    it('should propagate indexer network errors', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.hybridSearch.mockRejectedValue(
        new Error('Connection refused: indexer unreachable')
      )

      const input: SearchCodeInput = { query: 'test' }
      await expect(
        searchCodeHandler(
          input,
          mockClient as unknown as IndexerClient,
          'https://github.com/test/repo'
        )
      ).rejects.toThrow(/indexer unreachable/)
    })

    it('should handle empty search results', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.hybridSearch.mockResolvedValue({
        query: 'nonexistent',
        quotedPhrases: [],
        matches: [],
        totalCount: 0,
        vectorWeight: 0.6,
        keywordWeight: 0.4,
        fallbackUsed: false,
      })

      const input: SearchCodeInput = { query: 'nonexistent' }
      const result = await searchCodeHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo'
      )

      expect(result.results).toHaveLength(0)
      expect(result.totalMatches).toBe(0)
    })
  })

  describe('find_definitions tool', () => {
    it('should call lookupDefinitions with correct parameters', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.lookupDefinitions.mockResolvedValue({
        symbol: 'MyClass',
        definitions: [
          {
            filePath: 'src/models/my-class.ts',
            lineStart: 5,
            lineEnd: 50,
            content: 'export class MyClass { ... }',
            chunkType: 'class',
            isReexport: false,
            reexportSource: null,
          },
        ],
        totalCount: 1,
      })

      const input: FindDefinitionsInput = { symbol: 'MyClass', includeReexports: true }
      const result = await findDefinitionsHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      expect(mockClient.lookupDefinitions).toHaveBeenCalledWith(
        'MyClass',
        'https://github.com/test/repo',
        'main',
        true,
        10
      )
      expect(result.symbol).toBe('MyClass')
      expect(result.definitions).toHaveLength(1)
      expect(result.definitions[0].path).toBe('src/models/my-class.ts')
      expect(result.definitions[0].isReexport).toBe(false)
    })
  })

  describe('find_usages tool', () => {
    it('should call lookupUsages with correct parameters', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.lookupUsages.mockResolvedValue({
        symbol: 'fetchUser',
        usages: [
          {
            filePath: 'src/api/handlers.ts',
            lineStart: 20,
            lineEnd: 25,
            content: 'const user = await fetchUser(id)',
            chunkType: 'function',
            usageType: 'calls',
            isDynamic: false,
          },
          {
            filePath: 'src/services/user.ts',
            lineStart: 3,
            lineEnd: 3,
            content: "import { fetchUser } from '../api'",
            chunkType: null,
            usageType: 'imports',
            isDynamic: false,
          },
        ],
        totalCount: 2,
      })

      const input: FindUsagesInput = { symbol: 'fetchUser', limit: 10 }
      const result = await findUsagesHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo'
      )

      expect(mockClient.lookupUsages).toHaveBeenCalledWith(
        'fetchUser',
        'https://github.com/test/repo',
        undefined,
        10
      )
      expect(result.symbol).toBe('fetchUser')
      expect(result.usages).toHaveLength(2)
      expect(result.usages[0].usageType).toBe('calls')
      expect(result.usages[1].usageType).toBe('imports')
    })
  })

  describe('get_call_graph tool', () => {
    it('should call getCallGraph with correct parameters', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.getCallGraph.mockResolvedValue({
        function: 'processOrder',
        direction: 'both',
        depth: 2,
        nodes: [
          { id: '1', name: 'processOrder', filePath: 'src/orders.ts', lineStart: 10, lineEnd: 50, depth: 0 },
          { id: '2', name: 'validateOrder', filePath: 'src/validation.ts', lineStart: 5, lineEnd: 20, depth: 1 },
          { id: '3', name: 'handleOrder', filePath: 'src/handlers.ts', lineStart: 100, lineEnd: 120, depth: 1 },
        ],
        edges: [
          { sourceId: '3', targetId: '1', calleeName: 'processOrder' },
          { sourceId: '1', targetId: '2', calleeName: 'validateOrder' },
        ],
        totalNodes: 3,
        totalEdges: 2,
        callers: [
          { id: '3', name: 'handleOrder', filePath: 'src/handlers.ts', lineStart: 100, lineEnd: 120, depth: 1 },
        ],
        callees: [
          { id: '2', name: 'validateOrder', filePath: 'src/validation.ts', lineStart: 5, lineEnd: 20, depth: 1 },
        ],
      })

      const input: GetCallGraphInput = { functionName: 'processOrder', direction: 'both', depth: 2 }
      const result = await getCallGraphHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      expect(mockClient.getCallGraph).toHaveBeenCalledWith(
        'processOrder',
        'https://github.com/test/repo',
        'main',
        'both',
        2
      )
      expect(result.function).toBe('processOrder')
      expect(result.callers).toHaveLength(1)
      expect(result.callers[0].name).toBe('handleOrder')
      expect(result.callees).toHaveLength(1)
      expect(result.callees[0].name).toBe('validateOrder')
    })

    it('should enforce maximum depth', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.getCallGraph.mockResolvedValue({
        function: 'test',
        direction: 'both',
        depth: 3,
        nodes: [],
        edges: [],
        totalNodes: 0,
        totalEdges: 0,
        callers: [],
        callees: [],
      })

      const input: GetCallGraphInput = { functionName: 'test', depth: 10 }
      await getCallGraphHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo'
      )

      // Should cap at MAX_DEPTH (3)
      expect(mockClient.getCallGraph).toHaveBeenCalledWith(
        'test',
        'https://github.com/test/repo',
        undefined,
        'both',
        3
      )
    })
  })

  describe('get_impact tool', () => {
    it('should call getImportTree and calculate impact correctly', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.getImportTree.mockResolvedValue({
        targetFile: 'src/utils/helpers.ts',
        directImports: ['lodash', './constants'],
        directImporters: ['src/api/handlers.ts', 'src/services/user.ts'],
        indirectImports: ['lodash/fp'],
        indirectImporters: ['src/index.ts', 'src/app.ts', 'src/routes.ts'],
      })

      const input: GetImpactInput = { filePath: 'src/utils/helpers.ts' }
      const result = await getImpactHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      expect(mockClient.getImportTree).toHaveBeenCalledWith(
        'src/utils/helpers.ts',
        'https://github.com/test/repo',
        'main'
      )
      expect(result.targetFile).toBe('src/utils/helpers.ts')
      expect(result.directImporters).toHaveLength(2)
      expect(result.indirectImporters).toHaveLength(3)
      expect(result.totalDependents).toBe(5) // 2 direct + 3 indirect
      expect(result.isHighImpact).toBe(true) // >= 5 dependents
    })

    it('should mark low-impact files correctly', async () => {
      const mockClient = createMockIndexerClient()
      mockClient.getImportTree.mockResolvedValue({
        targetFile: 'src/utils/tiny.ts',
        directImports: [],
        directImporters: ['src/one.ts'],
        indirectImports: [],
        indirectImporters: ['src/two.ts'],
      })

      const input: GetImpactInput = { filePath: 'src/utils/tiny.ts' }
      const result = await getImpactHandler(
        input,
        mockClient as unknown as IndexerClient,
        'https://github.com/test/repo'
      )

      expect(result.totalDependents).toBe(2)
      expect(result.isHighImpact).toBe(false) // < 5 dependents
    })
  })
})
