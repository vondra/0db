import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The HM3 compositor worker imports the decoder (which lazy-imports fzstd), so
  // its bundle is code-split — that needs ES module format (Vite's default
  // 'iife' worker format can't do code-splitting).
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the two biggest independent vendor stacks into their own chunks
        // so an app-code change doesn't bust their cache and they download in
        // parallel. deck is still needed for first paint (all layers default
        // on), so this is a caching win, not a smaller first load.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('maplibre-gl')) return 'maplibre'
          if (/deck\.gl|luma\.gl|math\.gl|wgsl_reflect|mjolnir/.test(id)) return 'deck'
        },
      },
    },
  },
})
