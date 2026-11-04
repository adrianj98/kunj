import { defineConfig } from 'vite'
import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'

// The page is served by AppSchemeHandler as kunj://app/ (not a server): relative base, ES workers,
// no inlined assets (the wasm and grammar files load by URL). Output: Resources/web (ignored by git).
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 100000,
    outDir: '../Resources/web',
    emptyOutDir: true,
  },
  worker: { format: 'es' },
  optimizeDeps: { esbuildOptions: { plugins: [importMetaUrlPlugin] } },
})
