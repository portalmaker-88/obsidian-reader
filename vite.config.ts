import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the build works under any subpath (e.g. GitHub Pages /<repo>/).
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
