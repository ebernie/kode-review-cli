/**
 * Registry of agents the `--install-agent` command knows how to install for.
 *
 * Adding a new agent: append to `AGENT_REGISTRY` below. Each entry declares
 * which bundled asset files to write and how to resolve their destinations.
 * No other file in this module needs to change.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentName, AgentRegistryEntry } from './types.js'

/**
 * Absolute path to the directory shipped with the bundled skill/command
 * markdown.
 *
 * Path resolution differs between source and bundled layouts because tsup
 * collapses every source file into a single `dist/index.js`, so
 * `import.meta.url` always resolves to `dist/` at runtime, not to
 * `dist/agent-install/`. We probe the bundled layout first (filesystem
 * existence check, no exception thrown if missing), and fall back to the
 * source layout used by vitest and `npm run dev`.
 *
 *   - bundled: `dist/agent-install/assets/`
 *   - source : `src/agent-install/assets/`
 */
export function getBundledAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, 'agent-install', 'assets')
  if (existsSync(bundled)) return bundled
  return join(here, 'assets')
}

/**
 * Rewrite the bundled `command.md` frontmatter to Cursor's `.mdc` shape.
 * The bundled file ships with Claude Code's slash-command frontmatter
 * (`description`, `argument-hint`). Cursor only reads `description`, `globs`,
 * and `alwaysApply`, and choking on unknown keys is a real-world Cursor
 * footgun — keep the frontmatter minimal.
 */
export function transformForCursor(content: string): string {
  // Strip the leading YAML frontmatter block (between two `---` lines at the
  // very top of the file). If the asset format ever changes to omit it,
  // this becomes a no-op and we just prepend Cursor's frontmatter.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/)
  const body = fmMatch ? content.slice(fmMatch[0].length) : content

  const cursorHeader = [
    '---',
    'description: Run an AI-powered code review on the current repo via the kode-review CLI',
    'globs:',
    'alwaysApply: false',
    '---',
    '',
  ].join('\n')

  return cursorHeader + body
}

export const AGENT_REGISTRY: readonly AgentRegistryEntry[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    description: 'Install SKILL.md + /kode-review slash command to ~/.claude/',
    perRepo: false,
    targets: [
      {
        asset: 'skill.md',
        label: 'SKILL.md',
        resolveDestination: () =>
          join(homedir(), '.claude', 'skills', 'kode-review', 'SKILL.md'),
      },
      {
        asset: 'command.md',
        label: 'slash command',
        resolveDestination: () =>
          join(homedir(), '.claude', 'commands', 'kode-review.md'),
      },
    ],
  },
  {
    name: 'codex',
    displayName: 'Codex CLI',
    description: 'Install kode-review prompt to ~/.codex/prompts/',
    perRepo: false,
    targets: [
      {
        asset: 'command.md',
        label: 'prompt',
        resolveDestination: () =>
          join(homedir(), '.codex', 'prompts', 'kode-review.md'),
      },
    ],
  },
  {
    name: 'cursor',
    displayName: 'Cursor',
    description: 'Install kode-review rule into <repo>/.cursor/rules/ (per-repo)',
    perRepo: true,
    targets: [
      {
        asset: 'command.md',
        label: 'rule',
        resolveDestination: ({ repoRoot }) =>
          repoRoot ? join(repoRoot, '.cursor', 'rules', 'kode-review.mdc') : null,
        transform: transformForCursor,
      },
    ],
  },
] as const

const AGENT_NAMES = AGENT_REGISTRY.map((entry) => entry.name)

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value)
}

export function getAgent(name: AgentName): AgentRegistryEntry {
  const found = AGENT_REGISTRY.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`Unknown agent: "${name}". Known: ${AGENT_NAMES.join(', ')}.`)
  }
  return found
}

export function listAgentNames(): AgentName[] {
  return [...AGENT_NAMES]
}
