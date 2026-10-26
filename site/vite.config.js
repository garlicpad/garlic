import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Local dev talks to the engine directly (or through an ssh tunnel), the same /api path the
// site's Vercel rewrite takes in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    proxy: { '/api': { target: process.env.ENGINE_URL || 'http://127.0.0.1:3214', changeOrigin: true } },
  },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
})
