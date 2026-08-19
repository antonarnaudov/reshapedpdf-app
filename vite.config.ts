import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// base './' so the built app also works from file:// inside Electron
export default defineConfig({
  base: './',
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps', dest: 'pdf-assets' },
        { src: 'node_modules/pdfjs-dist/standard_fonts', dest: 'pdf-assets' },
      ],
    }),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    // dev-only: the packaged Electron app reaches a local model through a native
    // proxy (no CORS); in the browser we forward same-origin to avoid CORS.
    // client.ts::devProxyUrl maps localhost:1234 → /lms and localhost:11434 → /oll.
    proxy: {
      '/lms': { target: 'http://localhost:1234', changeOrigin: true, rewrite: (p) => p.replace(/^\/lms/, '') },
      '/oll': { target: 'http://localhost:11434', changeOrigin: true, rewrite: (p) => p.replace(/^\/oll/, '') },
    },
  },
})
