import Conf from 'conf'
import { ConfigSchema, type Config, defaultConfig } from './schema.js'

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
 * Reset configuration to defaults
 */
export function resetConfig(): void {
  store.clear()
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return store.path
}

export { store }
