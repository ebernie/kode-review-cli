/**
 * Pi (https://pi.dev) availability checks for onboarding and per-review
 * auth gating. Pi owns provider/model/auth — kode-review only verifies
 * that pi is installed and has at least one usable model.
 */

import { exec as runCommand, commandExists } from '../utils/exec.js'

export const PI_INSTALL_HINT = [
  'Install pi (https://pi.dev) first:',
  '  npm install -g @mariozechner/pi-coding-agent',
].join('\n')

export const PI_LOGIN_HINT = [
  'No usable provider found in pi.',
  'Run `pi` and use `/login` to set up a provider, then re-run kode-review.',
].join('\n')

/**
 * True iff `pi` is on PATH.
 */
export async function isPiInstalled(): Promise<boolean> {
  return commandExists('pi')
}

/**
 * True iff pi reports at least one model with valid credentials.
 *
 * Shells out to `pi --list-models` rather than constructing the SDK's
 * AuthStorage + ModelRegistry because (a) this check needs to be cheap
 * and side-effect-free, and (b) the CLI owns its own canonical "no models
 * available" sentinel.
 */
export async function piHasUsableModel(): Promise<boolean> {
  const result = await runCommand('pi', ['--list-models'])
  if (result.exitCode !== 0) return false
  const stdout = result.stdout
  if (/No models available/i.test(stdout)) return false
  return stdout.trim().length > 0
}
