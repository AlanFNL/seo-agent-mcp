import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The integration suite hits real HTTP endpoints.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // SQLite connection state is process-global, so tests must share one worker.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
  },
});
