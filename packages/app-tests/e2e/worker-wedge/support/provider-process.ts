/**
 * Spawns provider-child.ts and reads what it reports, for the integration
 * specs. Also the queue the spec enqueues on, which is the provider's queue
 * reached as any other producer reaches it: a BullMQ Queue of the same name and
 * prefix on its own Cluster client.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { Queue } from 'bullmq';
import { Cluster } from 'ioredis';

import { prefixServedBy, type RedisCluster } from './redis-cluster';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CHILD = path.join(__dirname, 'provider-child.ts');

/** The queue packages/lib/jobs/client/bullmq.ts puts every job on. */
export const QUEUE_NAME = 'documenso-jobs';

/** The short settings the spec names for these tests, in seconds. */
export const STALL = 10;
export const CHECK = 2;
export const DRAIN = 5;

/** The three settings, by the names in the spec. */
export const STALL_VAR = 'NEXT_PRIVATE_JOBS_STALL_SECONDS';
export const CHECK_VAR = 'NEXT_PRIVATE_JOBS_STALL_CHECK_SECONDS';
export const DRAIN_VAR = 'NEXT_PRIVATE_JOBS_STALL_DRAIN_SECONDS';

/**
 * Test-only setting the implementation must add (spec, Test level, Canary).
 * When exactly `true`, the provider does not act on its blocking client's `end`
 * (behaviour 6): no `Worker connection ended` line and no exit from that path.
 * Checks 1-5 are unchanged. Unset or any other value leaves path 6 on. It lets
 * the canary specs wedge the Worker in Mode A and watch the stall check alone.
 */
export const IGNORE_CONNECTION_END_VAR = 'NEXT_PRIVATE_JOBS_TEST_IGNORE_CONNECTION_END';

export const WEDGED_LINE = '[JOBS]: Worker wedged';
export const CONNECTION_ENDED_LINE = '[JOBS]: Worker connection ended';

/** Inherited settings that would change what the provider does are dropped. */
const CONTROLLED =
  /^(NEXT_PRIVATE_REDIS_|NEXT_PRIVATE_JOBS_|NEXT_PRIVATE_BULLMQ_|NODE_OPTIONS$|NODE_ENV$|TEST_WORKER_INDEX$|TEST_PARALLEL_INDEX$)/;

export type ChildEvent = { at: number; event: string; detail: Record<string, unknown> };

export type ProviderProcess = {
  prefix: string;
  stdout: () => string;
  stderr: () => string;
  events: () => ChildEvent[];
  /** Resolves with the first event of that name, or rejects on timeout or exit. */
  waitForEvent: (event: string, timeoutMs: number, predicate?: (e: ChildEvent) => boolean) => Promise<ChildEvent>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  hasExited: () => boolean;
  /** The exit code if the process exits within the time, otherwise null. */
  exitWithin: (timeoutMs: number) => Promise<{ code: number | null; at: number } | null>;
  send: (command: string) => void;
  kill: () => Promise<void>;
};

export type ProviderOptions = {
  cluster: RedisCluster;
  /** Layered over the short settings; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  prefix?: string;
};

export const childEnv = (overrides: Record<string, string | undefined>) => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !CONTROLLED.test(key)) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

export const shortSettings = (cluster: RedisCluster, prefix: string): Record<string, string> => ({
  NODE_ENV: 'test',
  NEXT_PRIVATE_JOBS_PROVIDER: 'bullmq',
  NEXT_PRIVATE_REDIS_URL: cluster.url,
  NEXT_PRIVATE_REDIS_CLUSTER: 'true',
  NEXT_PRIVATE_REDIS_PREFIX: prefix,
  NEXT_PRIVATE_BULLMQ_CONCURRENCY: '2',
  [STALL_VAR]: String(STALL),
  [CHECK_VAR]: String(CHECK),
  [DRAIN_VAR]: String(DRAIN),
});

export const spawnProvider = (options: {
  env: Record<string, string | undefined>;
  prefix: string;
}): ProviderProcess => {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    // tsx is resolved from the repository root's node_modules.
    cwd: REPO_ROOT,
    env: childEnv(options.env) as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let partial = '';
  const events: ChildEvent[] = [];
  const waiters = new Set<() => void>();

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');

    stdout += text;
    partial += text;

    const lines = partial.split('\n');

    partial = lines.pop() ?? '';

    for (const line of lines) {
      const match = /^W47 (\d+) (\S+) (.*)$/.exec(line);

      if (match) {
        let detail: Record<string, unknown> = {};

        try {
          detail = JSON.parse(match[3]) as Record<string, unknown>;
        } catch {
          detail = { raw: match[3] };
        }

        events.push({ at: Number(match[1]), event: match[2], detail });
      }
    }

    waiters.forEach((wake) => wake());
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    waiters.forEach((wake) => wake());
  });

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      // The child reports its own exit time; fall back to when this process saw it.
      const reported = events.find((e) => e.event === 'exit');

      resolve({ code, signal, at: reported?.at ?? Date.now() });
      waiters.forEach((wake) => wake());
    });
  });

  const waitForEvent = async (event: string, timeoutMs: number, predicate?: (e: ChildEvent) => boolean) =>
    await new Promise<ChildEvent>((resolve, reject) => {
      const check = () => {
        const found = events.find((e) => e.event === event && (!predicate || predicate(e)));

        if (found) {
          cleanup();
          resolve(found);
          return true;
        }

        if (exited) {
          cleanup();
          reject(new Error(`provider child exited before reporting ${event}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return true;
        }

        return false;
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`provider child did not report ${event} within ${timeoutMs} ms.\nstdout:\n${stdout}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(wake);
      };

      const wake = () => {
        check();
      };

      if (!check()) {
        waiters.add(wake);
      }
    });

  return {
    prefix: options.prefix,
    stdout: () => stdout,
    stderr: () => stderr,
    events: () => [...events],
    waitForEvent,
    exit,
    hasExited: () => exited,
    exitWithin: async (timeoutMs) => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const result = await Promise.race([exit, timeout]);

      return result ? { code: result.code, at: result.at } : null;
    },
    send: (command) => {
      child.stdin?.write(`${command}\n`);
    },
    kill: async () => {
      if (!exited) {
        child.kill('SIGKILL');
        await exit;
      }
    },
  };
};

/** Starts the provider child with the short settings and waits until its Worker is ready. */
export const startProvider = async ({ cluster, env = {}, prefix }: ProviderOptions) => {
  const keyPrefix = prefix ?? (await prefixServedBy(cluster, 0, 'w47'));
  const provider = spawnProvider({ env: { ...shortSettings(cluster, keyPrefix), ...env }, prefix: keyPrefix });

  await provider.waitForEvent('ready', 60_000);

  return provider;
};

/** A producer on the provider's queue, as the app's other processes would be. */
export const openQueue = (cluster: RedisCluster, prefix: string) => {
  const connection = new Cluster([{ host: '127.0.0.1', port: cluster.ports[0] }], {
    redisOptions: { maxRetriesPerRequest: null },
    dnsLookup: (address, callback) => callback(null, address),
  });
  const queue = new Queue(QUEUE_NAME, { connection, prefix });

  return {
    queue,
    connection,
    /** A job for one of the child's definitions, in the shape the provider enqueues. */
    add: async (
      definition: 'w47.sleep' | 'w47.fail-once',
      payload: Record<string, unknown>,
      opts: Parameters<Queue['add']>[2] = {},
    ) => await queue.add(definition, { name: definition, payload }, opts),
    /** The due time BullMQ promotes a delayed job by: its score in the delayed set over 0x1000. */
    delayedDueAt: async (jobId: string) => {
      const score = await connection.zscore(`${prefix}:${QUEUE_NAME}:delayed`, jobId);

      return score === null ? null : Math.floor(Number(score) / 0x1000);
    },
    /** The earliest entry in the delayed set and its due time. */
    firstDelayed: async () => {
      const [id, score] = await connection.zrange(`${prefix}:${QUEUE_NAME}:delayed`, 0, 0, 'WITHSCORES');

      return id ? { id, dueAt: Math.floor(Number(score) / 0x1000) } : null;
    },
    close: async () => {
      await queue.close().catch(() => undefined);
      connection.disconnect();
    },
  };
};

export type OpenQueue = ReturnType<typeof openQueue>;

/** Resolves once a connection named by the child is blocked in BZPOPMIN on some node. */
export const waitForBlockingInBzpopmin = async (cluster: RedisCluster, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];

  while (Date.now() < deadline) {
    last = await cluster.clientList();

    const blocked = last.filter((line) => / cmd=bzpopmin\b/.test(line));

    if (blocked.length > 0) {
      return blocked;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No client was blocked in BZPOPMIN within ${timeoutMs} ms. CLIENT LIST:\n${last.join('\n')}`);
};

/**
 * Mode A, reproduced: with the Worker blocked in BZPOPMIN, every node is frozen
 * (`docker pause`) until the Worker's blocking client reports `end`, then
 * thawed. Frozen nodes keep their sockets open and answer nothing, as an
 * unreachable host does. Stopping the containers instead does not reproduce it
 * here: the published ports then accept and close at once, and the client
 * recovers (7 of 7 local trials, 2026-10-10), while freezing reached `end` in 5
 * of 5, about 8 s in.
 *
 * Resolves with whether the child reported `end` (it may have exited first, if
 * path 6 exits before the child's own listener runs).
 */
export const wedgeModeA = async (cluster: RedisCluster, provider: ProviderProcess, timeoutMs = 60_000) => {
  await waitForBlockingInBzpopmin(cluster);
  await cluster.pauseNodes();

  try {
    await Promise.race([provider.waitForEvent('blocking-end', timeoutMs), provider.exit.then(() => undefined)]);
  } finally {
    await cluster.unpauseNodes();
  }

  await cluster.waitForClusterOk();

  return provider.events().some((e) => e.event === 'blocking-end');
};

/** The single line, on stderr, that contains `marker`. */
export const exitLine = (provider: ProviderProcess, marker: string) =>
  provider
    .stderr()
    .split('\n')
    .filter((line) => line.includes(marker));

/**
 * Reads a counted field from the exit line. The spec says what the line holds,
 * not its layout, so this accepts `age=12`, `age 12s`, `age: 12` and the like:
 * the field's word, then within three characters a number.
 */
export const fieldOf = (line: string, word: string) => {
  const match = new RegExp(`\\b${word}\\b\\D{0,3}?(\\d+(?:\\.\\d+)?)`, 'i').exec(line);

  return match ? Number(match[1]) : null;
};

export const attachProviderEvidence = async (testInfo: TestInfo, provider: ProviderProcess, name = 'provider') => {
  await testInfo.attach(`${name}-stdout.log`, { body: provider.stdout(), contentType: 'text/plain' });
  await testInfo.attach(`${name}-stderr.log`, { body: provider.stderr(), contentType: 'text/plain' });
};

export const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));
