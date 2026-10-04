import { defineConfig } from 'vite';

// The dev/preview server runs behind a reverse proxy on an arbitrary
// *.e2b.app host, so we have to disable Vite's host allow-list checks and
// make sure the HMR websocket is reachable through that same proxy (wss,
// same host, default port 443) instead of trying to talk to localhost.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    hmr: {
      clientPort: 443,
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
  },
});
