import macrosPlugin from 'vite-plugin-babel-macros';
import { defineConfig } from 'vitest/config';

/**
 * Mutation testing of the directory sync's account matching. Only the
 * failure-mode suite runs, so the score is that suite's alone.
 */
export default defineConfig({
  plugins: [macrosPlugin()],
  test: {
    include: ['server-only/directory/reconcile-directory-access.failure-modes.test.ts'],
  },
});
