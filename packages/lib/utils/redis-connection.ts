import type { RedisOptions } from 'ioredis';
import IORedis, { Cluster } from 'ioredis';

import { env } from './env';

/**
 * How a Redis URL breaks down into the pieces a cluster client needs.
 *
 * A standalone client takes the URL whole and does this itself. A cluster
 * client cannot: it wants the seed node separately from the credentials,
 * because the credentials are reused for every node it discovers.
 */
export type RedisConnectionParts = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
};

/**
 * Split a Redis URL into host, port and credentials.
 *
 * Uses the WHATWG parser rather than a regular expression because generated
 * passwords contain reserved characters. The password on the shared Valkey
 * cache contains both a colon and a closing bracket, either of which defeats a
 * naive split, and both of which this handles.
 *
 * @param url - A `redis://` or `rediss://` URL.
 */
export const parseRedisUrl = (url: string): RedisConnectionParts => {
  const parsed = new URL(url);

  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    // `rediss:` is the only thing that says TLS. An empty object is ioredis's
    // way of saying "TLS with the default trust store", which is what a
    // certificate issued by a public CA needs.
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
};

/**
 * The namespace every key this application writes sits under.
 *
 * The cache is shared with other TerraPay services and our user is scoped to
 * this namespace by an ACL pattern, so a key written outside it is refused
 * rather than merely untidy. Both the job queue and the watch heartbeat go
 * through here so that the two cannot drift apart.
 *
 * Braces have a meaning to Redis beyond grouping: they mark the part of a key
 * that decides its hash slot, which is what keeps a multi-key script from
 * failing with CROSSSLOT.
 */
export const redisKeyPrefix = (): string => env('NEXT_PRIVATE_REDIS_PREFIX') || 'documenso';

/**
 * Whether the configured Redis is cluster-mode.
 *
 * This cannot be sniffed cheaply and safely at startup, and getting it wrong in
 * either direction is fatal rather than degraded: a standalone client against a
 * cluster fails every multi-key script with CROSSSLOT, and a cluster client
 * against a standalone server fails on CLUSTER INFO. So it is declared.
 *
 * Off by default, because local development and CI both run a plain
 * `redis:7-alpine`.
 */
export const isRedisClusterMode = (): boolean => env('NEXT_PRIVATE_REDIS_CLUSTER') === 'true';

/**
 * Open a Redis connection that suits whichever kind of server is configured.
 *
 * @param url - The Redis URL.
 * @param options - Client options. Applied to the single client in standalone
 *   mode, and to every node's client in cluster mode.
 */
export const createRedisConnection = (url: string, options: RedisOptions = {}): IORedis | Cluster => {
  if (!isRedisClusterMode()) {
    return new IORedis(url, options);
  }

  const { host, port, ...credentials } = parseRedisUrl(url);

  return new Cluster([{ host, port }], {
    redisOptions: { ...credentials, ...options },
    // ElastiCache announces its nodes by private IP, while the TLS certificate
    // is issued for the configuration endpoint's hostname, so verification
    // fails on every discovered node unless the announced address is used
    // verbatim. This is the shape AWS documents for cluster mode with
    // in-transit encryption. It has not been exercised against our own cache,
    // because nothing outside the VPC can open a socket to it.
    dnsLookup: (address, callback) => callback(null, address),
  });
};
