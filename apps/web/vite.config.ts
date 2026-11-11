import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, the Vite server proxies API calls to the Koa server on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/demo-portal': 'http://localhost:3000',
    },
  },
});
