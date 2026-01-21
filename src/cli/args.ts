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

  // Watch mode
  watch: boolean
  watchInterval: number
  watchInteractive: boolean

  // Setup commands
  setup: boolean
  setupProvider: boolean
  setupVcs: boolean
  reset: boolean

  // Indexer commands
  setupIndexer: boolean
  index: boolean
  indexWatch: boolean
  indexReset: boolean
  indexStatus: boolean
  indexerCleanup: boolean
  indexBranch?: string
  indexListRepos: boolean

  // Review context
  withContext: boolean
  contextTopK: number
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

  // Watch mode
  program
    .option('-w, --watch', 'Watch mode: monitor for PRs/MRs where you are a reviewer', false)
    .option('--watch-interval <seconds>', 'Polling interval in seconds (default: 300)', '300')
    .option('--watch-interactive', 'Prompt to select PR/MR instead of auto-reviewing', false)

  // Setup commands
  program
    .option('--setup', 'Run the full onboarding wizard', false)
    .option('--setup-provider', 'Re-configure provider/model only', false)
    .option('--setup-vcs', 'Re-configure GitHub/GitLab only', false)
    .option('--reset', 'Reset all configuration', false)

  // Indexer commands
  program
    .option('--setup-indexer', 'Interactive indexer setup wizard', false)
    .option('--index', 'Index/update current repository', false)
    .option('--index-watch', 'Continuous indexing (watch mode)', false)
    .option('--index-reset', 'Drop and rebuild index for current repo', false)
    .option('--index-status', 'Show indexer status (running, indexed repos, stats)', false)
    .option('--indexer-cleanup', 'Remove indexer containers, volumes, and all indexed data', false)
    .option('--index-branch <branch>', 'Branch to index (defaults to current branch)')
    .option('--index-list-repos', 'List all indexed repositories with their branches', false)

  // Review context options
  program
    .option('--with-context', 'Include semantic context in review', false)
    .option('--context-top-k <n>', 'Number of similar code chunks to include (default: 5)', '5')

  return program
}

export function parseArgs(argv: string[]): CliOptions {
  const program = createProgram()
  program.parse(argv)

  const opts = program.opts()

  // Validate watch interval
  const watchIntervalRaw = opts.watchInterval ?? '300'
  const watchInterval = parseInt(watchIntervalRaw, 10)
  if (isNaN(watchInterval) || watchInterval < 10) {
    throw new Error(`Invalid watch interval: "${watchIntervalRaw}". Must be a number >= 10 seconds.`)
  }

  // Validate context top-k
  const contextTopKRaw = opts.contextTopK ?? '5'
  const contextTopK = parseInt(contextTopKRaw, 10)
  if (isNaN(contextTopK) || contextTopK < 1 || contextTopK > 20) {
    throw new Error(`Invalid context-top-k: "${contextTopKRaw}". Must be a number between 1 and 20.`)
  }

  return {
    scope: opts.scope as ReviewScope | undefined,
    pr: opts.pr,
    quiet: opts.quiet ?? false,
    json: opts.json ?? false,
    provider: opts.provider,
    model: opts.model,
    variant: opts.variant,
    attach: opts.attach,
    watch: opts.watch ?? false,
    watchInterval,
    watchInteractive: opts.watchInteractive ?? false,
    setup: opts.setup ?? false,
    setupProvider: opts.setupProvider ?? false,
    setupVcs: opts.setupVcs ?? false,
    reset: opts.reset ?? false,
    setupIndexer: opts.setupIndexer ?? false,
    index: opts.index ?? false,
    indexWatch: opts.indexWatch ?? false,
    indexReset: opts.indexReset ?? false,
    indexStatus: opts.indexStatus ?? false,
    indexerCleanup: opts.indexerCleanup ?? false,
    indexBranch: opts.indexBranch,
    indexListRepos: opts.indexListRepos ?? false,
    withContext: opts.withContext ?? false,
    contextTopK,
  }
}
