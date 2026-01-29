import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Create module-level mocks
const mockGetConfig = vi.fn()
const mockGetConfigPath = vi.fn()

// Mock the config module before importing
vi.mock('../../config/index.js', () => ({
  getConfig: mockGetConfig,
  getConfigPath: mockGetConfigPath,
}))

// Import after mocks
import { showConfig } from '../show-config.js'

const mockConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  variant: 'max',
  antigravity: {
    enabled: true,
    pluginInstalled: true,
    authenticated: true,
  },
  github: {
    enabled: true,
    authenticated: true,
  },
  gitlab: {
    enabled: false,
    authenticated: false,
  },
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

      expect(consoleSpy).toHaveBeenCalledTimes(1)
      const output = String(consoleSpy.mock.calls[0][0])

      // Should be valid JSON
      const parsed = JSON.parse(output) as Record<string, unknown>
      expect(parsed).toBeDefined()
    })

    it('includes configPath in JSON output', () => {
      showConfig({ json: true })

      const output = String(consoleSpy.mock.calls[0][0])
      const parsed = JSON.parse(output) as Record<string, unknown>

      expect(parsed.configPath).toBe('/home/user/.config/kode-review/config.json')
    })

    it('includes all config fields in JSON output', () => {
      showConfig({ json: true })

      const output = String(consoleSpy.mock.calls[0][0])
      const parsed = JSON.parse(output) as Record<string, unknown>

      expect(parsed.provider).toBe('anthropic')
      expect(parsed.model).toBe('claude-sonnet-4-20250514')
      expect(parsed.antigravity).toBeDefined()
      expect(parsed.github).toBeDefined()
      expect(parsed.gitlab).toBeDefined()
      expect(parsed.indexer).toBeDefined()
      expect(parsed.onboardingComplete).toBe(true)
    })
  })

  describe('human-readable output', () => {
    it('displays header', () => {
      showConfig({ json: false })

      const calls = consoleSpy.mock.calls.map(c => String(c[0]))
      const hasHeader = calls.some(c => c.includes('Configuration'))
      expect(hasHeader).toBe(true)
    })

    it('displays config file path', () => {
      showConfig({ json: false })

      const calls = consoleSpy.mock.calls.map(c => String(c[0]))
      const hasPath = calls.some(c => c.includes('/home/user/.config/kode-review/config.json'))
      expect(hasPath).toBe(true)
    })

    it('displays provider settings', () => {
      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')

      expect(allOutput).toContain('Provider: anthropic')
      expect(allOutput).toContain('Model: claude-sonnet-4-20250514')
    })

    it('displays variant when present', () => {
      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('Variant: max')
    })

    it('displays antigravity status', () => {
      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('Antigravity Integration')
    })

    it('displays VCS integration status', () => {
      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('VCS Integration')
      expect(allOutput).toContain('GitHub:')
      expect(allOutput).toContain('GitLab:')
    })

    it('displays indexer settings when enabled', () => {
      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('Indexer Settings')
      expect(allOutput).toContain('API Port: 8321')
    })

    it('shows suggestions when onboarding not complete', () => {
      mockGetConfig.mockReturnValue({
        ...mockConfig,
        onboardingComplete: false,
      })

      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('Suggestions')
      expect(allOutput).toContain('kode-review --setup')
    })

    it('shows suggestions when no VCS authenticated', () => {
      mockGetConfig.mockReturnValue({
        ...mockConfig,
        github: { enabled: false, authenticated: false },
        gitlab: { enabled: false, authenticated: false },
      })

      showConfig({ json: false })

      const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(allOutput).toContain('Suggestions')
      expect(allOutput).toContain('kode-review --setup-vcs')
    })
  })
})
