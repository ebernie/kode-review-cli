import { select, confirm, input } from '@inquirer/prompts'
import ora from 'ora'
import { createOpencode } from '@opencode-ai/sdk'
import { updateConfig, setOnboardingComplete, getConfigPath } from '../config/index.js'
import { PROVIDER_NAMES } from '../config/schema.js'
import { logger } from '../utils/logger.js'
import { commandExists } from '../utils/exec.js'
import { cyan, bold, green, dim } from '../cli/colors.js'
import { setupAntigravity } from './antigravity.js'
import { setupVcs } from './vcs.js'

interface ProviderInfo {
  id: string
  name: string
  models: { id: string; name: string }[]
}

/**
 * Fetch available providers from OpenCode
 */
async function fetchProviders(): Promise<ProviderInfo[]> {
  const spinner = ora('Fetching available providers...').start()

  try {
    const { client, server } = await createOpencode({
      port: 0,
      timeout: 15000,
    })

    try {
      const result = await client.config.providers()

      if (!result.data) {
        spinner.fail('Failed to fetch providers')
        return []
      }

      const providers: ProviderInfo[] = result.data.providers.map((p) => ({
        id: p.id,
        name: PROVIDER_NAMES[p.id] ?? p.name ?? p.id,
        models: p.models?.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
        })) ?? [],
      }))

      spinner.succeed('Loaded available providers')
      return providers
    } finally {
      server.close()
    }
  } catch (error) {
    spinner.fail('Failed to connect to OpenCode')
    logger.error(String(error))
    return []
  }
}

/**
 * Select provider and model (standard, non-Antigravity)
 */
async function selectProviderAndModel(providers: ProviderInfo[]): Promise<{ provider: string; model: string } | null> {
  if (providers.length === 0) {
    logger.error('No providers available. Please configure OpenCode first.')
    return null
  }

  // Add Antigravity as a special option
  const providerChoices = [
    {
      name: 'Antigravity (Free via Google OAuth) - Recommended',
      value: 'antigravity',
    },
    ...providers.map((p) => ({
      name: p.name,
      value: p.id,
    })),
  ]

  const selectedProvider = await select({
    message: 'Select LLM Provider:',
    choices: providerChoices,
  })

  // If Antigravity selected, handle separately
  if (selectedProvider === 'antigravity') {
    return null // Signal to use Antigravity flow
  }

  // Find the provider
  const provider = providers.find((p) => p.id === selectedProvider)

  if (!provider || provider.models.length === 0) {
    logger.error(`No models available for ${selectedProvider}`)
    return null
  }

  // Select model
  const modelChoices = provider.models.map((m) => ({
    name: m.name,
    value: m.id,
  }))

  const selectedModel = await select({
    message: 'Select Model:',
    choices: modelChoices,
  })

  return {
    provider: selectedProvider,
    model: selectedModel,
  }
}

/**
 * Run the complete onboarding wizard
 */
export async function runOnboardingWizard(): Promise<boolean> {
  console.log('')
  console.log(bold(cyan('Welcome to Kode Review CLI!')))
  console.log('')
  console.log("Let's set up your code review environment.")
  console.log('')

  // Check if OpenCode is installed
  const hasOpencode = await commandExists('opencode')

  if (!hasOpencode) {
    logger.error('OpenCode is not installed.')
    console.log('')
    console.log('Please install OpenCode first:')
    console.log(dim('  npm install -g opencode-ai'))
    console.log(dim('  # or'))
    console.log(dim('  curl -fsSL https://opencode.ai/install | bash'))
    console.log('')
    return false
  }

  logger.success('OpenCode detected')

  // Step 1: Provider/Model Selection
  console.log('')
  console.log(bold('Step 1: Configure LLM Provider'))

  const providers = await fetchProviders()

  const selection = await selectProviderAndModel(providers)

  if (selection === null) {
    // User selected Antigravity
    const antigravitySuccess = await setupAntigravity()
    if (!antigravitySuccess) {
      logger.warn('Antigravity setup was not completed. You can run setup again later.')
    }
  } else {
    // Standard provider selected
    updateConfig({
      provider: selection.provider,
      model: selection.model,
      antigravity: { enabled: false, pluginInstalled: false, authenticated: false },
    })
    logger.success(`Configured ${selection.provider}/${selection.model}`)
  }

  // Step 2: VCS Integration
  console.log('')
  console.log(bold('Step 2: Configure Version Control Integration'))
  console.log(dim('This enables reviewing GitHub PRs and GitLab MRs directly.'))

  const setupVcsNow = await confirm({
    message: 'Configure GitHub/GitLab integration now?',
    default: true,
  })

  if (setupVcsNow) {
    await setupVcs()
  } else {
    logger.info('Skipping VCS setup. You can configure it later with: kode-review --setup-vcs')
  }

  // Complete onboarding
  setOnboardingComplete(true)

  console.log('')
  console.log(green(bold('Setup complete!')))
  console.log('')
  console.log('Configuration saved to:', dim(getConfigPath()))
  console.log('')
  console.log('You can now run code reviews:')
  console.log(dim('  kode-review                    # Review local changes'))
  console.log(dim('  kode-review --scope pr         # Review PR/MR'))
  console.log(dim('  kode-review --setup            # Re-run setup'))
  console.log('')

  return true
}

/**
 * Run only the provider setup
 */
export async function runProviderSetup(): Promise<boolean> {
  const providers = await fetchProviders()
  const selection = await selectProviderAndModel(providers)

  if (selection === null) {
    return await setupAntigravity()
  }

  updateConfig({
    provider: selection.provider,
    model: selection.model,
  })

  logger.success(`Configured ${selection.provider}/${selection.model}`)
  return true
}
