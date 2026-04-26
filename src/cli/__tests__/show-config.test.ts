import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(),
  getConfigPath: vi.fn(),
}))

import { showConfig } from '../show-config.js'
import { getConfig, getConfigPath } from '../../config/index.js'

const mockGetConfig = getConfig as ReturnType<typeof vi.fn>
const mockGetConfigPath = getConfigPath as ReturnType<typeof vi.fn>

const mockConfig = {
  github: { enabled: true, authenticated: true },
  gitlab: { enabled: false, authenticated: false },
  indexer: {
    enabled: true,
    composeProject: 'kode-review-indexer',
    apiPort: 8321,
    dbPort: 5436,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    chunkSize: 1000,
    chunkOverlap: 300,
    topK: 5,
    maxContextTokens: 4000,
    includedPatterns: ['**/*.ts', '**/*.js'],
    excludedPatterns: ['**/node_modules/**'],
    fileTypeStrategies: {},
  },
  updater: { lastCheckedAt: '', latestKnownVersion: '' },
  onboardingComplete: true,
}

describe('showConfig', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockGetConfig.mockReturnValue(mockConfig)
    mockGetConfigPath.mockReturnValue('/home/user/.config/kode-review/config.json')
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.clearAllMocks()
  })

  describe('JSON output', () => {
    it('outputs valid JSON when json option is true', () => {
      showConfig({ json: true })
      const output = String(consoleSpy.mock.calls[0][0])
      const parsed = JSON.parse(output) as Record<string, unknown>
      expect(parsed).toBeDefined()
      expect(parsed.configPath).toBe('/home/user/.config/kode-review/config.json')
      expect(parsed.github).toBeDefined()
      expect(parsed.gitlab).toBeDefined()
      expect(parsed.indexer).toBeDefined()
      expect(parsed.onboardingComplete).toBe(true)
    })

    it('does NOT include legacy provider/model/antigravity fields in JSON output', () => {
      showConfig({ json: true })
      const output = String(consoleSpy.mock.calls[0][0])
      const parsed = JSON.parse(output) as Record<string, unknown>
      expect(parsed.provider).toBeUndefined()
      expect(parsed.model).toBeUndefined()
      expect(parsed.variant).toBeUndefined()
      expect(parsed.antigravity).toBeUndefined()
    })
  })

  describe('human-readable output', () => {
    it('displays the config file path', () => {
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('/home/user/.config/kode-review/config.json')
    })

    it('points users at pi for model/auth instead of printing local provider/model', () => {
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('Model & Auth')
      expect(allOutput).toContain('pi')
      expect(allOutput).not.toContain('Antigravity Integration')
      expect(allOutput).not.toContain('Provider: ')
    })

    it('displays VCS integration status', () => {
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('VCS Integration')
      expect(allOutput).toContain('GitHub:')
      expect(allOutput).toContain('GitLab:')
    })

    it('displays indexer settings when enabled', () => {
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('Indexer Settings')
      expect(allOutput).toContain('API Port: 8321')
    })

    it('suggests setup when onboarding incomplete', () => {
      mockGetConfig.mockReturnValue({ ...mockConfig, onboardingComplete: false })
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('Suggestions')
      expect(allOutput).toContain('kode-review --setup')
    })

    it('suggests --setup-vcs when no VCS authenticated', () => {
      mockGetConfig.mockReturnValue({
        ...mockConfig,
        github: { enabled: false, authenticated: false },
        gitlab: { enabled: false, authenticated: false },
      })
      showConfig({ json: false })
      const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(allOutput).toContain('Suggestions')
      expect(allOutput).toContain('kode-review --setup-vcs')
    })
  })
})
