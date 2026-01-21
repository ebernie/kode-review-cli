import { defineConfig } from 'tsup'
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export default defineConfig({
  entry: ['src/index.ts'],
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
    const files = ['compose.yaml', 'Dockerfile', 'main.py', 'indexer.py', 'requirements.txt', '.env.template']

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
