import { env } from '../../utils/env';

/** Redis can be slow to fail. Nothing on a health path may hang behind it. */
export const REDIS_TIMEOUT_MS = 2_000;

type MinimalRedis = {
  ping: () => Promise<string>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<unknown>;
  status: string;
};

/**
 * One connection, shared by everything on the health path.
 *
 * A load balancer polls the health endpoint every few seconds and the watch
 * heartbeat lands on the same Redis. Opening a client per call would leak
 * sockets under exactly the load the endpoint exists to survive.
 */
let client: MinimalRedis | null = null;

/**
 * The construction in flight.
 *
 * Without this, two requests arriving before the first client exists both see
 * `null`, both await the dynamic import, and both construct a client. Only the
 * last is kept; the other keeps its socket open and keeps reconnecting, with
 * nothing holding a reference to close it. A load balancer polling this path
 * every few seconds is exactly the traffic that produces it.
 */
let connecting: Promise<MinimalRedis | null> | null = null;

/**
 * The shared Redis client, or null when the deployment has no Redis configured.
 *
 * Returning null rather than throwing is deliberate: whether a missing Redis is
 * a problem depends on the caller. A deployment running the local jobs provider
 * legitimately has none.
 */
export const getRedisClient = async (): Promise<MinimalRedis | null> => {
  if (client) {
    return client;
  }

  const redisUrl = env('NEXT_PRIVATE_REDIS_URL');

  if (!redisUrl) {
    return null;
  }

  if (!connecting) {
    connecting = (async () => {
      // Imported here rather than at the top so that ioredis, which this
      // module pulls in, stays out of bundles that never touch Redis.
      const { createRedisConnection } = await import('../../utils/redis-connection');

      client = createRedisConnection(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: REDIS_TIMEOUT_MS,
      });

      return client;
    })().finally(() => {
      connecting = null;
    });
  }

  return await connecting;
};

/**
 * Run a Redis call with a ceiling on how long it may take.
 *
 * @param operation - The call to bound.
 * @param timeoutMs - How long to allow.
 */
export const withTimeout = async <T>(operation: Promise<T>, timeoutMs = REDIS_TIMEOUT_MS): Promise<T> =>
  await Promise.race([
    operation,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no response within ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
