import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { xdrivePDFWorker } from './pdf-worker/vite-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), xdrivePDFWorker()],
  build: {
    outDir: '../internal/server/static',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'core-vendor', test: /node_modules[\\/](?:react|react-dom|react-router|scheduler|@tanstack|@radix-ui|lucide-react|zustand)[\\/]/ }],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
})
