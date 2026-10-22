import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  // Named pipes/sockets need real processes, not worker threads.
  test: { pool: 'forks' },
  resolve: {
    alias: {
      '@dm/engine': src('../../packages/engine/src/index.ts'),
      '@dm/store': src('../../packages/store/src/index.ts'),
      '@dm/scheduler': src('../../packages/scheduler/src/index.ts'),
      '@dm/media': src('../../packages/media/src/index.ts'),
    },
  },
});
