import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  // Relative asset paths so the build works under any subpath (e.g. GitHub Pages /<repo>/).
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
