import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],
  },
})
