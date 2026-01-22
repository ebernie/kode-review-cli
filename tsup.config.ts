import { defineConfig } from 'tsup'
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/mcp/kode-review-mcp.ts', // MCP server entry point for agentic mode
  ],
  format: ['esm'],
  target: 'node18',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  shims: true,
  onSuccess: async () => {
    // Copy Docker assets to dist/indexer/docker/
    const srcDir = 'src/indexer/docker'
    const destDir = 'dist/indexer/docker'
    const files = [
      'compose.yaml',
      'Dockerfile',
      'main.py',
      'indexer.py',
      'requirements.txt',
      '.env.template',
      // Additional Python modules for indexer functionality
      'import_graph.py',
      'call_graph.py',
      'ast_chunker.py',
      'bm25.py',
      'hybrid.py',
      'incremental.py',
      'cocoindex_flow.py',
      'config_parser.py',
      'migrate.py',
      'verify_export.py',
      'schema.sql',
    ]

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true })
    }

    for (const file of files) {
      const src = join(srcDir, file)
      const dest = join(destDir, file)
      if (existsSync(src)) {
        copyFileSync(src, dest)
        console.log(`Copied ${src} -> ${dest}`)
      }
    }
  },
})
