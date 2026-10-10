import { defineConfig } from 'vitest/config';

// Vitest covers the scripts beside the Playwright suite, not the suite itself.
// Playwright's testDir is ./e2e and it matches *.spec.ts, so the two never
// collect each other's files.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
