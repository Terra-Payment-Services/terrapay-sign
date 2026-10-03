import { Cluster, Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { createRedisConnection, isRedisClusterMode, parseRedisUrl, redisKeyPrefix } from './redis-connection';

/**
 * The cache this runs against is shared, cluster-mode and TLS-only, and none of
 * those three is true of the Redis that local development and CI run. So the
 * behaviour worth pinning is which kind of client comes back and whether the
 * credentials survive the trip, not anything about Redis itself.
 */

const STANDALONE = 'redis://127.0.0.1:6379';

/**
 * A made-up password with the same awkward shape as the generated one: a colon
 * and a closing bracket in the middle. Never the real value; that lives in
 * Secrets Manager and nowhere else.
 */
const AWKWARD_PASSWORD = 'Xq4)w]7:Zb2Tn8Kd';
const AWKWARD = `rediss://app-user:${AWKWARD_PASSWORD}@cache.example.com:6379`;

const opened: Array<Redis | Cluster> = [];

const open = (url: string) => {
  const client = createRedisConnection(url, { lazyConnect: true });
  opened.push(client);
  return client;
};

afterEach(async () => {
  delete process.env.NEXT_PRIVATE_REDIS_CLUSTER;
  delete process.env.NEXT_PRIVATE_REDIS_PREFIX;

  while (opened.length > 0) {
    await opened
      .pop()
      ?.quit()
      .catch(() => undefined);
  }
});

describe('parseRedisUrl', () => {
  it('keeps a password containing a colon and a bracket intact', () => {
    // Splitting on ':' truncates at the first colon and silently authenticates as the
    // wrong thing, so this is the case that matters.
    expect(parseRedisUrl(AWKWARD)).toMatchObject({
      host: 'cache.example.com',
      port: 6379,
      username: 'app-user',
      password: AWKWARD_PASSWORD,
    });
  });

  it('decodes a percent-encoded password', () => {
    expect(parseRedisUrl('rediss://user:p%40ss%2Fword@host:6379').password).toBe('p@ss/word');
  });

  it('asks for TLS only when the scheme says so', () => {
    expect(parseRedisUrl(AWKWARD).tls).toEqual({});
    expect(parseRedisUrl(STANDALONE).tls).toBeUndefined();
  });

  it('defaults the port when the url leaves it out', () => {
    expect(parseRedisUrl('redis://cache.example.com').port).toBe(6379);
  });

  it('reports no credentials for a url that carries none', () => {
    expect(parseRedisUrl(STANDALONE)).toMatchObject({ username: undefined, password: undefined });
  });
});

describe('isRedisClusterMode', () => {
  it('is off unless asked for, because local and CI run a standalone server', () => {
    expect(isRedisClusterMode()).toBe(false);

    process.env.NEXT_PRIVATE_REDIS_CLUSTER = 'false';
    expect(isRedisClusterMode()).toBe(false);
  });

  it('is on only for the exact string, not for anything truthy', () => {
    process.env.NEXT_PRIVATE_REDIS_CLUSTER = 'true';
    expect(isRedisClusterMode()).toBe(true);

    process.env.NEXT_PRIVATE_REDIS_CLUSTER = '1';
    expect(isRedisClusterMode()).toBe(false);
  });
});

describe('redisKeyPrefix', () => {
  it('uses the configured namespace, which the shared cache scopes our user to', () => {
    process.env.NEXT_PRIVATE_REDIS_PREFIX = '{terrapay-sign}';
    expect(redisKeyPrefix()).toBe('{terrapay-sign}');
  });

  it('falls back to the upstream default, which local and CI rely on', () => {
    expect(redisKeyPrefix()).toBe('documenso');
  });
});

describe('createRedisConnection', () => {
  it('opens a standalone client by default', async () => {
    const client = await open(STANDALONE);

    expect(client).toBeInstanceOf(Redis);
    expect(client).not.toBeInstanceOf(Cluster);
  });

  it('opens a cluster client when the deployment declares one', async () => {
    process.env.NEXT_PRIVATE_REDIS_CLUSTER = 'true';

    const client = await open(AWKWARD);

    expect(client).toBeInstanceOf(Cluster);
  });

  it('carries the credentials and TLS onto every node in cluster mode', async () => {
    process.env.NEXT_PRIVATE_REDIS_CLUSTER = 'true';

    // The cluster client reuses these for each node it discovers, so losing
    // them here means authentication failures against nodes two and three
    // while the seed node works.
    const client = (await open(AWKWARD)) as Cluster;

    expect(client.options.redisOptions).toMatchObject({
      username: 'app-user',
      password: AWKWARD_PASSWORD,
      tls: {},
    });
  });
});
