import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['brand/logo.svg', 'favicon.ico'],
      manifest: {
        name: 'The Northern IEBC',
        short_name: 'Northern IEBC',
        description: 'Independent election monitoring and county accountability for Garissa, Mandera, Wajir, Isiolo and Marsabit. Not affiliated with the IEBC.',
        theme_color: '#0b1f3a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
        // API responses are never cached by the service worker: results and figures must be live.
        runtimeCaching: []
      }
    })
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000', '/socket.io': { target: 'http://localhost:4000', ws: true } }
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], setupFiles: ['src/test/setup.ts'] }
});
