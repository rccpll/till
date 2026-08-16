import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Precache the wallet shell only. The desktop-only parsing stack
      // (pdfjs worker, zxing wasm, Upload/parse chunks) is megabytes the
      // phone never needs offline — upload requires the network anyway.
      workbox: {
        globPatterns: ['**/*.{js,css,html,png}'],
        globIgnores: ['**/pdf.worker*', '**/parseVoucherPdf*', '**/Upload-*', '**/zxing_reader*'],
        navigateFallback: '/index.html',
        // API calls must never be served by the SW cache: the app layer does
        // its own state caching in IndexedDB (stale-while-revalidate).
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      manifest: {
        name: 'Till',
        short_name: 'Till',
        description: 'Shared gift-voucher wallet',
        display: 'standalone',
        start_url: '/',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      // `npm run dev` (vite) + `wrangler pages dev dist` (API on :8788).
      // DEV_ACCESS_TOKEN lets local dev satisfy the JWT check that Cloudflare
      // Access performs in production (see .dev.vars / tests for the keypair).
      '/api': {
        target: 'http://127.0.0.1:8788',
        headers: process.env.DEV_ACCESS_TOKEN
          ? { 'Cf-Access-Jwt-Assertion': process.env.DEV_ACCESS_TOKEN }
          : undefined,
      },
    },
  },
});
