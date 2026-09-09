import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // DB tests share one Postgres; run files sequentially so TRUNCATE in one
    // file cannot pull the rug out from another.
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
