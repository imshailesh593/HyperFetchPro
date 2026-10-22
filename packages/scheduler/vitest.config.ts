import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@dm/engine': src('../engine/src/index.ts'),
      '@dm/store': src('../store/src/index.ts'),
    },
  },
});
