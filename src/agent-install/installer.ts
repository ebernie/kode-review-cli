/**
 * Installer for agent skill/command/rule files.
 *
 * Given a set of agents (Claude Code, Codex CLI, Cursor, …), copies bundled
 * markdown assets to each agent's well-known location on disk. Designed to be
 * idempotent: rerunning the install with no changes is a no-op, and
 * overwriting existing files always passes through a prompt (interactive) or
 * a force flag (non-interactive).
 */
import { confirm, checkbox } from '@inquirer/prompts'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { logger } from '../utils/logger.js'
import {
  AGENT_REGISTRY,
  getAgent,
  getBundledAssetsDir,
  isAgentName,
} from './registry.js'
import type {
  AgentName,
  AgentRegistryEntry,
  InstallOptions,
  InstallTarget,
  TargetResult,
} from './types.js'

/**
 * Parse the `--install-agent` value into an array of agent names.
 *
 * Accepts:
 *   - undefined / true   → empty (means "prompt the user")
 *   - "all"              → every registered agent
 *   - "claude-code,codex" → those two
 *   - "claude-code"      → just that one
 *
 * Throws on an unknown name (no silent fall-through; users mistype slugs).
 */
export function parseAgentList(raw: string | boolean | undefined): AgentName[] {
  if (raw === undefined || raw === true || raw === '') return []

  if (typeof raw !== 'string') {
    throw new Error(`Invalid --install-agent value: ${String(raw)}`)
  }

  if (raw.trim().toLowerCase() === 'all') {
    return AGENT_REGISTRY.map((entry) => entry.name)
  }

  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
  const result: AgentName[] = []
  for (const token of tokens) {
    if (!isAgentName(token)) {
      const known = AGENT_REGISTRY.map((entry) => entry.name).join(', ')
      throw new Error(`Unknown agent: "${token}". Available: ${known}, all.`)
    }
    if (!result.includes(token)) result.push(token)
  }
  return result
}

/**
 * Interactive multi-select for which agents to install for. Returns the
 * agents the user picked (possibly empty if they confirmed with nothing
 * selected). Caller decides what to do with an empty selection.
 */
async function pickAgentsInteractive(): Promise<AgentName[]> {
  const choices = AGENT_REGISTRY.map((entry) => ({
    name: `${entry.displayName} — ${entry.description}`,
    value: entry.name,
  }))

  const picked = await checkbox<AgentName>({
    message: 'Install kode-review skill/command for which agents?',
    choices,
    required: false,
  })

  return picked
}

/**
 * Refuse to overwrite a symlink. `lstat` returns metadata about the link
 * itself (no follow), so a hostile symlink at the destination cannot trick
 * us into writing through it to an arbitrary file. ENOENT means the target
 * doesn't exist yet — fine to create.
 */
async function assertNoSymlinkOverwrite(destination: string): Promise<void> {
  try {
    const st = await lstat(destination)
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite symlink at ${destination}. Remove it manually if you trust the target.`,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * For per-repo targets, verify the resolved destination stays inside the
 * resolved repo root. Defends against a hostile parent dir being a symlink
 * out of the repo tree (e.g. `<repo>/.cursor/rules` → `/etc/`). Resolves
 * both sides to their realpath so symlinks anywhere along the chain are
 * collapsed before the containment check.
 */
async function assertInsideRepoRoot(destination: string, repoRoot: string): Promise<void> {
  const repoReal = await realpath(repoRoot)
  // Walk up from the destination to find the deepest existing ancestor — the
  // file (and possibly some parent dirs) may not exist yet. We resolve the
  // ancestor's realpath, then re-attach the not-yet-existing tail.
  let probe = resolve(destination)
  const tail: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    tail.unshift(probe.slice(parent.length + 1))
    probe = parent
  }
  const baseReal = await realpath(probe)
  const resolvedDestination = tail.length === 0 ? baseReal : resolve(baseReal, ...tail)

  const rel = relative(repoReal, resolvedDestination)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to install outside the repository: ${destination} resolves to ${resolvedDestination} (outside ${repoReal}).`,
    )
  }
}

/**
 * Install one target. Returns a TargetResult describing what happened.
 *
 * Overwrite semantics:
 *   - File doesn't exist → write it.
 *   - File exists, force=true → overwrite.
 *   - File exists, interactive → prompt; honor the user's answer.
 *   - File exists, non-interactive, no force → skip with warning.
 */
async function installTarget(
  agent: AgentRegistryEntry,
  target: InstallTarget,
  opts: InstallOptions,
  assetsDir: string,
): Promise<TargetResult> {
  const destination = target.resolveDestination({ repoRoot: opts.repoRoot })
  if (destination === null) {
    return {
      agent: agent.name,
      destination: '',
      outcome: 'skipped-no-repo',
      reason: `${agent.displayName} installs per-repo, but no git repository was detected. Re-run from inside a git work tree.`,
    }
  }

  const assetContent = await readFile(`${assetsDir}/${target.asset}`, 'utf-8')
  const content = target.transform ? target.transform(assetContent) : assetContent

  const exists = existsSync(destination)
  if (exists && !opts.force) {
    if (opts.ctx.interactive) {
      const overwrite = await confirm({
        message: `${destination} already exists. Overwrite?`,
        default: false,
      })
      if (!overwrite) {
        return { agent: agent.name, destination, outcome: 'skipped-exists' }
      }
    } else {
      // Non-interactive: skip silently here. The `printSummary` pass at the
      // end emits a single consolidated line per skipped target plus a
      // `--force` hint, which is friendlier than logging twice.
      return { agent: agent.name, destination, outcome: 'skipped-exists' }
    }
  }

  // Symlink defense: per-repo targets (Cursor) write into a directory tree
  // controlled by repository contents. A hostile repo could pre-place the
  // destination as a symlink pointing at ~/.bashrc, ~/.ssh/authorized_keys,
  // or similar; writing through the symlink would clobber files outside the
  // repo. lstat() does NOT follow symlinks, so we can refuse before writing.
  // Same defense applies to user-level paths (~/.claude/, ~/.codex/) — defense
  // in depth.
  await assertNoSymlinkOverwrite(destination)
  if (opts.repoRoot !== null && agent.perRepo) {
    await assertInsideRepoRoot(destination, opts.repoRoot)
  }

  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content, 'utf-8')

  return {
    agent: agent.name,
    destination,
    outcome: exists ? 'overwrote' : 'written',
  }
}

/**
 * Run the install for the given agents. Resolves the list interactively if
 * the caller passed an empty array and we're interactive; errors otherwise.
 */
export async function runAgentInstall(opts: InstallOptions): Promise<TargetResult[]> {
  let agents = opts.agents
  if (agents.length === 0) {
    if (!opts.ctx.interactive) {
      throw new Error(
        'No agents specified. Pass `--install-agent <name|all>` (e.g., `--install-agent claude-code,codex`).',
      )
    }
    agents = await pickAgentsInteractive()
    if (agents.length === 0) {
      logger.info('No agents selected. Nothing to install.')
      return []
    }
  }

  const assetsDir = opts.assetsDir ?? getBundledAssetsDir()

  const results: TargetResult[] = []
  for (const name of agents) {
    const agent = getAgent(name)
    for (const target of agent.targets) {
      const result = await installTarget(agent, target, opts, assetsDir)
      results.push(result)
    }
  }

  printSummary(results)
  return results
}

function printSummary(results: TargetResult[]): void {
  const written = results.filter((r) => r.outcome === 'written')
  const overwrote = results.filter((r) => r.outcome === 'overwrote')
  const skippedExists = results.filter((r) => r.outcome === 'skipped-exists')
  const skippedNoRepo = results.filter((r) => r.outcome === 'skipped-no-repo')

  for (const r of [...written, ...overwrote]) {
    const verb = r.outcome === 'written' ? 'Installed' : 'Updated'
    logger.success(`${verb} → ${r.destination}`)
  }
  for (const r of skippedExists) {
    logger.info(`Skipped (already exists) → ${r.destination}`)
  }
  for (const r of skippedNoRepo) {
    logger.warn(`Skipped ${r.agent}: ${r.reason}`)
  }

  if (skippedExists.length > 0) {
    logger.info('Re-run with --force to overwrite existing files.')
  }

  if (written.length === 0 && overwrote.length === 0 && skippedNoRepo.length === 0) {
    return
  }

  console.log('')
  const total = written.length + overwrote.length
  if (total > 0) {
    logger.success(
      `kode-review installed for ${total} target${total === 1 ? '' : 's'}. Restart your agent (or open a new session) for it to pick up the new skill.`,
    )
  }
}
