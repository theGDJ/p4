import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

/**
 * The browser never talks to the API directly: `/api` is proxied to the backend
 * here, so the client only ever uses same-origin relative URLs. That is what makes
 * the app work behind the preview proxy (and behind nginx in Compose) without
 * hardcoding a host.
 */
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    // The preview host is dynamic ({port}-{sandboxId}.e2b.app); allow that suffix only.
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Do not forward the browser Origin: the proxy is a server-to-server hop, and
        // forwarding it would make the API's CORS allowlist reject our own dev calls.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
