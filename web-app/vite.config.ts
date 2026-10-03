import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        // CEU_API_PORT lets a second server run next to the app's own on 4747.
        target: `http://127.0.0.1:${process.env.CEU_API_PORT || 4747}`,
        changeOrigin: true,
      },
    },
  },
})
