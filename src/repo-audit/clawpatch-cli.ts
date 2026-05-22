/**
 * Thin wrapper around the external `clawpatch` CLI for the operations
 * --scope repo needs: `map` and `doctor`. We never call `clawpatch review`
 * here — that lives in `engines/clawpatch.ts` for the escape-hatch path.
 *
 * Uses the project's safe shell wrapper (execa under the hood; no shell).
 */
import { exec as runCommand } from '../utils/exec.js'

export interface ClawpatchMapResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Run `clawpatch map` in the given repo root. Pass `force: true` to remap.
 * Returns the full result so callers can surface stderr to the user.
 *
 * `clawpatch map` requires `.clawpatch/` to already exist — it exits 2 with
 * "not initialized; run clawpatch init" otherwise. Callers must run
 * `runClawpatchInit` first when the state dir is missing.
 */
export async function runClawpatchMap(
  repoRoot: string,
  options: { force?: boolean } = {},
): Promise<ClawpatchMapResult> {
  const args = ['map']
  if (options.force === true) args.push('--force')
  const result = await runCommand('clawpatch', args, { cwd: repoRoot })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/**
 * Run `clawpatch init` in the given repo root. Pass `force: true` to
 * re-initialize an existing `.clawpatch/` (clawpatch otherwise exits 2 with
 * "already initialized").
 */
export async function runClawpatchInit(
  repoRoot: string,
  options: { force?: boolean } = {},
): Promise<ClawpatchMapResult> {
  const args = ['init']
  if (options.force === true) args.push('--force')
  const result = await runCommand('clawpatch', args, { cwd: repoRoot })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export interface ClawpatchDoctorResult {
  exitCode: number
  /** Parsed JSON if --json output was valid; null otherwise. */
  payload: unknown | null
  raw: string
}

/**
 * Run `clawpatch doctor` and parse its JSON output. Returns a structured
 * result so onboarding can verify clawpatch + the configured provider
 * (e.g., pi) without us needing to mirror its checks.
 *
 * Used during `--setup` as an optional healthcheck. Failure is non-fatal —
 * the user can still proceed and discover issues on first `--scope repo` run.
 */
export async function runClawpatchDoctor(
  repoRoot: string,
  options: { provider?: string; model?: string } = {},
): Promise<ClawpatchDoctorResult> {
  const args = ['doctor', '--json']
  if (options.provider !== undefined) args.push('--provider', options.provider)
  if (options.model !== undefined) args.push('--model', options.model)
  const result = await runCommand('clawpatch', args, { cwd: repoRoot })
  const raw = `${result.stdout}\n${result.stderr}`
  let payload: unknown | null = null
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    // doctor may emit non-JSON if the binary is broken; leave payload null.
  }
  return { exitCode: result.exitCode, payload, raw }
}

/**
 * Run `clawpatch <args...>` as a generic passthrough. Used by the
 * `--engine clawpatch` escape-hatch path. Caller is responsible for
 * stitching together the right argv.
 */
export async function runClawpatch(
  repoRoot: string,
  args: string[],
): Promise<ClawpatchMapResult> {
  const result = await runCommand('clawpatch', args, { cwd: repoRoot })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
