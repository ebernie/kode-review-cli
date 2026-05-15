import { Command } from 'commander'
import type { OutputFormat } from '../output/types.js'

declare const PKG_VERSION: string

export type ReviewScope = 'local' | 'pr' | 'both' | 'auto'

/**
 * Commander collector for `--reviewer`. Each invocation may carry one name
 * or a comma-separated list; multiple `--reviewer` flags accumulate.
 *
 * Tokens are not validated here — that happens after the full list is built,
 * in `parseArgs` / `resolveReviewerNames`.
 */
function collectReviewer(value: string, previous: string[]): string[] {
  const parts = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return previous.concat(parts)
}

export interface CliOptions {
  // Review options
  scope?: ReviewScope
  pr?: string
  quiet: boolean

  // Output options
  format: OutputFormat
  outputFile?: string
  postToPr: boolean

  // Hook generation
  initHooks: boolean

  // Model override (passthrough to pi)
  model?: string

  /**
   * Reviewer personas to run, in resolution order. Each token is either a
   * reviewer name, `all`, or a comma-separated list of names. `--reviewer`
   * may be passed multiple times.
   *
   * Default: `['general']` (preserves pre-multi-reviewer behaviour).
   */
  reviewers: string[]

  /** Print the list of available reviewers and exit. */
  listReviewers: boolean

  // Watch mode
  watch: boolean
  watchInterval: number
  watchInteractive: boolean

  // Setup commands
  setup: boolean
  setupVcs: boolean
  reset: boolean
  migrateYes: boolean

  // Indexer commands
  setupIndexer: boolean
  index: boolean
  indexReset: boolean
  indexStatus: boolean
  indexerCleanup: boolean
  indexBranch?: string
  indexListRepos: boolean

  // Background indexer commands
  backgroundIndexer: boolean
  indexQueue: boolean
  indexQueueClear: boolean

  // Review context
  withContext: boolean
  contextTopK: number

  // Agentic review mode
  agentic: boolean
  maxIterations: number
  agenticTimeout: number

  // Info commands
  showConfig: boolean
  doctor: boolean

  // Update command
  update: boolean

  // CI mode
  ci: boolean
  failOn: 'critical' | 'high' | 'none'
  noSuppressions: boolean
}

export function createProgram(): Command {
  const program = new Command()

  program
    .name('kode-review')
    .description('AI-powered code review CLI built on pi (https://pi.dev)')
    .version(PKG_VERSION)

  // ── Review modes (the primary commands) ────────────────────────────────────
  // Agent mode (file/search/git tools) is the DEFAULT. Pass --no-agentic for a
  // diff-only review (faster, no tool calls, no model exploration).
  program
    .option('-a, --agentic', 'Agent mode: review with file/search/git tools', true)
    .option('--no-agentic', 'Diff-only review — disable agent tool access')
    .option('-c, --ci', 'CI mode: agentic + markdown + post-to-PR + non-zero exit on CRITICAL', false)
    .option('-s, --scope <scope>', 'Review scope: local, pr, both, auto', 'auto')
    .option('-p, --pr <number>', 'Specific PR/MR number to review')

  // ── Output ─────────────────────────────────────────────────────────────────
  program
    .option('-f, --format <format>', 'Output format: text, json, markdown', 'text')
    .option('-o, --output-file <path>', 'Write output to file instead of stdout')
    .option('-q, --quiet', 'Minimal output (suitable for agents)', false)
    .option('--post-to-pr', 'Post review as PR/MR comment', false)

  // ── Agent / CI tuning ──────────────────────────────────────────────────────
  program
    .option('--max-iterations <n>', 'Max tool call iterations for agent mode (default: 10)', '10')
    .option('--agentic-timeout <s>', 'Timeout in seconds for agent mode (default: 600)', '600')
    .option('--fail-on <level>', 'In --ci mode, exit non-zero on findings of this severity (critical|high|none)', 'critical')
    .option('--no-suppressions', 'Disable kode-review: ignore markers in source — report every finding')

  // ── Context retrieval (non-agentic) ────────────────────────────────────────
  program
    .option('--with-context', 'Include semantic context in review', false)
    .option('--context-top-k <n>', 'Number of similar code chunks to include (default: 5)', '5')

  // ── Reviewer personas ──────────────────────────────────────────────────────
  program
    .option(
      '--reviewer <name>',
      'Reviewer persona(s) to run. Repeatable; comma-separated; "all" runs every reviewer. Default: general',
      collectReviewer,
      [] as string[],
    )
    .option('--list-reviewers', 'List available reviewers (built-in + user-defined) and exit', false)

  // ── Watch mode ─────────────────────────────────────────────────────────────
  program
    .option('-w, --watch', 'Watch mode: monitor for PRs/MRs where you are a reviewer', false)
    .option('--watch-interval <seconds>', 'Polling interval in seconds (default: 300)', '300')
    .option('--watch-interactive', 'Prompt to select PR/MR instead of auto-reviewing', false)

  // ── Model override ─────────────────────────────────────────────────────────
  program
    .option('--model <model>', 'Override model used for this review (e.g., anthropic/claude-sonnet-4-6)')

  // ── Setup & onboarding ─────────────────────────────────────────────────────
  program
    .option('--setup', 'Run the full onboarding wizard', false)
    .option('--setup-vcs', 'Re-configure GitHub/GitLab only', false)
    .option('--reset', 'Reset all configuration', false)
    .option('--init-hooks', 'Generate pre-commit hook for code review', false)
    .option('--migrate-yes', 'Skip the typed-confirmation prompt during the v1.0 clean-break migration', false)

  // ── Indexer ────────────────────────────────────────────────────────────────
  program
    .option('--setup-indexer', 'Interactive indexer setup wizard', false)
    .option('--index', 'Index/update current repository', false)
    .option('--index-reset', 'Drop and rebuild index for current repo', false)
    .option('--index-status', 'Show indexer status (running, indexed repos, stats)', false)
    .option('--indexer-cleanup', 'Remove indexer containers, volumes, and all indexed data', false)
    .option('--index-branch <branch>', 'Branch to index (defaults to current branch)')
    .option('--index-list-repos', 'List all indexed repositories with their branches', false)
    .option('--background-indexer', 'Start background indexer daemon for large repo re-indexing', false)
    .option('--index-queue', 'Show pending background indexing jobs', false)
    .option('--index-queue-clear', 'Clear all pending background indexing jobs', false)

  // ── Info & maintenance ─────────────────────────────────────────────────────
  program
    .option('--show-config', 'Display current configuration', false)
    .option('--doctor', 'Run system diagnostics', false)
    .option('--update', 'Check for and install the latest version', false)

  program.addHelpText('after', `
Primary modes:
  $ kode-review                          Agent review of local/PR changes (auto-detect scope) — DEFAULT
  $ kode-review --no-agentic             Diff-only review (faster, no tool calls)
  $ kode-review -c                       CI mode (agent + markdown + post-to-PR + fail-on-CRITICAL)
  $ kode-review -p 1234                  Agent review of PR #1234
  $ kode-review -s local -f markdown     Agent review of working-tree changes, markdown output
`)

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

  // Validate max iterations for agentic mode
  const maxIterationsRaw = opts.maxIterations ?? '10'
  const maxIterations = parseInt(maxIterationsRaw, 10)
  if (isNaN(maxIterations) || maxIterations < 1 || maxIterations > 50) {
    throw new Error(`Invalid max-iterations: "${maxIterationsRaw}". Must be a number between 1 and 50.`)
  }

  // Validate agentic timeout
  const agenticTimeoutRaw = opts.agenticTimeout ?? '600'
  const agenticTimeout = parseInt(agenticTimeoutRaw, 10)
  if (isNaN(agenticTimeout) || agenticTimeout < 30 || agenticTimeout > 600) {
    throw new Error(`Invalid agentic-timeout: "${agenticTimeoutRaw}". Must be a number between 30 and 600 seconds.`)
  }

  let format: OutputFormat = (opts.format ?? 'text') as OutputFormat
  if (!['text', 'json', 'markdown'].includes(format)) {
    throw new Error(`Invalid format: "${format}". Must be text, json, or markdown.`)
  }

  // --ci convenience: bundle agentic + quiet + markdown + post-to-PR unless the
  // user explicitly overrode each flag. Commander stores explicit-vs-default
  // intent on `program.opts().__source` (not available here), so we infer
  // "user didn't pass it" by checking if the value still equals the default.
  const ci: boolean = opts.ci ?? false
  const explicitFlagSet = new Set<string>(argv.slice(2).map((a) => a.split('=')[0]))
  // opts.agentic comes from Commander with default=true; --no-agentic flips it
  // to false. CI mode is authoritative — it always requires tool access.
  let agentic: boolean = opts.agentic ?? true
  let quiet: boolean = opts.quiet ?? false
  let postToPr: boolean = opts.postToPr ?? false
  if (ci) {
    agentic = true
    if (!explicitFlagSet.has('-q') && !explicitFlagSet.has('--quiet')) quiet = true
    if (!explicitFlagSet.has('--format') && !explicitFlagSet.has('-f')) format = 'markdown'
    if (!explicitFlagSet.has('--post-to-pr')) postToPr = true
  }

  const failOnRaw: string = String(opts.failOn ?? 'critical')
  if (!['critical', 'high', 'none'].includes(failOnRaw)) {
    throw new Error(`Invalid --fail-on: "${failOnRaw}". Must be one of: critical, high, none.`)
  }
  const failOn = failOnRaw as 'critical' | 'high' | 'none'

  // Commander auto-inverts --no-suppressions into opts.suppressions=false.
  const noSuppressions = opts.suppressions === false

  return {
    scope: opts.scope as ReviewScope | undefined,
    pr: opts.pr,
    quiet,
    format,
    outputFile: opts.outputFile,
    postToPr,
    initHooks: opts.initHooks ?? false,
    model: opts.model,
    reviewers: Array.isArray(opts.reviewer) && opts.reviewer.length > 0
      ? (opts.reviewer as string[])
      : ['general'],
    listReviewers: opts.listReviewers ?? false,
    watch: opts.watch ?? false,
    watchInterval,
    watchInteractive: opts.watchInteractive ?? false,
    setup: opts.setup ?? false,
    setupVcs: opts.setupVcs ?? false,
    reset: opts.reset ?? false,
    migrateYes: opts.migrateYes ?? false,
    setupIndexer: opts.setupIndexer ?? false,
    index: opts.index ?? false,
    indexReset: opts.indexReset ?? false,
    indexStatus: opts.indexStatus ?? false,
    indexerCleanup: opts.indexerCleanup ?? false,
    indexBranch: opts.indexBranch,
    indexListRepos: opts.indexListRepos ?? false,
    backgroundIndexer: opts.backgroundIndexer ?? false,
    indexQueue: opts.indexQueue ?? false,
    indexQueueClear: opts.indexQueueClear ?? false,
    withContext: opts.withContext ?? false,
    contextTopK,
    agentic,
    maxIterations,
    agenticTimeout,
    showConfig: opts.showConfig ?? false,
    doctor: opts.doctor ?? false,
    update: opts.update ?? false,
    ci,
    failOn,
    noSuppressions,
  }
}
