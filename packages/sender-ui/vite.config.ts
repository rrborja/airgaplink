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
    port: 5173,
    host: true,
    // Enable unrestricted hosts only for an explicit temporary public tunnel.
    allowedHosts: process.env.ALLOW_PUBLIC_TUNNEL === 'true'
      ? true
      : (process.env.SENDER_ALLOWED_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean),
    proxy: {
      // The sender browser reaches the hosted API through this proxy. No QR
      // payload routes exist on the API, so this carries short-code metadata only.
      '/api': {
        target: process.env.SENDER_API_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
