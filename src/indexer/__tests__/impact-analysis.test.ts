import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getImpactAnalysis } from '../impact-analysis.js'
import { formatImpactAsXml } from '../xml-context.js'
import type { IndexerClient } from '../client.js'
import type { ImportTree, HubFile, CircularDependency, ImpactAnalysisResult } from '../types.js'

describe('impact-analysis', () => {
  describe('getImpactAnalysis', () => {
    let mockClient: Partial<IndexerClient>

    beforeEach(() => {
      mockClient = {
        getImportTree: vi.fn(),
        getHubFiles: vi.fn(),
        getCircularDependencies: vi.fn(),
      }
    })

    afterEach(() => {
      vi.resetAllMocks()
    })

    it('returns empty result when no modified files are provided', async () => {
      // Set up mocks for empty file case
      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        [],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      expect(result.warnings).toHaveLength(0)
      expect(result.importTrees.size).toBe(0)
      expect(result.hubFiles).toHaveLength(0)
      expect(result.circularDependencies).toHaveLength(0)
    })

    it('identifies hub files that are being modified', async () => {
      const hubFiles: HubFile[] = [
        {
          filePath: 'src/utils/helpers.ts',
          importCount: 15,
          importers: ['src/api/client.ts', 'src/services/auth.ts'],
        },
      ]

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: 'src/utils/helpers.ts',
        directImports: [],
        directImporters: ['src/api/client.ts', 'src/services/auth.ts'],
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles,
        totalCount: 1,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/utils/helpers.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a hub file warning
      const hubWarning = result.warnings.find(w => w.type === 'hub_file')
      expect(hubWarning).toBeDefined()
      expect(hubWarning?.severity).toBe('high')
      expect(hubWarning?.filePath).toBe('src/utils/helpers.ts')
      expect(hubWarning?.details.importCount).toBe(15)
    })

    it('identifies critical hub files with 20+ importers', async () => {
      const hubFiles: HubFile[] = [
        {
          filePath: 'src/core/index.ts',
          importCount: 25,
          importers: Array(25).fill(0).map((_, i) => `src/module${i}.ts`),
        },
      ]

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: 'src/core/index.ts',
        directImports: [],
        directImporters: Array(25).fill(0).map((_, i) => `src/module${i}.ts`),
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles,
        totalCount: 1,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/core/index.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a critical severity warning
      const hubWarning = result.warnings.find(w => w.type === 'hub_file')
      expect(hubWarning).toBeDefined()
      expect(hubWarning?.severity).toBe('critical')
    })

    it('identifies direct circular dependencies with high severity', async () => {
      const circularDeps: CircularDependency[] = [
        {
          cycle: ['src/models/user.ts', 'src/services/auth.ts', 'src/models/user.ts'],
          cycleType: 'direct',
        },
      ]

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: 'src/models/user.ts',
        directImports: ['src/services/auth.ts'],
        directImporters: ['src/services/auth.ts'],
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: circularDeps,
        totalCount: 1,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/models/user.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a circular dependency warning with high severity for direct cycle
      const circularWarning = result.warnings.find(w => w.type === 'circular_dependency')
      expect(circularWarning).toBeDefined()
      expect(circularWarning?.severity).toBe('high') // Direct cycle = high
      expect(circularWarning?.details.cycle).toContain('src/models/user.ts')
    })

    it('identifies indirect circular dependencies with medium severity', async () => {
      const circularDeps: CircularDependency[] = [
        {
          cycle: ['src/models/user.ts', 'src/services/auth.ts', 'src/utils/helper.ts', 'src/models/user.ts'],
          cycleType: 'indirect',
        },
      ]

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: 'src/models/user.ts',
        directImports: [],
        directImporters: [],
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: circularDeps,
        totalCount: 1,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/models/user.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a circular dependency warning with medium severity for indirect cycle
      const circularWarning = result.warnings.find(w => w.type === 'circular_dependency')
      expect(circularWarning).toBeDefined()
      expect(circularWarning?.severity).toBe('medium') // Indirect cycle = medium
      expect(circularWarning?.message).toContain('indirect circular dependency')
    })

    it('generates medium-impact warnings for files with 5-9 direct importers', async () => {
      const importTree: ImportTree = {
        targetFile: 'src/utils/format.ts',
        directImports: [],
        directImporters: Array(8).fill(0).map((_, i) => `src/component${i}.ts`),
        indirectImports: [],
        indirectImporters: [],
      }

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue(importTree)

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/utils/format.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a high-impact warning for 8 direct importers
      const impactWarning = result.warnings.find(w => w.type === 'high_impact_change')
      expect(impactWarning).toBeDefined()
      expect(impactWarning?.severity).toBe('medium') // 5-9 importers = medium
      expect(impactWarning?.details.affectedFiles?.length).toBeGreaterThan(0)
    })

    it('generates high-impact warnings with high severity for 10+ direct importers', async () => {
      const importTree: ImportTree = {
        targetFile: 'src/core/base.ts',
        directImports: [],
        directImporters: Array(12).fill(0).map((_, i) => `src/module${i}.ts`),
        indirectImports: [],
        indirectImporters: [],
      }

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue(importTree)

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/core/base.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should have a high-impact warning with high severity for 12 importers
      const impactWarning = result.warnings.find(w => w.type === 'high_impact_change')
      expect(impactWarning).toBeDefined()
      expect(impactWarning?.severity).toBe('high') // 10+ importers = high
      // Affected files should be limited to first 10
      expect(impactWarning?.details.affectedFiles?.length).toBe(10)
    })

    it('handles import tree API errors gracefully and continues with other lookups', async () => {
      // Simulate import tree lookup failure but other lookups succeed
      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'))

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      // Should not throw
      const result = await getImpactAnalysis(
        ['src/utils/helpers.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should still return valid result
      expect(result.warnings).toBeDefined()
      expect(result.importTrees).toBeDefined()
    })

    it('handles multiple API failures gracefully', async () => {
      // Simulate all API calls failing
      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Import tree error'))
      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Hub files error'))
      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Circular deps error'))

      // Should not throw and return valid but empty result structure
      const result = await getImpactAnalysis(
        ['src/utils/helpers.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // Should return valid but empty result structure
      expect(result.warnings).toHaveLength(0)
      expect(result.importTrees.size).toBe(0)
      expect(result.hubFiles).toHaveLength(0)
      expect(result.circularDependencies).toHaveLength(0)
    })

    it('sorts warnings by severity (critical first)', async () => {
      const hubFiles: HubFile[] = [
        { filePath: 'src/critical.ts', importCount: 25, importers: [] },
        { filePath: 'src/high.ts', importCount: 15, importers: [] },
      ]

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: '',
        directImports: [],
        directImporters: [],
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles,
        totalCount: 2,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      const result = await getImpactAnalysis(
        ['src/high.ts', 'src/critical.ts'],
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      const hubWarnings = result.warnings.filter(w => w.type === 'hub_file')
      expect(hubWarnings.length).toBe(2)
      // Critical should come first
      expect(hubWarnings[0].severity).toBe('critical')
      expect(hubWarnings[1].severity).toBe('high')
    })

    it('limits import tree analysis to first 10 files', async () => {
      const manyFiles = Array(15).fill(0).map((_, i) => `src/file${i}.ts`)

      ;(mockClient.getImportTree as ReturnType<typeof vi.fn>).mockResolvedValue({
        targetFile: '',
        directImports: [],
        directImporters: [],
        indirectImports: [],
        indirectImporters: [],
      })

      ;(mockClient.getHubFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
        hubFiles: [],
        totalCount: 0,
        threshold: 10,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      ;(mockClient.getCircularDependencies as ReturnType<typeof vi.fn>).mockResolvedValue({
        circularDependencies: [],
        totalCount: 0,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main',
      })

      await getImpactAnalysis(
        manyFiles,
        mockClient as IndexerClient,
        'https://github.com/test/repo',
        'main'
      )

      // getImportTree should be called at most 10 times
      expect(mockClient.getImportTree).toHaveBeenCalledTimes(10)
    })
  })

  describe('formatImpactAsXml', () => {
    it('returns empty string when no warnings and no import trees', () => {
      const result: ImpactAnalysisResult = {
        warnings: [],
        importTrees: new Map(),
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)
      expect(xml).toBe('')
    })

    it('formats hub file warnings correctly', () => {
      const result: ImpactAnalysisResult = {
        warnings: [
          {
            type: 'hub_file',
            severity: 'high',
            filePath: 'src/utils/helpers.ts',
            message: 'This file is imported by 15 other files.',
            details: {
              importCount: 15,
              affectedFiles: ['src/api/client.ts', 'src/services/auth.ts'],
            },
          },
        ],
        importTrees: new Map(),
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      expect(xml).toContain('<impact>')
      expect(xml).toContain('</impact>')
      expect(xml).toContain('type="hub_file"')
      expect(xml).toContain('severity="high"')
      expect(xml).toContain('path="src/utils/helpers.ts"')
      expect(xml).toContain('<affected_files>')
      expect(xml).toContain('<file>src/api/client.ts</file>')
      expect(xml).toContain('<file>src/services/auth.ts</file>')
    })

    it('formats circular dependency warnings with cycle', () => {
      const result: ImpactAnalysisResult = {
        warnings: [
          {
            type: 'circular_dependency',
            severity: 'high',
            filePath: 'src/models/user.ts',
            message: 'This file is part of a direct circular dependency.',
            details: {
              cycle: ['src/models/user.ts', 'src/services/auth.ts', 'src/models/user.ts'],
            },
          },
        ],
        importTrees: new Map(),
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      expect(xml).toContain('type="circular_dependency"')
      expect(xml).toContain('<cycle>')
      expect(xml).toContain('src/models/user.ts → src/services/auth.ts → src/models/user.ts')
    })

    it('formats import trees correctly', () => {
      const importTrees = new Map<string, ImportTree>()
      importTrees.set('src/indexer/client.ts', {
        targetFile: 'src/indexer/client.ts',
        directImports: ['src/indexer/types.ts', 'src/utils/logger.ts'],
        directImporters: ['src/indexer/context.ts', 'src/indexer/pipeline.ts'],
        indirectImports: [],
        indirectImporters: [],
      })

      const result: ImpactAnalysisResult = {
        warnings: [],
        importTrees,
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      expect(xml).toContain('<import_tree file="src/indexer/client.ts">')
      expect(xml).toContain('<imports>src/indexer/types.ts, src/utils/logger.ts</imports>')
      expect(xml).toContain('<imported_by>src/indexer/context.ts, src/indexer/pipeline.ts</imported_by>')
    })

    it('escapes XML special characters in content', () => {
      const result: ImpactAnalysisResult = {
        warnings: [
          {
            type: 'hub_file',
            severity: 'high',
            filePath: 'src/utils/<helpers>.ts',
            message: 'Message with <special> & "characters"',
            details: {
              importCount: 10,
            },
          },
        ],
        importTrees: new Map(),
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      // Path attribute should be escaped
      expect(xml).toContain('path="src/utils/&lt;helpers&gt;.ts"')
      // Content should be escaped
      expect(xml).toContain('&lt;special&gt;')
      expect(xml).toContain('&amp;')
    })

    it('combines warnings and import trees in output', () => {
      const importTrees = new Map<string, ImportTree>()
      importTrees.set('src/api/client.ts', {
        targetFile: 'src/api/client.ts',
        directImports: ['src/types.ts'],
        directImporters: [],
        indirectImports: [],
        indirectImporters: [],
      })

      const result: ImpactAnalysisResult = {
        warnings: [
          {
            type: 'high_impact_change',
            severity: 'medium',
            filePath: 'src/api/client.ts',
            message: 'Changes affect 5 files.',
            details: {
              affectedFiles: ['file1.ts', 'file2.ts'],
            },
          },
        ],
        importTrees,
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      // Should contain both warning and import tree
      expect(xml).toContain('<warning')
      expect(xml).toContain('<import_tree')
    })

    it('skips import trees with no meaningful dependencies', () => {
      const importTrees = new Map<string, ImportTree>()
      importTrees.set('src/isolated.ts', {
        targetFile: 'src/isolated.ts',
        directImports: [],
        directImporters: [],
        indirectImports: [],
        indirectImporters: [],
      })

      const result: ImpactAnalysisResult = {
        warnings: [],
        importTrees,
        hubFiles: [],
        circularDependencies: [],
      }

      const xml = formatImpactAsXml(result)

      // Should not include import tree for isolated file
      expect(xml).toBe('')
    })
  })
})
