import { defineConfig } from 'tsup'
import { copyFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))

export default defineConfig({
  define: {
    'PKG_VERSION': JSON.stringify(pkg.version),
  },
  entry: [
    'src/index.ts',
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

    // Copy reviewer templates to dist/templates/.
    //
    // Path resolution: in source, registry.ts lives at src/reviewers/ and
    // resolves templates relative to its own __dirname (→ src/reviewers/
    // templates/). After bundling, tsup collapses everything into
    // dist/index.js, so the same __dirname resolution lands on dist/, and
    // the registry looks for `dist/templates/`. We must copy here.
    const reviewerSrc = 'src/reviewers/templates'
    const reviewerDest = 'dist/templates'
    if (existsSync(reviewerSrc)) {
      if (!existsSync(reviewerDest)) {
        mkdirSync(reviewerDest, { recursive: true })
      }
      for (const entry of readdirSync(reviewerSrc)) {
        if (!entry.endsWith('.md')) continue
        const src = join(reviewerSrc, entry)
        const dest = join(reviewerDest, entry)
        copyFileSync(src, dest)
        console.log(`Copied ${src} -> ${dest}`)
      }
    }

    // Copy agent-install assets to dist/agent-install/assets/.
    //
    // Same pattern as reviewer templates: registry.ts resolves the bundled
    // assets dir relative to its own __dirname, which lands on dist/ after
    // tsup bundles everything into dist/index.js.
    const agentAssetsSrc = 'src/agent-install/assets'
    const agentAssetsDest = 'dist/agent-install/assets'
    if (existsSync(agentAssetsSrc)) {
      if (!existsSync(agentAssetsDest)) {
        mkdirSync(agentAssetsDest, { recursive: true })
      }
      for (const entry of readdirSync(agentAssetsSrc)) {
        if (!entry.endsWith('.md')) continue
        const src = join(agentAssetsSrc, entry)
        const dest = join(agentAssetsDest, entry)
        copyFileSync(src, dest)
        console.log(`Copied ${src} -> ${dest}`)
      }
    }
  },
})
