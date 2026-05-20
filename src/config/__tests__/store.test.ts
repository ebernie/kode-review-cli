import { describe, it, expect, beforeEach, vi } from 'vitest'

// Back Conf with an in-memory object so each test gets isolated state without
// touching the user's real config dir. The mock implements the surface the
// store actually uses: `store` getter, `set` (object or key/value), `clear`,
// and `path`.
class InMemoryConf<T extends object> {
  private data: T
  public path = '/tmp/in-memory-conf/config.json'
  constructor(opts: { defaults: T }) {
    this.data = structuredClone(opts.defaults)
  }
  get store(): T {
    return this.data
  }
  set(arg: Partial<T> | string, value?: unknown): void {
    if (typeof arg === 'string') {
      ;(this.data as Record<string, unknown>)[arg] = value
    } else {
      this.data = { ...this.data, ...arg }
    }
  }
  clear(): void {
    this.data = {} as T
  }
}

vi.mock('conf', () => ({
  default: InMemoryConf,
}))

// Import AFTER the mock so the store module picks up the in-memory backing.
// vi.resetModules in beforeEach is required because the store module
// instantiates Conf at module load — without a reset, all tests share one
// store instance.
let store: typeof import('../store.js')

beforeEach(async () => {
  vi.resetModules()
  store = await import('../store.js')
  store.resetConfig()
})

describe('updateIndexerConfig', () => {
  it('changes a single field while preserving other indexer fields', () => {
    const before = store.getConfig().indexer
    expect(before.enabled).toBe(false)
    expect(before.composeProject).toBe('kode-review-indexer')
    expect(before.apiPort).toBe(8321)

    store.updateIndexerConfig({ enabled: true })

    const after = store.getConfig().indexer
    expect(after.enabled).toBe(true)
    // Sibling fields unchanged
    expect(after.composeProject).toBe(before.composeProject)
    expect(after.apiPort).toBe(before.apiPort)
    expect(after.dbPort).toBe(before.dbPort)
    expect(after.embeddingModel).toBe(before.embeddingModel)
    expect(after.chunkSize).toBe(before.chunkSize)
  })

  it('preserves the updater, github, and gitlab sections', () => {
    store.updateUpdaterConfig({ latestKnownVersion: '9.9.9' })
    store.updateGithubConfig({ authenticated: true })

    store.updateIndexerConfig({ enabled: true })

    const cfg = store.getConfig()
    expect(cfg.updater.latestKnownVersion).toBe('9.9.9')
    expect(cfg.github.authenticated).toBe(true)
    expect(cfg.indexer.enabled).toBe(true)
  })
})

describe('updateUpdaterConfig', () => {
  it('preserves latestKnownVersion when only lastCheckedAt is updated', () => {
    store.updateUpdaterConfig({
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      latestKnownVersion: '1.2.3',
    })

    // Simulate the throttled "record check time" path in checkForUpdateNotification.
    store.updateUpdaterConfig({ lastCheckedAt: '2026-01-02T00:00:00.000Z' })

    const updater = store.getConfig().updater
    expect(updater.lastCheckedAt).toBe('2026-01-02T00:00:00.000Z')
    // The whole point of the helper: this field is NOT clobbered.
    expect(updater.latestKnownVersion).toBe('1.2.3')
  })
})

describe('updateGithubConfig / updateGitlabConfig', () => {
  it('updateGithubConfig changes one VCS field without affecting gitlab', () => {
    store.updateGitlabConfig({ enabled: true, authenticated: true })

    store.updateGithubConfig({ enabled: true })

    const cfg = store.getConfig()
    expect(cfg.github.enabled).toBe(true)
    expect(cfg.github.authenticated).toBe(false)
    expect(cfg.gitlab.enabled).toBe(true)
    expect(cfg.gitlab.authenticated).toBe(true)
  })

  it('updateGitlabConfig is symmetric with github', () => {
    store.updateGithubConfig({ enabled: true, authenticated: true })

    store.updateGitlabConfig({ authenticated: true })

    const cfg = store.getConfig()
    expect(cfg.gitlab.enabled).toBe(false)
    expect(cfg.gitlab.authenticated).toBe(true)
    expect(cfg.github.enabled).toBe(true)
    expect(cfg.github.authenticated).toBe(true)
  })
})

describe('shallow updateConfig (regression — documents why helpers exist)', () => {
  it('clobbers sibling fields in the same nested section when called directly', () => {
    // Use an explicit sentinel rather than relying on the Zod default for
    // latestKnownVersion. If updateConfig is ever fixed to deep-merge, we
    // want THIS sentinel to survive — not coincidentally match a default.
    store.updateUpdaterConfig({
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      latestKnownVersion: 'sentinel-v9.9.9',
    })

    expect(store.getConfig().updater.latestKnownVersion).toBe('sentinel-v9.9.9')

    // Misuse of the shallow API: passing a partial updater overwrites the
    // whole `updater` object, so latestKnownVersion is lost.
    store.updateConfig({ updater: { lastCheckedAt: '2026-01-02T00:00:00.000Z' } as never })

    const updater = store.getConfig().updater
    expect(updater.lastCheckedAt).toBe('2026-01-02T00:00:00.000Z')
    // The helper would have preserved 'sentinel-v9.9.9'; direct updateConfig
    // dropped it back to the schema default ('').
    expect(updater.latestKnownVersion).toBe('')
    expect(updater.latestKnownVersion).not.toBe('sentinel-v9.9.9')
  })
})

describe('helper composition', () => {
  it('returns the parsed/validated full Config (not just the partial update)', () => {
    const result = store.updateIndexerConfig({ enabled: true })
    expect(result.indexer.enabled).toBe(true)
    // Untouched sections are present with their schema defaults — proving
    // ConfigSchema.parse ran and applied defaults, not just that keys exist.
    expect(result.github).toEqual({ enabled: false, authenticated: false })
    expect(result.gitlab).toEqual({ enabled: false, authenticated: false })
    expect(result.updater.lastCheckedAt).toBe('')
    expect(result.updater.latestKnownVersion).toBe('')
    expect(result.onboardingComplete).toBe(false)
  })
})
