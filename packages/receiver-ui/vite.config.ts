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
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
