import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In production the FastAPI backend serves this built FE at the same origin, so the
// app uses relative /api and /ws URLs. In dev (Vite), proxy those to FastAPI so the
// same relative URLs work — no CORS, no per-env base. Change this if the backend
// runs elsewhere.
const API_TARGET = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  // Relative base so a built bundle works from any static path (or file://).
  base: './',
  server: {
    port: 5183,
    open: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
