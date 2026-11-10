import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@stream3d/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@stream3d/compiler': fileURLToPath(new URL('./packages/compiler/src/index.ts', import.meta.url)),
      '@stream3d/vite': fileURLToPath(new URL('./packages/vite/src/index.ts', import.meta.url)),
      'stream3d': fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
