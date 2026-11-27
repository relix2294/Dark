import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Единый конфиг Vite для всех клиентов: React, PWA, прокси /api → локальный API.
 * base совпадает с путём за Caddy (deploy/Caddyfile): /store, /office, /kds, /picker, /courier.
 */
export function defineAppConfig(o: { name: string; title: string; base: string; port: number; pwa?: boolean }): UserConfig {
  return defineConfig({
    base: o.base,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [],
        manifest: {
          name: o.title,
          short_name: o.title.split('·').pop()?.trim() ?? o.name,
          lang: 'ru',
          start_url: o.base,
          scope: o.base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#111318',
          theme_color: '#111318',
          icons: [{ src: `${o.base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        },
        workbox: {
          // API никогда не кэшируем: истина на сервере; офлайн-очередь действий — в приложении (IndexedDB)
          navigateFallbackDenylist: [/^\/api/, /^\/docs/],
          runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
        },
        disable: o.pwa === false,
      }),
    ],
    server: {
      port: o.port,
      proxy: { '/api': { target: process.env['API_URL'] ?? 'http://127.0.0.1:3000', changeOrigin: true } },
    },
    build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  });
}
