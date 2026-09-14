import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The interface builds into web/dist, which the studio server serves.
 *
 * ONE ORIGIN IN PRODUCTION, TWO IN DEVELOPMENT. Built, the app is static files
 * the API server hands out, so there is no CORS and the session cookie just
 * works. In development Vite serves the app on its own port for hot reload and
 * proxies /api back to the server - which keeps the cookie same-origin from the
 * browser's point of view, and is the only reason a SameSite=Strict session
 * survives a dev setup at all.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4318,
    proxy: {
      '/api': {
        target: process.env.FOUNDRY_API ?? 'http://127.0.0.1:4317',
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
