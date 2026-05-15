/**
 * v1.0 onboarding wizard.
 *
 * Pi (https://pi.dev) owns provider/model/auth — the wizard's job is to
 * verify pi is installed and has a usable provider, then walk the user
 * through VCS integration.
 */

import { confirm } from '@inquirer/prompts'
import { setOnboardingComplete, getConfigPath } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { cyan, bold, green, dim, red } from '../cli/colors.js'
import { setupVcs } from './vcs.js'
import { isPiInstalled, piHasUsableModel, PI_INSTALL_HINT, PI_LOGIN_HINT } from './pi.js'

/**
 * Run the complete onboarding wizard.
 *
 * Returns true on success, false if a prerequisite (pi install / pi auth)
 * is missing — caller should not mark onboarding complete in that case.
 */
export async function runOnboardingWizard(): Promise<boolean> {
  console.log('')
  console.log(bold(cyan('Welcome to Kode Review CLI')))
  console.log('')
  console.log(dim('v1.0 runs on pi (https://pi.dev). Pi handles provider auth and model selection;'))
  console.log(dim('this wizard verifies pi is set up and configures GitHub/GitLab integration.'))
  console.log('')

  // Step 1: pi installed?
  console.log(bold('Step 1: Verify pi is installed'))
  if (!(await isPiInstalled())) {
    console.log('')
    console.log(red('pi is not installed.'))
    console.log('')
    console.log(PI_INSTALL_HINT)
    console.log('')
    console.log('Re-run `kode-review --setup` once pi is on your PATH.')
    return false
  }
  logger.success('pi is installed')

  // Step 2: pi has a usable model?
  console.log('')
  console.log(bold('Step 2: Verify pi has a usable provider'))
  if (!(await piHasUsableModel())) {
    console.log('')
    console.log(red(PI_LOGIN_HINT))
    console.log('')
    return false
  }
  logger.success('pi has at least one usable provider')

  // Step 3: VCS integration
  console.log('')
  console.log(bold('Step 3: Configure version control integration'))
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

  // Done
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
