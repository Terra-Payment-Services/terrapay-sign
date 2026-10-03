import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The deployment this runs on shares its cache with other services and scopes
 * our user to one key pattern with an ACL. A key written outside that pattern
 * is refused outright, so where the heartbeat lives is behaviour rather than
 * housekeeping, and it is what these tests are about.
 */

const store = new Map<string, string>();
const reads: string[] = [];
const writes: string[] = [];

vi.mock('./redis-client', () => ({
  REDIS_TIMEOUT_MS: 2_000,
  withTimeout: <T>(operation: Promise<T>): Promise<T> => operation,
  getRedisClient: (): Promise<unknown> =>
    Promise.resolve({
      status: 'ready',
      ping: (): Promise<string> => Promise.resolve('PONG'),
      get: (key: string): Promise<string | null> => {
        reads.push(key);

        // The shared cache answers this way for a key outside the ACL pattern,
        // rather than returning nothing, so a misplaced key is loud.
        if (!key.startsWith('{terrapay-sign}:')) {
          return Promise.reject(new Error('NOPERM No permissions to access a key'));
        }

        return Promise.resolve(store.get(key) ?? null);
      },
      set: (key: string, value: string): Promise<string> => {
        writes.push(key);
        store.set(key, value);

        return Promise.resolve('OK');
      },
    }),
}));

afterEach(() => {
  delete process.env.NEXT_PRIVATE_REDIS_PREFIX;
  store.clear();
  reads.length = 0;
  writes.length = 0;
  vi.resetModules();
});

describe('the heartbeat key', () => {
  it('sits under the configured prefix, so the ACL admits it', async () => {
    process.env.NEXT_PRIVATE_REDIS_PREFIX = '{terrapay-sign}';

    const { checkWatchHeartbeat, recordWatchHeartbeat } = await import('./upstream-watch-heartbeat');

    await recordWatchHeartbeat({ at: new Date().toISOString(), ok: true });
    const result = await checkWatchHeartbeat();

    expect(writes).toEqual(['{terrapay-sign}:upstream-watch:last-run']);
    expect(reads).toEqual(['{terrapay-sign}:upstream-watch:last-run']);
    expect(result.status).toBe('ok');
  });

  it('falls back to the upstream default when no prefix is configured', async () => {
    const { recordWatchHeartbeat } = await import('./upstream-watch-heartbeat');

    await recordWatchHeartbeat({ at: new Date().toISOString(), ok: true });

    expect(writes).toEqual(['documenso:upstream-watch:last-run']);
  });

  it('reports a refused key as a warning rather than rejecting', async () => {
    // What the deployed service actually did on 2026-09-22, when the key was
    // unprefixed: the endpoint has no try of its own, so a rejection here
    // answers 500 and ECS replaces a healthy signing service.
    const { checkWatchHeartbeat } = await import('./upstream-watch-heartbeat');

    const result = await checkWatchHeartbeat();

    expect(result.status).toBe('warning');
    expect(result.detail).toMatch(/NOPERM/);
    expect(result.lastRunAt).toBeNull();
  });
});
