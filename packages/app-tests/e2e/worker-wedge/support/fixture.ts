/**
 * Fixtures for the specs: a Redis Cluster of the test's own, the provider
 * children it starts, and the producer queues it opens, every one of them torn
 * down and its output attached whether the test passes or fails.
 *
 * Nothing here changes process.env. The cleanup-script project depends on this
 * one, and Playwright hands a dependency's final worker environment on.
 */
import { test as base, expect } from '@playwright/test';

import {
  attachProviderEvidence,
  type OpenQueue,
  openQueue,
  type ProviderOptions,
  type ProviderProcess,
  startProvider,
} from './provider-process';
import { type RedisCluster, startRedisCluster } from './redis-cluster';

type Wedge = {
  cluster: RedisCluster;
  /** Starts a provider child against this cluster and keeps it for teardown. */
  provider: (options?: Omit<ProviderOptions, 'cluster'>) => Promise<ProviderProcess>;
  /** A producer on the given prefix, closed at teardown. */
  queue: (prefix: string) => OpenQueue;
};

export const test = base.extend<{ wedge: Wedge }>({
  // biome-ignore lint/correctness/noEmptyPattern: required by the fixture signature
  wedge: async ({}, use, testInfo) => {
    const cluster = await startRedisCluster(
      testInfo.title
        .replace(/[^a-z0-9]+/gi, '-')
        .slice(0, 24)
        .toLowerCase(),
    );
    const providers: ProviderProcess[] = [];
    const queues: OpenQueue[] = [];

    try {
      await use({
        cluster,
        provider: async (options = {}) => {
          const provider = await startProvider({ cluster, ...options });

          providers.push(provider);

          return provider;
        },
        queue: (prefix) => {
          const queue = openQueue(cluster, prefix);

          queues.push(queue);

          return queue;
        },
      });
    } finally {
      for (const [index, provider] of providers.entries()) {
        await provider.kill();
        await attachProviderEvidence(testInfo, provider, `provider-${index}`);
      }

      for (const queue of queues) {
        await queue.close();
      }

      await testInfo.attach('redis-cluster.log', { body: await cluster.logs(), contentType: 'text/plain' });
      await cluster.teardown();
    }
  },
});

export { expect };
