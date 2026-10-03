import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkJobsBackend } from './check-jobs-backend';

/**
 * The point of this check is to make a silent failure visible, so the tests are
 * about which state produces which signal rather than about Redis itself.
 */
const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

afterEach(() => {
  vi.resetModules();
});

describe('checkJobsBackend', () => {
  it('warns when the provider cannot run scheduled work at all', async () => {
    await withEnv({ NEXT_PRIVATE_JOBS_PROVIDER: undefined }, async () => {
      const result = await checkJobsBackend();

      expect(result.status).toBe('warning');
      expect(result.detail).toMatch(/bullmq/);
    });
  });

  it('warns rather than errors for inngest, which is a deliberate choice', async () => {
    await withEnv({ NEXT_PRIVATE_JOBS_PROVIDER: 'inngest' }, async () => {
      expect((await checkJobsBackend()).status).toBe('warning');
    });
  });

  it('errors when bullmq is asked for without a redis url, which is a broken deployment', async () => {
    await withEnv({ NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq', NEXT_PRIVATE_REDIS_URL: undefined }, async () => {
      const result = await checkJobsBackend();

      expect(result.status).toBe('error');
      expect(result.detail).toMatch(/NEXT_PRIVATE_REDIS_URL/);
    });
  });

  it('errors when redis is configured but unreachable', async () => {
    await withEnv(
      // Port chosen to have nothing listening on it.
      { NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq', NEXT_PRIVATE_REDIS_URL: 'redis://127.0.0.1:6399' },
      async () => {
        const result = await checkJobsBackend();

        expect(result.status).toBe('error');
        expect(result.detail).toMatch(/unreachable/);
      },
    );
  });
});
