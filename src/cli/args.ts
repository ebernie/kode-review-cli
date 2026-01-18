import { Command } from 'commander'

export type ReviewScope = 'local' | 'pr' | 'both' | 'auto'

export interface CliOptions {
  // Review options
  scope?: ReviewScope
  pr?: string
  quiet: boolean
  json: boolean

  // Model overrides
  provider?: string
  model?: string
  variant?: string

  // Server
  attach?: string

  // Setup commands
  setup: boolean
  setupProvider: boolean
  setupVcs: boolean
  reset: boolean
}

export function createProgram(): Command {
  const program = new Command()

  program
    .name('kode-review')
    .description('AI-powered code review CLI using OpenCode SDK')
    .version('0.1.0')

  // Review options
  program
    .option('-s, --scope <scope>', 'Review scope: local, pr, both, auto (default: auto)', 'auto')
    .option('-p, --pr <number>', 'Specific PR/MR number to review')
    .option('-q, --quiet', 'Minimal output (suitable for agents)', false)
    .option('-j, --json', 'Output in JSON format', false)

  // Model overrides
  program
    .option('--provider <provider>', 'Override provider (e.g., anthropic, google)')
    .option('--model <model>', 'Override model (e.g., claude-sonnet-4-20250514)')
    .option('--variant <variant>', 'Override variant (e.g., max, low)')

  // Server
  program
    .option('--attach <url>', 'Attach to running OpenCode server')

  // Setup commands
  program
    .option('--setup', 'Run the full onboarding wizard', false)
    .option('--setup-provider', 'Re-configure provider/model only', false)
    .option('--setup-vcs', 'Re-configure GitHub/GitLab only', false)
    .option('--reset', 'Reset all configuration', false)

  return program
}

export function parseArgs(argv: string[]): CliOptions {
  const program = createProgram()
  program.parse(argv)

  const opts = program.opts()

  return {
    scope: opts.scope as ReviewScope | undefined,
    pr: opts.pr,
    quiet: opts.quiet ?? false,
    json: opts.json ?? false,
    provider: opts.provider,
    model: opts.model,
    variant: opts.variant,
    attach: opts.attach,
    setup: opts.setup ?? false,
    setupProvider: opts.setupProvider ?? false,
    setupVcs: opts.setupVcs ?? false,
    reset: opts.reset ?? false,
  }
}
