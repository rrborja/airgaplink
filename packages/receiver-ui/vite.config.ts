import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@qrcopy/optical-core': path.resolve(__dirname, '../optical-core/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    host: true,
    // Over a phone tunnel, a transient HMR socket reconnect causes Vite to
    // reload the page and stop the camera. Opt in only for local development.
    hmr: process.env.RECEIVER_HMR === 'true',
    proxy: {
      '/api/optical-relay': 'http://localhost:3002',
      '/optical-relay': { target: 'ws://localhost:3002', ws: true },
    },
    allowedHosts: process.env.ALLOW_PUBLIC_TUNNEL === 'true'
      ? true
      : (process.env.RECEIVER_ALLOWED_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean),
  },
  preview: {
    port: 5174,
    host: true,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
