import fs from 'node:fs';
import type { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import type { Cluster } from 'ioredis';

import { env } from '../../utils/env';

/**
 * Detects a BullMQ Worker that has stopped taking jobs and exits the process,
 * so that ECS replaces the task.
 *
 * After a Redis Cluster outage, bullmq 5.76.7 can leave the Worker's private
 * blocking client ended for good, or parked on a promise that never settles.
 * The Worker still reports itself running and logs nothing, while every other
 * client reconnects. Nothing in the library recovers from either, so this
 * watches from outside it: a stall check that reads the queue, and a fast path
 * for a blocking client that ends.
 */

const READ_TIMEOUT_MS = 5_000;

const SETTINGS = {
  stallSeconds: { variable: 'NEXT_PRIVATE_JOBS_STALL_SECONDS', fallback: 60 },
  checkSeconds: { variable: 'NEXT_PRIVATE_JOBS_STALL_CHECK_SECONDS', fallback: 15 },
  drainSeconds: { variable: 'NEXT_PRIVATE_JOBS_STALL_DRAIN_SECONDS', fallback: 30 },
} as const;

export type WatchdogSettings = Record<keyof typeof SETTINGS, number>;

type WatchdogOptions = {
  queue: Queue;
  worker: Worker;
  concurrency: number;
  settings: WatchdogSettings;
  /** Jobs the provider has started and not yet finished. */
  held: () => number;
};

type OverdueJob = { id: string; name: string; dueAt: number };

declare global {
  // eslint-disable-next-line no-var
  var __documenso_worker_wedged_handler__: (() => void) | undefined;
  // eslint-disable-next-line no-var
  var __documenso_worker_watchdogs__: Set<() => void> | undefined;
}

const runningWatchdogs = () => {
  globalThis.__documenso_worker_watchdogs__ ??= new Set();

  return globalThis.__documenso_worker_watchdogs__;
};

/**
 * Stops every watchdog in the process at once. The server calls it when any
 * shutdown begins, since the job provider stays open until the open requests
 * have finished, and a watchdog left running could report a wedge meanwhile.
 */
export const stopWorkerWatchdogs = () => {
  for (const stop of [...runningWatchdogs()]) {
    stop();
  }
};

/**
 * Lets the server run its graceful shutdown, with exit code 1, in place of an
 * immediate exit. Kept on globalThis because the server is bundled more than
 * once, and the provider and the entry point may hold different copies of this
 * module.
 */
export const setWorkerWedgedHandler = (handler: () => void) => {
  globalThis.__documenso_worker_wedged_handler__ = handler;
};

const MAX_SECONDS = 86_400;

type CheckResult = { kind: 'suppressed' } | { kind: 'clear' } | { kind: 'overdue'; job: OverdueJob };

/**
 * Reads the three settings. Each must be a whole number of seconds from 1 to
 * 86400; anything else throws, naming the variable, in every environment. Node
 * clamps a timer above about 24.8 days to 1 ms, hence the ceiling.
 */
export const readWatchdogSettings = (): WatchdogSettings => {
  const read = ({ variable, fallback }: { variable: string; fallback: number }) => {
    const value = env(variable);

    if (value === undefined) {
      return fallback;
    }

    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_SECONDS) {
      throw new Error(`[JOBS]: ${variable} must be a whole number of seconds from 1 to ${MAX_SECONDS}, got "${value}"`);
    }

    return Number(value);
  };

  return {
    stallSeconds: read(SETTINGS.stallSeconds),
    checkSeconds: read(SETTINGS.checkSeconds),
    drainSeconds: read(SETTINGS.drainSeconds),
  };
};

/** Resolves to the promise's value, or to `undefined` once `ms` has passed. */
const within = async <T>(promise: Promise<T>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the watchdog. The returned `stop` is called by the provider's
 * `close()`, after which neither path logs or exits.
 */
export const startWorkerWatchdog = ({ queue, worker, concurrency, settings, held }: WatchdogOptions) => {
  const checkMs = settings.checkSeconds * 1000;
  const stallMs = settings.stallSeconds * 1000;

  let isStopped = false;
  let isDraining = false;
  let isChecking = false;
  let wedgedAt: number | null = null;
  let pingTimer: NodeJS.Timeout | undefined;
  let blockingClient: IORedis | Cluster | undefined;
  let reader: IORedis | Cluster | undefined;

  const client = async () => (await queue.client) as IORedis | Cluster;

  /**
   * The stall check's own connection. With no offline queue and a command
   * timeout, every read settles within about READ_TIMEOUT_MS, whatever state the
   * Queue's connection is in, so one stuck read cannot blind the watchdog.
   */
  const readClient = async () => {
    if (!reader) {
      const base = await client();

      reader =
        'nodes' in base && typeof base.nodes === 'function'
          ? base.duplicate([], {
              enableOfflineQueue: false,
              redisOptions: { ...base.options.redisOptions, commandTimeout: READ_TIMEOUT_MS },
            })
          : (base as IORedis).duplicate({ enableOfflineQueue: false, commandTimeout: READ_TIMEOUT_MS });

      reader.on('error', () => undefined);
    }

    return reader;
  };

  const jobFields = async (redis: IORedis | Cluster, id: string) => {
    const [timestamp, name] = await redis.hmget(queue.toKey(id), 'timestamp', 'name');

    return { id, name: name ?? 'unknown', timestamp: Number(timestamp) };
  };

  /**
   * The job that has been due longest, from `wait` (its tail is the next job
   * taken, and the oldest, since the provider never enqueues `lifo`), the first
   * 100 members of `prioritized` (the provider never sets a priority), and the
   * head of `delayed`, whose score is the due time times 0x1000.
   */
  const mostOverdue = async (redis: IORedis | Cluster): Promise<OverdueJob | null> => {
    const [waitTail, prioritized, delayedHead] = await Promise.all([
      redis.lindex(queue.keys.wait, -1),
      redis.zrange(queue.keys.prioritized, 0, 99),
      redis.zrange(queue.keys.delayed, 0, 0, 'WITHSCORES'),
    ]);

    const waiting = await Promise.all(
      [waitTail, ...prioritized]
        .filter((id): id is string => Boolean(id))
        .map(async (id) => await jobFields(redis, id)),
    );

    const candidates: OverdueJob[] = waiting.map((job) => ({ id: job.id, name: job.name, dueAt: job.timestamp }));

    if (delayedHead.length === 2) {
      const job = await jobFields(redis, delayedHead[0]);

      candidates.push({ id: job.id, name: job.name, dueAt: Math.floor(Number(delayedHead[1]) / 0x1000) });
    }

    const valid = candidates.filter((job) => Number.isFinite(job.dueAt));

    if (valid.length === 0) {
      return null;
    }

    return valid.reduce((oldest, job) => (job.dueAt < oldest.dueAt ? job : oldest));
  };

  /**
   * Whether the queue is legitimately holding jobs back: paused, rate-limited
   * (as BullMQ's getRateLimitTTL.lua judges it), or at its global concurrency.
   * Read directly, so that it goes over the stall check's own connection.
   */
  const isHeldBack = async (redis: IORedis | Cluster) => {
    const [[paused, globalConcurrency, rateLimitMax], limited, limiterTtl, active] = await Promise.all([
      redis.hmget(queue.keys.meta, 'paused', 'concurrency', 'max'),
      redis.get(queue.keys.limiter),
      redis.pttl(queue.keys.limiter),
      redis.llen(queue.keys.active),
    ]);

    const isRateLimited = limiterTtl > 0 && (rateLimitMax === null || Number(rateLimitMax) <= Number(limited ?? 0));
    const isAtGlobalConcurrency = globalConcurrency !== null && active >= Number(globalConcurrency);

    return paused !== null || isRateLimited || isAtGlobalConcurrency;
  };

  const check = async (): Promise<CheckResult> => {
    const redis = await readClient();

    if (worker.isPaused() || (await isHeldBack(redis))) {
      return { kind: 'suppressed' };
    }

    const job = await mostOverdue(redis);

    if (job && Date.now() - job.dueAt > stallMs) {
      return { kind: 'overdue', job };
    }

    return { kind: 'clear' };
  };

  const stopTimers = () => {
    clearInterval(checkTimer);
    clearInterval(pingTimer);
    pingTimer = undefined;
  };

  /**
   * Stops taking jobs, logs and exits. With a wedge handler registered (the
   * server), the line is written at once and the handler's shutdown waits for
   * the held jobs. Otherwise this waits for them up to the drain limit itself.
   */
  const drainAndExit = async (describe: (heldAtDetection: number, running: number) => string) => {
    if (isDraining || isStopped) {
      return;
    }

    isDraining = true;
    stopTimers();

    const heldAtDetection = held();

    void worker.pause(true).catch(() => undefined);

    const handler = globalThis.__documenso_worker_wedged_handler__;

    if (handler) {
      fs.writeSync(2, `${describe(heldAtDetection, heldAtDetection)}\n`);
      handler();
      return;
    }

    const deadline = Date.now() + settings.drainSeconds * 1000;

    while (held() > 0 && Date.now() < deadline) {
      await sleep(100);
    }

    if (isStopped) {
      return;
    }

    // Synchronous, so the line is written before the process goes.
    fs.writeSync(2, `${describe(heldAtDetection, held())}\n`);
    process.exit(1);
  };

  const onCheckTick = async () => {
    if (isChecking || isDraining || isStopped) {
      return;
    }

    isChecking = true;

    // A read that times out still holds the slot until it settles, so reads never pile up.
    const read = check().catch(() => undefined);

    void read.then(() => {
      isChecking = false;
    });

    const startedAt = Date.now();
    const result = await within(read, READ_TIMEOUT_MS);

    if (isStopped || isDraining) {
      return;
    }

    // A wedged observation older than three intervals no longer pairs with a new one.
    if (wedgedAt !== null && startedAt - wedgedAt > 3 * checkMs) {
      wedgedAt = null;
    }

    // Inconclusive: Redis could not be read in time. It neither counts nor resets.
    if (result === undefined) {
      return;
    }

    if (result.kind !== 'overdue' || held() >= concurrency) {
      wedgedAt = null;
      return;
    }

    // Timers can fire a few milliseconds early, so allow for that in "one interval apart".
    if (wedgedAt === null || startedAt - wedgedAt < checkMs - 50) {
      wedgedAt = wedgedAt ?? startedAt;
      return;
    }

    const { job } = result;
    const ageSeconds = Math.floor((Date.now() - job.dueAt) / 1000);

    await drainAndExit(
      (heldAtDetection, running) =>
        `[JOBS]: Worker wedged: job id=${job.id} name=${job.name} overdue age=${ageSeconds}s ` +
        `held=${heldAtDetection} running=${running}`,
    );
  };

  /**
   * Resolves once every node has answered. Each node answers in order, so any
   * add queued while Redis was away has had its reply. On a Cluster one ping
   * could reach a different node from the add, so every master is asked.
   */
  const pingEveryNode = async (redis: IORedis | Cluster) => {
    if (redis.status !== 'ready') {
      throw new Error('not ready');
    }

    const nodes = 'nodes' in redis && typeof redis.nodes === 'function' ? redis.nodes('master') : [redis];

    if (nodes.length === 0) {
      throw new Error('no nodes');
    }

    await Promise.all(nodes.map(async (node) => await node.ping()));

    return true;
  };

  /**
   * Once the blocking client has ended outside a close, wait until Redis
   * answers through the Queue's connection, so that any add waiting in its
   * offline queue has been sent, and exit only if the client is still ended.
   */
  const onBlockingEnd = () => {
    if (isStopped || isDraining || worker.closing || pingTimer) {
      return;
    }

    let isPinging = false;

    pingTimer = setInterval(() => {
      if (isPinging) {
        return;
      }

      isPinging = true;

      // As with the stall check, a ping that times out holds the slot until it settles.
      const ping = client()
        .then(pingEveryNode)
        .catch(() => undefined);

      void ping.then(() => {
        isPinging = false;
      });

      void (async () => {
        const pong = await within(ping, READ_TIMEOUT_MS);

        if (pong === undefined || isStopped || isDraining) {
          return;
        }

        clearInterval(pingTimer);
        pingTimer = undefined;

        if (blockingClient?.status !== 'end') {
          return;
        }

        await drainAndExit(
          (heldAtDetection, running) =>
            `[JOBS]: Worker connection ended: the blocking client closed and did not reconnect ` +
            `held=${heldAtDetection} running=${running}`,
        );
      })();
    }, checkMs);

    pingTimer.unref();
  };

  const checkTimer = setInterval(() => void onCheckTick(), checkMs);

  checkTimer.unref();

  const isConnectionEndIgnored =
    env('NODE_ENV') !== 'production' && env('NEXT_PRIVATE_JOBS_TEST_IGNORE_CONNECTION_END') === 'true';

  if (!isConnectionEndIgnored) {
    // bullmq 5.76.7 returns the Worker's blocking client from waitUntilReady().
    void worker
      .waitUntilReady()
      .then((ready) => {
        if (isStopped) {
          return;
        }

        blockingClient = ready as unknown as IORedis | Cluster;
        blockingClient.on('end', onBlockingEnd);
      })
      .catch(() => undefined);
  }

  const stop = () => {
    isStopped = true;
    stopTimers();
    blockingClient?.off('end', onBlockingEnd);
    reader?.disconnect();
    runningWatchdogs().delete(stop);
  };

  runningWatchdogs().add(stop);

  return { stop };
};
