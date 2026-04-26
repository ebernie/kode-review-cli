import Conf from 'conf'
import { ConfigSchema, type Config, defaultConfig, isLegacyConfig, type LegacyConfigMarkers } from './schema.js'

const CONFIG_NAME = 'kode-review'

/**
 * Configuration store using Conf
 * Stores in ~/.config/kode-review/config.json (Linux/Mac)
 * or %APPDATA%\kode-review\Config\config.json (Windows)
 */
const store = new Conf<Config>({
  projectName: CONFIG_NAME,
  defaults: defaultConfig,
})

/**
 * Get the current configuration
 */
export function getConfig(): Config {
  const raw = store.store
  return ConfigSchema.parse(raw)
}

/**
 * Get the raw, unvalidated config object. Used by the migration flow to
 * detect pre-1.0 schemas without throwing on parse.
 */
export function getRawConfig(): unknown {
  return store.store
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
 * Update configuration (partial)
 */
export function updateConfig(updates: Partial<Config>): Config {
  const current = getConfig()
  const updated = { ...current, ...updates }
  store.set(updated)
  return ConfigSchema.parse(store.store)
}

/**
 * Set a specific config value
 */
export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  store.set(key, value)
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
  store.clear()
  store.set(defaultConfig)
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return store.path
}

export { store }
