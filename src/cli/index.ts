// CLI argument parsing
export {
  parseArgs,
  createProgram,
  type CliOptions,
  type ReviewScope,
} from './args.js'

// Colors
export {
  colors,
  red,
  green,
  yellow,
  blue,
  cyan,
  gray,
  bold,
  dim,
  isTTY,
} from './colors.js'

// Interactive mode
export {
  createContext,
  isInteractive,
  type CliContext,
} from './interactive.js'

// Commands
export { showConfig, type ShowConfigOptions } from './show-config.js'
export {
  runDiagnostics,
  printDiagnostics,
  type DiagnosticCheck,
  type DiagnosticsResult,
} from './doctor.js'
