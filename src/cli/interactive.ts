import { isTTY } from './colors.js'
import type { OutputFormat } from '../output/types.js'

export interface CliContext {
  /** Whether we're running in an interactive terminal */
  interactive: boolean
  /** Quiet mode - minimal output */
  quiet: boolean
}

interface InteractiveSignals {
  quiet?: boolean
  format?: OutputFormat
}

/**
 * Determine if we should run in interactive mode
 */
export function isInteractive(options: InteractiveSignals): boolean {
  if (options.quiet || options.format === 'json') return false
  return isTTY()
}

/**
 * Create CLI context from options
 */
export function createContext(options: InteractiveSignals): CliContext {
  const interactive = isInteractive(options)
  return {
    interactive,
    quiet: options.quiet ?? false,
  }
}
