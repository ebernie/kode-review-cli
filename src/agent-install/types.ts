/**
 * Types for the agent skill/command installer.
 *
 * An "agent" here is an AI coding tool (Claude Code, Codex CLI, Cursor, …) that
 * can be taught about kode-review via a markdown skill/slash-command/rule file.
 * Each agent has a `registry` entry describing which bundled assets to copy and
 * where on disk they land.
 */
import type { CliContext } from '../cli/interactive.js'

/** Slug for an installable agent. Matches the user-facing `--install-agent` value. */
export type AgentName = 'claude-code' | 'codex' | 'cursor'

/**
 * One file that an agent install writes. An agent may have multiple targets
 * (Claude Code, for example, has both a SKILL.md and a slash command file).
 */
export interface InstallTarget {
  /** Asset filename inside `src/agent-install/assets/`. */
  asset: 'skill.md' | 'command.md'

  /**
   * Resolve the destination absolute path for this target. Receives the current
   * repo root (if any) so per-repo targets (Cursor) can compute their path.
   * Returns `null` to indicate this target cannot be installed in the current
   * environment (e.g., Cursor when not inside a git repo).
   */
  resolveDestination(args: { repoRoot: string | null }): string | null

  /**
   * Optional transform applied to the raw asset content before writing. Used by
   * Cursor to rewrite Claude-flavored YAML frontmatter into Cursor's `.mdc`
   * shape. Identity by default.
   */
  transform?(content: string): string

  /** Short human label for prompts: e.g. "SKILL.md", "slash command", "rule". */
  label: string
}

export interface AgentRegistryEntry {
  name: AgentName
  displayName: string
  /** One-line description shown in the interactive picker. */
  description: string
  /** Files this install produces. */
  targets: InstallTarget[]
  /**
   * True when the agent installs per-repo (needs a repoRoot). Used by the CLI
   * to surface a clear error when not inside a git work tree.
   */
  perRepo: boolean
}

export interface InstallOptions {
  /** Agents to install for. Empty + interactive → picker. Empty + non-interactive → error. */
  agents: AgentName[]
  /** Overwrite existing files without prompting. */
  force: boolean
  /** From CliContext — drives interactive prompts vs. silent skip. */
  ctx: CliContext
  /** Current repo root (for Cursor); null when not in a git tree. */
  repoRoot: string | null
  /** Absolute path to the bundled assets directory (test override). */
  assetsDir?: string
}

export type TargetOutcome = 'written' | 'skipped-exists' | 'skipped-no-repo' | 'overwrote'

export interface TargetResult {
  agent: AgentName
  destination: string
  outcome: TargetOutcome
  /** Only set when outcome === 'skipped-no-repo'. */
  reason?: string
}
