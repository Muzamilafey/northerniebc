import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setupEnv.ts'],
    // Integration tests share one database per worker file; run files sequentially
    // so transactional assertions are deterministic.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000
  }
});
