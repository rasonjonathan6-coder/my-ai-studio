import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_API_URL is the only frontend configuration value. It must never hold a
// secret: anything prefixed with VITE_ ships to the browser.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Hosts allowed to reach the dev server. Required when the dev server sits
    // behind a tunnel or reverse proxy (Vite rejects unknown Host headers).
    // Comma-separated; empty means only localhost is allowed.
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    proxy: {
      '/api': { target: process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
