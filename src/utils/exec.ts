import { execa, type Options as ExecaOptions } from 'execa'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Execute a command and return the result
 */
export async function exec(
  command: string,
  args: string[] = [],
  options?: ExecaOptions
): Promise<ExecResult> {
  const result = await execa(command, args, {
    reject: false,
    ...options,
  })
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    exitCode: result.exitCode ?? 0,
  }
}

/**
 * Check if a command exists in PATH (cross-platform)
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    // Use 'where' on Windows, 'which' on Unix-like systems
    const checkCommand = process.platform === 'win32' ? 'where' : 'which'
    const result = await execa(checkCommand, [command], { reject: false })
    return result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Execute a command interactively (inherits stdio)
 */
export async function execInteractive(
  command: string,
  args: string[] = [],
  options?: ExecaOptions
): Promise<number> {
  const result = await execa(command, args, {
    stdio: 'inherit',
    reject: false,
    ...options,
  })
  return result.exitCode ?? 1
}
