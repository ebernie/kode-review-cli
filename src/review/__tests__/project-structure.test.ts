import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'

import {
  extractModifiedFilesFromDiff,
  formatProjectStructureContext,
  getProjectStructureContext,
  type ProjectStructureContext,
} from '../project-structure.js'

// ── extractModifiedFilesFromDiff ──────────────────────────────────────────

describe('extractModifiedFilesFromDiff', () => {
  it('returns [] for empty input', () => {
    expect(extractModifiedFilesFromDiff('')).toEqual([])
  })

  it('extracts a single file from a diff --git header', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234..5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`
    expect(extractModifiedFilesFromDiff(diff)).toEqual(['src/foo.ts'])
  })

  it('extracts multiple distinct files', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+++ b/src/a.ts
diff --git a/src/b.ts b/src/b.ts
+++ b/src/b.ts
diff --git a/src/c.ts b/src/c.ts
+++ b/src/c.ts
`
    expect(extractModifiedFilesFromDiff(diff)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('deduplicates files mentioned in both diff --git AND +++ headers', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
+++ b/src/x.ts
`
    expect(extractModifiedFilesFromDiff(diff)).toEqual(['src/x.ts'])
  })

  it('falls back to +++ headers when diff --git is absent (raw patch format)', () => {
    const diff = `--- a/legacy.py
+++ b/legacy.py
@@ -1 +1 @@
-x
+y
`
    expect(extractModifiedFilesFromDiff(diff)).toEqual(['legacy.py'])
  })

  it('skips /dev/null entries (file deletions)', () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
`
    const result = extractModifiedFilesFromDiff(diff)
    expect(result).toEqual(['src/gone.ts'])
    // Counter-assertion: /dev/null filter is explicitly validated, not just
    // implied by the toEqual.
    expect(result).not.toContain('/dev/null')
  })

  it('returns the new path on a rename diff (b/ side, not a/ side)', () => {
    // Git renames produce asymmetric a/b paths; the function must return the
    // post-rename name, not the pre-rename one.
    const diff = `diff --git a/src/old.ts b/src/renamed.ts
similarity index 100%
rename from src/old.ts
rename to src/renamed.ts
`
    const result = extractModifiedFilesFromDiff(diff)
    expect(result).toEqual(['src/renamed.ts'])
    expect(result).not.toContain('src/old.ts')
  })
})

// ── getProjectStructureContext (integration with a tmp git repo) ──────────

describe('getProjectStructureContext (integration)', () => {
  let repoRoot: string

  beforeAll(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'kode-project-structure-'))
    await execa('git', ['init', '-q'], { cwd: repoRoot })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    // Disable signing in case the user's global git config requires it
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot })

    await mkdir(join(repoRoot, 'src', 'lib'), { recursive: true })
    await mkdir(join(repoRoot, 'docs'), { recursive: true })
    await writeFile(join(repoRoot, 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(repoRoot, 'src', 'lib', 'util.ts'), 'export const y = 2\n')
    await writeFile(
      join(repoRoot, 'README.md'),
      '# My Project\n\nThis is a short description.\nIt explains what the project does.\n'
    )
    await writeFile(join(repoRoot, 'ARCHITECTURE.md'), '# Architecture\n\nLayered design.\n')
    await writeFile(join(repoRoot, '.gitignore'), 'node_modules/\n')
    await execa('git', ['add', '.'], { cwd: repoRoot })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot })
  })

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('returns a context with a directory tree containing tracked files', async () => {
    const ctx = await getProjectStructureContext(repoRoot, '')
    expect(ctx.directoryTree).toBeTruthy()
    expect(ctx.directoryTree).toContain('src/')
    expect(ctx.directoryTree).toContain('index.ts')
    expect(ctx.directoryTree).toContain('lib/')
    expect(ctx.directoryTree).toContain('util.ts')
    // Baseline exclusion guard: even without a node_modules dir present,
    // confirm the tree didn't accidentally include excluded markers.
    expect(ctx.directoryTree).not.toContain('node_modules')
  })

  it('extracts a README summary capped at 500 chars', async () => {
    const ctx = await getProjectStructureContext(repoRoot, '')
    expect(ctx.readmeSummary).toBeTruthy()
    expect(ctx.readmeSummary).toContain('My Project')
    expect((ctx.readmeSummary as string).length).toBeLessThanOrEqual(500)
  })

  it('extracts ARCHITECTURE.md content', async () => {
    const ctx = await getProjectStructureContext(repoRoot, '')
    expect(ctx.architectureDoc).toBeTruthy()
    expect(ctx.architectureDoc).toContain('Architecture')
    expect(ctx.architectureDoc).toContain('Layered design')
  })

  it('omits README and architecture when neither exists', async () => {
    const bareRoot = await mkdtemp(join(tmpdir(), 'kode-no-readme-'))
    await execa('git', ['init', '-q'], { cwd: bareRoot })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: bareRoot })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: bareRoot })
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: bareRoot })
    await writeFile(join(bareRoot, 'x.ts'), 'export const x = 1\n')
    await execa('git', ['add', '.'], { cwd: bareRoot })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: bareRoot })
    try {
      const ctx = await getProjectStructureContext(bareRoot, '')
      expect(ctx.readmeSummary).toBeUndefined()
      expect(ctx.architectureDoc).toBeUndefined()
    } finally {
      await rm(bareRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('marks modified files with a trailing `*` in the rendered tree', async () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-x
+y
`
    const ctx = await getProjectStructureContext(repoRoot, diff)
    // Pin the exact render format (renderTree uses ' *' — single space + star).
    expect(ctx.directoryTree).toMatch(/index\.ts \*/)
    // A file NOT in the diff must not be marked.
    expect(ctx.directoryTree).not.toMatch(/util\.ts \*/)
  })

  it('omits .gitignored directories from the tree', async () => {
    // Use an isolated repo so the shared beforeAll fixture stays pristine
    // for subsequent tests (no test-order coupling).
    const isolated = await mkdtemp(join(tmpdir(), 'kode-gitignored-'))
    await execa('git', ['init', '-q'], { cwd: isolated })
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: isolated })
    await execa('git', ['config', 'user.name', 'Test'], { cwd: isolated })
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: isolated })
    await writeFile(join(isolated, '.gitignore'), 'node_modules/\n')
    await mkdir(join(isolated, 'src'), { recursive: true })
    await writeFile(join(isolated, 'src', 'x.ts'), 'export const x = 1\n')
    await execa('git', ['add', '.'], { cwd: isolated })
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: isolated })
    await mkdir(join(isolated, 'node_modules', 'foo'), { recursive: true })
    await writeFile(join(isolated, 'node_modules', 'foo', 'pkg.json'), '{}')
    try {
      const ctx = await getProjectStructureContext(isolated, '')
      expect(ctx.directoryTree).not.toContain('node_modules')
      // Counter-assertion: tracked files still appear, proving the tree
      // wasn't empty for an unrelated reason.
      expect(ctx.directoryTree).toContain('src/')
    } finally {
      await rm(isolated, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ── formatProjectStructureContext (pure) ──────────────────────────────────

describe('formatProjectStructureContext', () => {
  it('emits a ### Directory Structure section in a fenced code block', () => {
    const ctx: ProjectStructureContext = {
      directoryTree: 'root/\n├── src/\n│   └── x.ts\n',
    }
    const out = formatProjectStructureContext(ctx)
    expect(out).toContain('### Directory Structure')
    expect(out).toContain('```')
    expect(out).toContain('└── x.ts')
    // Pin the exact italicized form (formatProjectStructureContext emits the
    // sentence wrapped in single asterisks for markdown italics).
    expect(out).toContain('*Files marked with `*` are modified in this change.*')
  })

  it('includes the README section only when readmeSummary is set', () => {
    const withReadme = formatProjectStructureContext({
      directoryTree: 'r/',
      readmeSummary: 'Hello world.',
    })
    expect(withReadme).toContain('### Project README Summary')
    expect(withReadme).toContain('Hello world.')

    const without = formatProjectStructureContext({ directoryTree: 'r/' })
    expect(without).not.toContain('### Project README Summary')
  })

  it('includes the Architecture section only when architectureDoc is set', () => {
    const withArch = formatProjectStructureContext({
      directoryTree: 'r/',
      architectureDoc: 'Layered.',
    })
    expect(withArch).toContain('### Architecture Documentation')
    expect(withArch).toContain('Layered.')

    const without = formatProjectStructureContext({ directoryTree: 'r/' })
    expect(without).not.toContain('### Architecture Documentation')
  })
})
