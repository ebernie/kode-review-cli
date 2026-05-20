import Conf from 'conf'
import {
  ConfigSchema,
  type Config,
  defaultConfig,
  isLegacyConfig,
  type IndexerConfigType,
  type LegacyConfigMarkers,
  type UpdaterConfig,
  type VcsConfig,
} from './schema.js'

const CONFIG_NAME = 'kode-review'

/**
 * Configuration store using Conf
 * Stores in ~/.config/kode-review/config.json (Linux/Mac)
 * or %APPDATA%\kode-review\Config\config.json (Windows)
 *
 * Lazily initialized so that a corrupt config file (which causes `new Conf()`
 * to throw a SyntaxError on first access) is surfaced as a runtime error at
 * the call site rather than as an unrecoverable module-initialization crash.
 * This allows `--doctor` to catch the error and render a structured fail row.
 */
let _store: Conf<Config> | null = null

function getStore(): Conf<Config> {
  if (_store === null) {
    _store = new Conf<Config>({
      projectName: CONFIG_NAME,
      defaults: defaultConfig,
    })
  }
  return _store
}

/**
 * Get the current configuration
 */
export function getConfig(): Config {
  const raw = getStore().store
  return ConfigSchema.parse(raw)
}

/**
 * Get the raw, unvalidated config object. Used by the migration flow to
 * detect pre-1.0 schemas without throwing on parse.
 */
export function getRawConfig(): unknown {
  return getStore().store
}

/**
 * True when the config on disk is from a pre-1.0 (opencode era) install.
 * Used by the migration flow before any other CLI work runs.
 */
export function hasOldSchema(): boolean {
  return isLegacyConfig(getRawConfig())
}

/**
 * Read the legacy `indexer.composeProject` value before the migration flow
 * wipes the config. Returns the default if the legacy block was absent.
 */
export function readLegacyComposeProject(): string {
  const raw = getRawConfig()
  if (!isLegacyConfig(raw)) return 'kode-review-indexer'
  return (raw as LegacyConfigMarkers).indexer?.composeProject ?? 'kode-review-indexer'
}

/**
 * Update configuration with a top-level shallow merge. Prefer the
 * section-specific helpers below (`updateIndexerConfig`, `updateUpdaterConfig`,
 * `updateGithubConfig`, `updateGitlabConfig`) when changing a field inside a
 * nested section — they keep the merge knowledge inside the config module.
 *
 * Direct callers of this function are responsible for spreading nested
 * sections themselves, so a `updates.indexer = { enabled: true }` call would
 * replace the entire indexer block.
 */
export function updateConfig(updates: Partial<Config>): Config {
  const current = getConfig()
  const updated = { ...current, ...updates }
  const s = getStore()
  s.set(updated)
  return ConfigSchema.parse(s.store)
}

/**
 * Update a subset of fields inside `config.indexer`, preserving any other
 * fields in that section.
 */
export function updateIndexerConfig(updates: Partial<IndexerConfigType>): Config {
  const current = getConfig()
  return updateConfig({ indexer: { ...current.indexer, ...updates } })
}

/**
 * Update a subset of fields inside `config.updater`, preserving any other
 * fields in that section.
 */
export function updateUpdaterConfig(updates: Partial<UpdaterConfig>): Config {
  const current = getConfig()
  return updateConfig({ updater: { ...current.updater, ...updates } })
}

/**
 * Update a subset of fields inside `config.github`, preserving any other
 * fields in that section.
 */
export function updateGithubConfig(updates: Partial<VcsConfig>): Config {
  const current = getConfig()
  return updateConfig({ github: { ...current.github, ...updates } })
}

/**
 * Update a subset of fields inside `config.gitlab`, preserving any other
 * fields in that section.
 */
export function updateGitlabConfig(updates: Partial<VcsConfig>): Config {
  const current = getConfig()
  return updateConfig({ gitlab: { ...current.gitlab, ...updates } })
}

/**
 * Set a specific config value
 */
export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  getStore().set(key, value)
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
  return getConfig()[key]
}

/**
 * Check if onboarding has been completed
 */
export function isOnboardingComplete(): boolean {
  return getConfig().onboardingComplete
}

/**
 * Mark onboarding as complete
 */
export function setOnboardingComplete(complete: boolean = true): void {
  setConfigValue('onboardingComplete', complete)
}

/**
 * Reset configuration to defaults. Replaces every value, including
 * `onboardingComplete`, so the next CLI invocation will trigger the wizard.
 */
export function resetConfig(): void {
  const s = getStore()
  s.clear()
  s.set(defaultConfig)
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return getStore().path
}
