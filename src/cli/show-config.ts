/**
 * Display current configuration
 *
 * Shows all configuration settings including:
 * - Config file path
 * - Provider settings
 * - Antigravity status
 * - VCS integration (GitHub/GitLab)
 * - Indexer settings
 * - Onboarding state
 */

import { getConfig, getConfigPath } from '../config/index.js'
import { green, red, yellow, cyan, dim, bold } from './colors.js'

export interface ShowConfigOptions {
  /** Output as JSON instead of human-readable format */
  json?: boolean
}

/**
 * Display the current configuration
 */
export function showConfig(options: ShowConfigOptions): void {
  const config = getConfig()
  const configPath = getConfigPath()

  if (options.json) {
    // JSON output
    console.log(JSON.stringify({
      configPath,
      ...config,
    }, null, 2))
    return
  }

  // Human-readable output
  console.log('')
  console.log(bold('kode-review Configuration'))
  console.log('=' .repeat(50))
  console.log('')

  // Config file location
  console.log(cyan('Config File'))
  console.log(`  Path: ${dim(configPath)}`)
  console.log('')

  // Provider settings
  console.log(cyan('Provider Settings'))
  console.log(`  Provider: ${config.provider}`)
  console.log(`  Model: ${config.model}`)
  if (config.variant) {
    console.log(`  Variant: ${config.variant}`)
  }
  console.log('')

  // Antigravity status
  console.log(cyan('Antigravity Integration'))
  console.log(`  Enabled: ${formatBoolean(config.antigravity.enabled)}`)
  console.log(`  Plugin Installed: ${formatBoolean(config.antigravity.pluginInstalled)}`)
  console.log(`  Authenticated: ${formatBoolean(config.antigravity.authenticated)}`)
  console.log('')

  // VCS integration
  console.log(cyan('VCS Integration'))
  console.log('  GitHub:')
  console.log(`    Enabled: ${formatBoolean(config.github.enabled)}`)
  console.log(`    Authenticated: ${formatBoolean(config.github.authenticated)}`)
  console.log('  GitLab:')
  console.log(`    Enabled: ${formatBoolean(config.gitlab.enabled)}`)
  console.log(`    Authenticated: ${formatBoolean(config.gitlab.authenticated)}`)
  console.log('')

  // Indexer settings
  console.log(cyan('Indexer Settings'))
  console.log(`  Enabled: ${formatBoolean(config.indexer.enabled)}`)
  if (config.indexer.enabled) {
    console.log(`  Compose Project: ${config.indexer.composeProject}`)
    console.log(`  API Port: ${config.indexer.apiPort}`)
    console.log(`  DB Port: ${config.indexer.dbPort}`)
    console.log(`  Embedding Model: ${config.indexer.embeddingModel}`)
    console.log(`  Chunk Size: ${config.indexer.chunkSize}`)
    console.log(`  Chunk Overlap: ${config.indexer.chunkOverlap}`)
    console.log(`  Top K: ${config.indexer.topK}`)
    console.log(`  Max Context Tokens: ${config.indexer.maxContextTokens}`)
    console.log(`  Included Patterns: ${config.indexer.includedPatterns.length} patterns`)
    console.log(`  Excluded Patterns: ${config.indexer.excludedPatterns.length} patterns`)
  }
  console.log('')

  // Onboarding state
  console.log(cyan('State'))
  console.log(`  Onboarding Complete: ${formatBoolean(config.onboardingComplete)}`)
  console.log('')

  // Summary
  console.log('=' .repeat(50))

  const issues: string[] = []

  if (!config.onboardingComplete) {
    issues.push('Onboarding not complete - run "kode-review --setup"')
  }
  if (!config.github.authenticated && !config.gitlab.authenticated) {
    issues.push('No VCS authenticated - run "kode-review --setup-vcs"')
  }

  if (issues.length > 0) {
    console.log('')
    console.log(yellow('Suggestions:'))
    for (const issue of issues) {
      console.log(`  ${yellow('!')} ${issue}`)
    }
  }

  console.log('')
}

/**
 * Format a boolean value with color
 */
function formatBoolean(value: boolean): string {
  return value ? green('Yes') : red('No')
}
