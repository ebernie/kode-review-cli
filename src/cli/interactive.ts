import { isTTY } from './colors.js'

export interface CliContext {
  /** Whether we're running in an interactive terminal */
  interactive: boolean
  /** Quiet mode - minimal output */
  quiet: boolean
  /** JSON output mode */
  json: boolean
}

/**
 * Determine if we should run in interactive mode
 */
export function isInteractive(options: { quiet?: boolean; json?: boolean }): boolean {
  if (options.quiet || options.json) return false
  return isTTY()
}

/**
 * Create CLI context from options
 */
export function createContext(options: { quiet?: boolean; json?: boolean }): CliContext {
  const interactive = isInteractive(options)
  return {
    interactive,
    quiet: options.quiet ?? false,
    json: options.json ?? false,
  }
}
