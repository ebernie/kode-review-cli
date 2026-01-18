import { select, confirm } from '@inquirer/prompts'
import ora from 'ora'
import { exec, execInteractive, commandExists } from '../utils/exec.js'
import { logger } from '../utils/logger.js'
import { updateConfig } from '../config/index.js'
import { ANTIGRAVITY_MODELS } from '../config/schema.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

const PLUGIN_NPM_PACKAGE = 'opencode-antigravity-auth'
const PLUGIN_CONFIG_NAME = 'opencode-antigravity-auth@beta'

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
 * Check if the Antigravity npm package is installed globally
 */
async function isNpmPackageInstalled(): Promise<boolean> {
  try {
    // Use exec with array args (safe from injection via execa)
    const result = await exec('npm', ['list', '-g', PLUGIN_NPM_PACKAGE, '--depth=0'])
    return result.exitCode === 0 && result.stdout.includes(PLUGIN_NPM_PACKAGE)
  } catch {
    return false
  }
}

/**
 * Check if Antigravity plugin is fully installed (npm package + config)
 */
export async function isAntigravityInstalled(): Promise<boolean> {
  // First check if the npm package is installed
  const packageInstalled = await isNpmPackageInstalled()
  if (!packageInstalled) {
    return false
  }

  // Then check if plugin is in OpenCode config
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
 * Get the OpenCode data directory path (where auth.json is stored)
 * - Windows: %LOCALAPPDATA%\opencode
 * - macOS/Linux: ~/.local/share/opencode (respects XDG_DATA_HOME)
 */
function getOpenCodeDataDir(): string {
  const home = homedir()

  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'opencode')
  }

  // macOS and Linux: use XDG_DATA_HOME or default to ~/.local/share
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')
}

/**
 * Check if Antigravity/Google is authenticated by checking auth.json
 */
export async function isAntigravityAuthenticated(): Promise<boolean> {
  const authPath = join(getOpenCodeDataDir(), 'auth.json')

  if (!existsSync(authPath)) {
    return false
  }

  try {
    const content = await readFile(authPath, 'utf-8')
    const auth = JSON.parse(content)
    // Check if there's a google credential
    return auth && typeof auth === 'object' && 'google' in auth
  } catch {
    return false
  }
}

/**
 * Install the Antigravity plugin
 */
export async function installAntigravityPlugin(): Promise<boolean> {
  const spinner = ora('Installing Antigravity plugin...').start()

  try {
    // Step 1: Install the npm package globally if not already installed
    const packageInstalled = await isNpmPackageInstalled()
    if (!packageInstalled) {
      spinner.text = 'Installing Antigravity npm package (this may take a moment)...'
      const npmResult = await exec('npm', ['install', '-g', PLUGIN_NPM_PACKAGE])
      if (npmResult.exitCode !== 0) {
        const stderr = npmResult.stderr || ''
        const isPermissionError = stderr.includes('EACCES') ||
                                   stderr.includes('permission denied') ||
                                   stderr.includes('Permission denied')

        spinner.fail('Failed to install Antigravity npm package')

        if (isPermissionError) {
          logger.error('Permission denied during global npm install')
          logger.info('')
          logger.info('Please run one of the following commands manually:')
          logger.info(`  sudo npm install -g ${PLUGIN_NPM_PACKAGE}`)
          logger.info('  # or with bun:')
          logger.info(`  sudo bun install -g ${PLUGIN_NPM_PACKAGE}`)
        } else {
          logger.error(stderr || 'npm install failed')
          logger.info(`Try running manually: npm install -g ${PLUGIN_NPM_PACKAGE}`)
        }
        return false
      }
      spinner.text = 'Configuring Antigravity plugin...'
    }

    // Step 2: Ensure opencode config directory exists
    const configDir = getOpenCodeConfigDir()
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true })
    }

    // Step 3: Read or create OpenCode config
    const configPath = join(configDir, 'opencode.json')
    let config: Record<string, unknown> = {}

    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8')
      config = JSON.parse(content)
    }

    // Step 4: Add plugin if not already present
    if (!Array.isArray(config.plugin)) {
      config.plugin = []
    }

    const pluginArray = config.plugin as string[]
    if (!pluginArray.includes(PLUGIN_CONFIG_NAME)) {
      pluginArray.push(PLUGIN_CONFIG_NAME)
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
 * Run Antigravity OAuth authentication using the CLI directly
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

  console.log('')
  console.log('  ┌─────────────────────────────────────────────────────┐')
  console.log('  │  Starting OpenCode authentication...                │')
  console.log('  │                                                     │')
  console.log('  │  1. Select "Google" from the provider list          │')
  console.log('  │  2. Choose "OAuth"                                  │')
  console.log('  │  3. Complete sign-in in your browser                │')
  console.log('  │  4. The CLI will detect when you\'re done            │')
  console.log('  └─────────────────────────────────────────────────────┘')
  console.log('')

  // Run opencode auth login interactively
  const exitCode = await execInteractive('opencode', ['auth', 'login'])

  // Small delay to let credentials be written
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Check result
  if (exitCode === 0) {
    // Verify credentials were saved
    const result = await exec('opencode', ['auth', 'list'])
    if (result.stdout.toLowerCase().includes('google') ||
        result.stdout.includes('1 credential') ||
        result.stdout.includes('credentials')) {
      logger.success('Successfully authenticated!')
      return true
    }
  }

  // Check if auth file exists as fallback
  if (await isAntigravityAuthenticated()) {
    logger.success('Successfully authenticated!')
    return true
  }

  if (exitCode !== 0) {
    logger.error('Authentication was cancelled or failed')
  } else {
    logger.warn('Authentication may not have completed for Google.')
    logger.info('Please try again and make sure to select Google > OAuth')
  }

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
