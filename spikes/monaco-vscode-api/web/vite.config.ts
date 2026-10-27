import { defineConfig } from 'vite'
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'

// Relative base: the page is served by the harness's scheme handler (kunj://app/), not a server.
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 100000,
    outDir: 'dist',
    emptyOutDir: true,
  },
  worker: { format: 'es' },
  optimizeDeps: { esbuildOptions: { plugins: [importMetaUrlPlugin] } },
})
