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
 * Result of inspecting pi's model list.
 *
 *   - `ok`:    pi has at least one model with usable credentials.
 *   - `none`:  pi ran successfully but reports no models.
 *   - `error`: invoking `pi --list-models` failed (non-zero exit).
 */
export type PiModelInspection =
  | { kind: 'ok' }
  | { kind: 'none' }
  | { kind: 'error'; details: string }

/**
 * Inspect pi's configured models by shelling out to `pi --list-models`.
 *
 * Shared by the onboarding wizard's pass/fail gate and the `--doctor`
 * diagnostic so the stream-handling rules live in exactly one place.
 *
 * Note: pi writes its human-readable model table to stderr, and the
 * "No models available" sentinel may appear on either stream depending
 * on pi version. We inspect the combined output to stay robust across
 * both.
 */
export async function inspectPiModels(): Promise<PiModelInspection> {
  const result = await runCommand('pi', ['--list-models'])
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.exitCode !== 0) {
    return {
      kind: 'error',
      details: combined.trim() || `exit code ${result.exitCode}`,
    }
  }
  if (/No models available/i.test(combined) || combined.trim().length === 0) {
    return { kind: 'none' }
  }
  return { kind: 'ok' }
}

/**
 * True iff pi reports at least one model with valid credentials.
 *
 * Thin wrapper around `inspectPiModels` for callers that only need the
 * yes/no answer (the onboarding wizard's Step 2 gate).
 */
export async function piHasUsableModel(): Promise<boolean> {
  return (await inspectPiModels()).kind === 'ok'
}
