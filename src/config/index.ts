export {
  getConfig,
  getRawConfig,
  hasOldSchema,
  readLegacyComposeProject,
  updateConfig,
  updateIndexerConfig,
  updateUpdaterConfig,
  updateGithubConfig,
  updateGitlabConfig,
  setConfigValue,
  getConfigValue,
  isOnboardingComplete,
  setOnboardingComplete,
  resetConfig,
  getConfigPath,
} from './store.js'

export {
  ConfigSchema,
  IndexerConfigSchema,
  UpdaterConfigSchema,
  isLegacyConfig,
  type Config,
  type VcsConfig,
  type IndexerConfigType,
  type UpdaterConfig,
  type LegacyConfigMarkers,
} from './schema.js'
