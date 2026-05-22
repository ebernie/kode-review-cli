export {
  AGENT_REGISTRY,
  getAgent,
  getBundledAssetsDir,
  isAgentName,
  listAgentNames,
  transformForCursor,
} from './registry.js'

export {
  parseAgentList,
  runAgentInstall,
} from './installer.js'

export type {
  AgentName,
  AgentRegistryEntry,
  InstallOptions,
  InstallTarget,
  TargetOutcome,
  TargetResult,
} from './types.js'
