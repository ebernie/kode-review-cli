/**
 * Tests for the agent installer.
 *
 * The installer is FS-heavy: it writes markdown files to per-agent locations
 * on disk. Every test gets its own tmp dir; we point the registry's
 * destinations at that tmp dir via test-scoped registry entries, and we feed
 * the installer the bundled-assets dir explicitly via the `assetsDir` option.
 *
 * No mocks of fs/promises — the installer's contract IS the filesystem
 * effect, and mocking it would be testing the SUT's internals. We do mock
 * the inquirer prompts so the tests don't try to read from stdin.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { confirmMock, checkboxMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  checkboxMock: vi.fn(),
}))
vi.mock('@inquirer/prompts', () => ({
  confirm: confirmMock,
  checkbox: checkboxMock,
}))

import { parseAgentList, runAgentInstall } from '../installer.js'
import { transformForCursor } from '../registry.js'
import type { InstallOptions } from '../types.js'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const BUNDLED_ASSETS = join(REPO_ROOT, 'src', 'agent-install', 'assets')

let tmp: string
let fakeHome: string
let originalHome: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-install-'))
  fakeHome = join(tmp, 'home')
  await mkdir(fakeHome, { recursive: true })

  originalHome = process.env.HOME
  process.env.HOME = fakeHome

  confirmMock.mockReset()
  checkboxMock.mockReset()
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(tmp, { recursive: true, force: true })
})

function baseOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    agents: [],
    force: false,
    ctx: { interactive: false, quiet: false },
    repoRoot: null,
    assetsDir: BUNDLED_ASSETS,
    ...overrides,
  }
}

describe('parseAgentList', () => {
  it('returns empty when value is undefined (means: prompt)', () => {
    expect(parseAgentList(undefined)).toEqual([])
  })

  it('returns empty when value is `true` (flag with no value)', () => {
    expect(parseAgentList(true)).toEqual([])
  })

  it('parses a single agent name', () => {
    expect(parseAgentList('claude-code')).toEqual(['claude-code'])
  })

  it('parses a comma-separated list and trims whitespace', () => {
    expect(parseAgentList(' claude-code , codex ')).toEqual(['claude-code', 'codex'])
  })

  it('deduplicates repeated names', () => {
    expect(parseAgentList('claude-code,claude-code,codex')).toEqual(['claude-code', 'codex'])
  })

  it('expands `all` to every registered agent', () => {
    const result = parseAgentList('all')
    expect(result).toEqual(expect.arrayContaining(['claude-code', 'codex', 'cursor']))
    expect(result.length).toBe(3)
  })

  it('rejects unknown agent names with a list of options', () => {
    expect(() => parseAgentList('vim')).toThrow(/Unknown agent: "vim"/)
    expect(() => parseAgentList('claude-code,nope')).toThrow(/Unknown agent: "nope"/)
  })
})

describe('runAgentInstall — Claude Code', () => {
  it('writes both SKILL.md and the slash command to ~/.claude/', async () => {
    const results = await runAgentInstall(baseOpts({ agents: ['claude-code'] }))

    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    const commandPath = join(fakeHome, '.claude', 'commands', 'kode-review.md')

    expect(existsSync(skillPath)).toBe(true)
    expect(existsSync(commandPath)).toBe(true)

    const skill = await readFile(skillPath, 'utf-8')
    expect(skill).toMatch(/^---\nname: kode-review/)
    expect(skill).toContain('`kode-review` CLI')

    const command = await readFile(commandPath, 'utf-8')
    expect(command).toContain('# /kode-review')

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.outcome === 'written')).toBe(true)
  })

  it('creates the .claude/skills/kode-review/ directory if it does not exist', async () => {
    // .claude doesn't exist yet — the installer must mkdir -p.
    await runAgentInstall(baseOpts({ agents: ['claude-code'] }))

    expect(existsSync(join(fakeHome, '.claude', 'skills', 'kode-review'))).toBe(true)
    expect(existsSync(join(fakeHome, '.claude', 'commands'))).toBe(true)
  })
})

describe('runAgentInstall — Codex CLI', () => {
  it('writes the command asset (not the skill asset) to ~/.codex/prompts/', async () => {
    const results = await runAgentInstall(baseOpts({ agents: ['codex'] }))

    const promptPath = join(fakeHome, '.codex', 'prompts', 'kode-review.md')
    expect(existsSync(promptPath)).toBe(true)
    const content = await readFile(promptPath, 'utf-8')
    // Distinguish command.md from skill.md — the command asset has
    // `argument-hint:` in its frontmatter; the skill asset has `triggers:`
    // and `allowed-tools:`. Both contain the literal `# /kode-review`.
    expect(content).toContain('argument-hint:')
    expect(content).not.toContain('triggers:')
    expect(content).not.toContain('allowed-tools:')
    expect(content).toContain('# /kode-review')
    expect(results).toHaveLength(1)
  })
})

describe('runAgentInstall — Cursor', () => {
  it('writes to <repoRoot>/.cursor/rules/kode-review.mdc when a repo root is provided', async () => {
    const repoRoot = join(tmp, 'repo')
    await mkdir(repoRoot, { recursive: true })

    const results = await runAgentInstall(
      baseOpts({ agents: ['cursor'], repoRoot }),
    )

    const rulePath = join(repoRoot, '.cursor', 'rules', 'kode-review.mdc')
    expect(existsSync(rulePath)).toBe(true)
    expect(results[0].outcome).toBe('written')

    const content = await readFile(rulePath, 'utf-8')
    // Cursor frontmatter is rewritten — argument-hint must be gone.
    expect(content).not.toContain('argument-hint:')
    expect(content).toMatch(/^---\ndescription: /)
    expect(content).toContain('alwaysApply: false')
    expect(content).toContain('globs:')
    // Body content survives the rewrite.
    expect(content).toContain('# /kode-review')
  })

  it('skips cleanly when no repo root is available', async () => {
    const results = await runAgentInstall(baseOpts({ agents: ['cursor'], repoRoot: null }))

    expect(results).toHaveLength(1)
    expect(results[0].outcome).toBe('skipped-no-repo')
    // Document the destination contract for the no-repo case — empty string,
    // not a partial path or undefined. Consumers iterate results to log them.
    expect(results[0].destination).toBe('')
    expect(results[0].reason).toMatch(/per-repo/)
  })
})

describe('overwrite semantics', () => {
  it('skips with warning when file exists, non-interactive, no force', async () => {
    // Pre-create the target file with sentinel content.
    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    await mkdir(join(fakeHome, '.claude', 'skills', 'kode-review'), { recursive: true })
    await writeFile(skillPath, 'PREEXISTING')

    const results = await runAgentInstall(baseOpts({ agents: ['claude-code'] }))

    const skillContent = await readFile(skillPath, 'utf-8')
    expect(skillContent).toBe('PREEXISTING')

    const skillResult = results.find((r) => r.destination === skillPath)
    expect(skillResult?.outcome).toBe('skipped-exists')
  })

  it('overwrites when force=true even if file exists', async () => {
    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    await mkdir(join(fakeHome, '.claude', 'skills', 'kode-review'), { recursive: true })
    await writeFile(skillPath, 'PREEXISTING')

    const results = await runAgentInstall(
      baseOpts({ agents: ['claude-code'], force: true }),
    )

    const skillContent = await readFile(skillPath, 'utf-8')
    expect(skillContent).not.toBe('PREEXISTING')
    expect(skillContent).toMatch(/^---\nname: kode-review/)

    const skillResult = results.find((r) => r.destination === skillPath)
    expect(skillResult?.outcome).toBe('overwrote')
  })

  it('prompts interactively when file exists; honors a "no" answer', async () => {
    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    await mkdir(join(fakeHome, '.claude', 'skills', 'kode-review'), { recursive: true })
    await writeFile(skillPath, 'PREEXISTING')

    // User declines overwrite on the first (SKILL.md) prompt; we expect the
    // second target (slash command) to install normally because it doesn't
    // exist yet.
    confirmMock.mockResolvedValue(false)

    const results = await runAgentInstall(
      baseOpts({
        agents: ['claude-code'],
        ctx: { interactive: true, quiet: false },
      }),
    )

    expect(confirmMock).toHaveBeenCalled()
    const skillContent = await readFile(skillPath, 'utf-8')
    expect(skillContent).toBe('PREEXISTING')

    const skillResult = results.find((r) => r.destination === skillPath)
    expect(skillResult?.outcome).toBe('skipped-exists')

    // The slash command target didn't exist, so it should have been written
    // without any prompt.
    const cmdPath = join(fakeHome, '.claude', 'commands', 'kode-review.md')
    expect(existsSync(cmdPath)).toBe(true)
  })

  it('prompts interactively and honors a "yes" answer', async () => {
    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    await mkdir(join(fakeHome, '.claude', 'skills', 'kode-review'), { recursive: true })
    await writeFile(skillPath, 'PREEXISTING')

    confirmMock.mockResolvedValue(true)

    const results = await runAgentInstall(
      baseOpts({
        agents: ['claude-code'],
        ctx: { interactive: true, quiet: false },
      }),
    )

    const skillContent = await readFile(skillPath, 'utf-8')
    // Positive content check: the bundled asset, not just "anything but the
    // sentinel". An installer that wrote an empty file or the wrong asset
    // would still satisfy `!== 'PREEXISTING'`.
    expect(skillContent).toMatch(/^---\nname: kode-review/)
    expect(skillContent).toContain('triggers:')
    const skillResult = results.find((r) => r.destination === skillPath)
    expect(skillResult?.outcome).toBe('overwrote')
  })
})

describe('interactive picker', () => {
  it('errors in non-interactive mode when no agents are specified', async () => {
    await expect(
      runAgentInstall(baseOpts({ agents: [], ctx: { interactive: false, quiet: false } })),
    ).rejects.toThrow(/No agents specified/)
  })

  it('uses the picker output when interactive and no agents specified', async () => {
    checkboxMock.mockResolvedValue(['codex'])

    const results = await runAgentInstall(
      baseOpts({ agents: [], ctx: { interactive: true, quiet: false } }),
    )

    expect(checkboxMock).toHaveBeenCalledTimes(1)
    // The set of options shown to the user is part of the contract — verify
    // every registered agent appears, not just that the call happened.
    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'claude-code' }),
          expect.objectContaining({ value: 'codex' }),
          expect.objectContaining({ value: 'cursor' }),
        ]),
      }),
    )

    expect(results).toHaveLength(1)
    expect(results[0].agent).toBe('codex')
    expect(existsSync(join(fakeHome, '.codex', 'prompts', 'kode-review.md'))).toBe(true)
  })

  it('returns an empty result and writes nothing when picker returns nothing', async () => {
    checkboxMock.mockResolvedValue([])

    const results = await runAgentInstall(
      baseOpts({ agents: [], ctx: { interactive: true, quiet: false } }),
    )

    expect(results).toEqual([])
    expect(existsSync(join(fakeHome, '.codex'))).toBe(false)
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false)
  })
})

describe('transformForCursor', () => {
  it('replaces Claude-style frontmatter with Cursor frontmatter', () => {
    const input = [
      '---',
      'description: Whatever',
      'argument-hint: [foo]',
      '---',
      '',
      '# Body',
      'content',
    ].join('\n')

    const result = transformForCursor(input)

    // The Cursor-specific description string must be present, and the
    // original `description: Whatever` value must NOT leak through — that
    // would mean two `description:` lines in the frontmatter.
    expect(result).toContain('description: Run an AI-powered code review')
    expect(result).not.toContain('description: Whatever')
    expect(result).toContain('alwaysApply: false')
    expect(result).toContain('globs:')
    expect(result).not.toContain('argument-hint:')
    expect(result).toContain('# Body')
    expect(result).toContain('content')
  })

  it('still wraps content with the full Cursor frontmatter when input has none', () => {
    const input = '# Just a body\n'
    const result = transformForCursor(input)

    expect(result).toMatch(/^---\ndescription: /)
    expect(result).toContain('alwaysApply: false')
    expect(result).toContain('globs:')
    expect(result).toContain('# Just a body')
  })
})

describe('idempotence', () => {
  it('re-running with the same content + force is a no-op effect on content', async () => {
    await runAgentInstall(baseOpts({ agents: ['claude-code'] }))
    const skillPath = join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md')
    const first = await readFile(skillPath, 'utf-8')

    await runAgentInstall(baseOpts({ agents: ['claude-code'], force: true }))
    const second = await readFile(skillPath, 'utf-8')

    expect(second).toBe(first)
  })
})

describe('symlink defense', () => {
  it('refuses to overwrite a symlink at the destination (even with --force)', async () => {
    // A pre-existing symlink at the SKILL.md target shouldn't be followed by
    // the installer — that would clobber whatever the link points to.
    const skillDir = join(fakeHome, '.claude', 'skills', 'kode-review')
    await mkdir(skillDir, { recursive: true })
    const linkTarget = join(tmp, 'bystander.txt')
    await writeFile(linkTarget, 'SHOULD NOT BE TOUCHED')
    await symlink(linkTarget, join(skillDir, 'SKILL.md'))

    await expect(
      runAgentInstall(baseOpts({ agents: ['claude-code'], force: true })),
    ).rejects.toThrow(/Refusing to overwrite symlink/)

    // The link target must be untouched.
    expect(await readFile(linkTarget, 'utf-8')).toBe('SHOULD NOT BE TOUCHED')
  })

  it('refuses Cursor install when destination escapes the repo root via a symlinked parent', async () => {
    // Hostile repo layout: `<repoRoot>/.cursor/rules` is a symlink pointing
    // outside the repo. Installing into it would write outside the
    // user-trusted repo tree.
    const repoRoot = join(tmp, 'repo')
    const escape = join(tmp, 'escape')
    await mkdir(repoRoot, { recursive: true })
    await mkdir(escape, { recursive: true })
    await mkdir(join(repoRoot, '.cursor'), { recursive: true })
    await symlink(escape, join(repoRoot, '.cursor', 'rules'))

    await expect(
      runAgentInstall(baseOpts({ agents: ['cursor'], repoRoot })),
    ).rejects.toThrow(/Refusing to install outside the repository/)

    // The escape dir must not have received our file.
    expect(existsSync(join(escape, 'kode-review.mdc'))).toBe(false)
  })

  it('still installs Cursor cleanly when the parent dirs are honest', async () => {
    // Regression guard: the symlink check must not break the happy path.
    const repoRoot = join(tmp, 'repo')
    await mkdir(repoRoot, { recursive: true })

    const results = await runAgentInstall(
      baseOpts({ agents: ['cursor'], repoRoot }),
    )

    expect(results[0].outcome).toBe('written')
    expect(existsSync(join(repoRoot, '.cursor', 'rules', 'kode-review.mdc'))).toBe(true)
  })
})

describe('multi-agent install', () => {
  it('installs every target across all three agents in one call', async () => {
    const repoRoot = join(tmp, 'repo')
    await mkdir(repoRoot, { recursive: true })

    const results = await runAgentInstall(
      baseOpts({ agents: ['claude-code', 'codex', 'cursor'], repoRoot }),
    )

    // 2 (claude-code) + 1 (codex) + 1 (cursor) = 4 targets.
    expect(results).toHaveLength(4)
    expect(results.every((r) => r.outcome === 'written')).toBe(true)

    expect(existsSync(join(fakeHome, '.claude', 'skills', 'kode-review', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(fakeHome, '.claude', 'commands', 'kode-review.md'))).toBe(true)
    expect(existsSync(join(fakeHome, '.codex', 'prompts', 'kode-review.md'))).toBe(true)
    expect(existsSync(join(repoRoot, '.cursor', 'rules', 'kode-review.mdc'))).toBe(true)
  })
})
