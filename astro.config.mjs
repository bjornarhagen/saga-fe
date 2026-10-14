import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // Small module chunks must stay external under script-src 'self'.
  vite: { build: { assetsInlineLimit: 0 } },
  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
});
