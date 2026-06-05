import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the local backend (built later). Until then the
// app falls back to the mock layer (see src/api/client.js) so the UI is fully
// browsable without a backend running.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:5060',
        changeOrigin: true,
      },
    },
  },
});
