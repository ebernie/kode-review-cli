import { select, confirm, input } from '@inquirer/prompts'
import ora from 'ora'
import { exec, execInteractive, commandExists } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import { updateConfig } from '../config/index.js'
import { ANTIGRAVITY_MODELS } from '../config/schema.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

const PLUGIN_NAME = 'opencode-antigravity-auth@beta'

/**
 * Get the OpenCode config directory path (platform-aware)
 * - Windows: %APPDATA%\opencode
 * - macOS/Linux: ~/.config/opencode (respects XDG_CONFIG_HOME)
 */
function getOpenCodeConfigDir(): string {
  const home = homedir()

  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'opencode')
  }

  // macOS and Linux: use XDG_CONFIG_HOME or default to ~/.config
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
}

/**
 * Check if Antigravity plugin is installed
 */
export async function isAntigravityInstalled(): Promise<boolean> {
  // Check if plugin is in OpenCode config
  const configPath = join(getOpenCodeConfigDir(), 'opencode.json')

  if (!existsSync(configPath)) {
    return false
  }

  try {
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content)

    if (Array.isArray(config.plugin)) {
      return config.plugin.some((p: string) => p.includes('opencode-antigravity-auth'))
    }

    return false
  } catch {
    return false
  }
}

/**
 * Check if Antigravity is authenticated
 */
export async function isAntigravityAuthenticated(): Promise<boolean> {
  const accountsPath = join(getOpenCodeConfigDir(), 'antigravity-accounts.json')
  return existsSync(accountsPath)
}

/**
 * Install the Antigravity plugin
 */
export async function installAntigravityPlugin(): Promise<boolean> {
  const spinner = ora('Installing Antigravity plugin...').start()

  try {
    // Ensure opencode config directory exists
    const configDir = getOpenCodeConfigDir()
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true })
    }

    // Read or create OpenCode config
    const configPath = join(configDir, 'opencode.json')
    let config: Record<string, unknown> = {}

    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8')
      config = JSON.parse(content)
    }

    // Add plugin if not already present
    if (!Array.isArray(config.plugin)) {
      config.plugin = []
    }

    if (!config.plugin.includes(PLUGIN_NAME)) {
      config.plugin.push(PLUGIN_NAME)
    }

    // Add model definitions under google provider
    if (!config.provider) {
      config.provider = {}
    }

    const provider = config.provider as Record<string, unknown>
    if (!provider.google) {
      provider.google = {}
    }

    const google = provider.google as Record<string, unknown>
    if (!google.models) {
      google.models = {}
    }

    const models = google.models as Record<string, unknown>

    // Add Antigravity models
    for (const [modelId, modelDef] of Object.entries(ANTIGRAVITY_MODELS)) {
      if (!models[modelId]) {
        models[modelId] = modelDef
      }
    }

    // Write updated config
    await writeFile(configPath, JSON.stringify(config, null, 2))

    spinner.succeed('Antigravity plugin configured')
    return true
  } catch (error) {
    spinner.fail('Failed to configure Antigravity plugin')
    logger.error(String(error))
    return false
  }
}

/**
 * Run Antigravity OAuth authentication
 */
export async function authenticateAntigravity(): Promise<boolean> {
  // Check if OpenCode is available
  const hasOpencode = await commandExists('opencode')

  if (!hasOpencode) {
    logger.error('OpenCode is not installed. Please install it first:')
    logger.info('  npm install -g opencode-ai')
    logger.info('  # or')
    logger.info('  curl -fsSL https://opencode.ai/install | bash')
    return false
  }

  logger.info('Opening browser for Google OAuth authentication...')
  logger.info('Please sign in with your Google account.')

  // Run opencode auth login interactively
  const exitCode = await execInteractive('opencode', ['auth', 'login'])

  if (exitCode !== 0) {
    logger.error('Authentication failed or was cancelled')
    return false
  }

  // Verify authentication
  if (await isAntigravityAuthenticated()) {
    logger.success('Successfully authenticated with Antigravity')
    return true
  }

  logger.warn('Authentication may not have completed. Please try again.')
  return false
}

/**
 * Get available Antigravity models for selection
 */
export function getAntigravityModelChoices(): { name: string; value: string }[] {
  return Object.entries(ANTIGRAVITY_MODELS).map(([id, def]) => ({
    name: def.name,
    value: id,
  }))
}

/**
 * Get variant choices for a model
 */
export function getVariantChoices(modelId: string): { name: string; value: string }[] | null {
  const model = ANTIGRAVITY_MODELS[modelId]

  if (!model || !model.variants) {
    return null
  }

  return Object.keys(model.variants).map((v) => ({
    name: v,
    value: v,
  }))
}

/**
 * Run Antigravity setup flow
 */
export async function setupAntigravity(): Promise<boolean> {
  console.log('')
  console.log('Antigravity provides free access to premium models via Google OAuth:')
  console.log('  - Claude Sonnet 4.5 / Opus 4.5 (with thinking)')
  console.log('  - Gemini 3 Pro / Flash')
  console.log('')

  const proceed = await confirm({
    message: 'Proceed with Antigravity setup?',
    default: true,
  })

  if (!proceed) {
    return false
  }

  // Check if already installed
  const installed = await isAntigravityInstalled()

  if (!installed) {
    const success = await installAntigravityPlugin()
    if (!success) return false
  } else {
    logger.info('Antigravity plugin already configured')
  }

  // Check if already authenticated
  const authenticated = await isAntigravityAuthenticated()

  if (!authenticated) {
    const authSuccess = await authenticateAntigravity()
    if (!authSuccess) return false
  } else {
    logger.info('Already authenticated with Antigravity')

    const reauth = await confirm({
      message: 'Add another Google account?',
      default: false,
    })

    if (reauth) {
      await authenticateAntigravity()
    }
  }

  // Select model
  const modelChoices = getAntigravityModelChoices()

  const selectedModel = await select({
    message: 'Select Antigravity model:',
    choices: modelChoices,
    default: 'antigravity-claude-sonnet-4-5-thinking',
  })

  // Select variant if available
  const variantChoices = getVariantChoices(selectedModel)
  let selectedVariant: string | undefined

  if (variantChoices) {
    selectedVariant = await select({
      message: 'Select thinking variant:',
      choices: variantChoices,
      default: 'max',
    })
  }

  // Save configuration
  updateConfig({
    provider: 'google',
    model: selectedModel,
    variant: selectedVariant,
    antigravity: {
      enabled: true,
      pluginInstalled: true,
      authenticated: true,
    },
  })

  logger.success('Antigravity setup complete!')
  return true
}
