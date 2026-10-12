/**
 * The process under test in the integration specs: the real
 * BullMQJobProvider, constructed with BullMQJobProvider.getInstance() from the
 * environment the spec gives it, running real job definitions through its real
 * Worker. Nothing in BullMQ or ioredis is replaced.
 *
 * Run as `node --import tsx provider-child.ts`. It reports on stdout, one line
 * per event, as `W47 <epoch ms> <EVENT> <JSON>`, and takes commands on stdin,
 * one per line. The provider's own output, including the line it writes to
 * stderr before it exits, passes through untouched.
 *
 * The provider is imported by relative path. In a git worktree node_modules is
 * a link into the main checkout, so `@documenso/lib` would resolve to the main
 * checkout's copy of the provider rather than this one.
 *
 * Observation reaches into the provider in two places: the Worker, read from the
 * provider's `_worker` field, so the child can report what the Worker's blocking
 * client does (`blocking-end`, `blocking-ready`), whether the Worker is paused or
 * running, and pause it on command; and the provider's Queue, read from its
 * `_queue` field, so the child can enqueue through the provider's own
 * connection (`enqueue <label>`). The detection itself is never touched.
 */
import fs from 'node:fs';
import readline from 'node:readline';

import { BullMQJobProvider } from '../../../../lib/jobs/client/bullmq';

const BLOCKING_CLIENT_NAME = process.env.W47_BLOCKING_CLIENT_NAME || 'w47-blocking';
const LINGER_AFTER_CLOSE_MS = Number(process.env.W47_LINGER_AFTER_CLOSE_MS || 0);

const report = (event: string, detail: Record<string, unknown> = {}) => {
  // Synchronous, so a line written just before an exit is not lost.
  fs.writeSync(1, `W47 ${Date.now()} ${event} ${JSON.stringify(detail)}\n`);
};

process.on('exit', (code) => report('exit', { code }));

type SleepPayload = { label: string; ms?: number; untilWorkerPaused?: boolean; afterPauseMs?: number };

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  report('constructing');

  let provider: ReturnType<typeof BullMQJobProvider.getInstance>;

  try {
    provider = BullMQJobProvider.getInstance();
  } catch (error) {
    report('construct-error', { message: error instanceof Error ? error.message : String(error) });
    process.exit(3);
  }

  report('constructed');

  // F8 asks only whether construction throws. Waiting for the Worker after a
  // construction that should have thrown would turn that failure into a timeout.
  if (process.env.W47_CONSTRUCT_ONLY === 'true') {
    process.exit(0);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  const worker = (provider as any)._worker as import('bullmq').Worker;

  let workerPaused = false;

  provider.defineJob({
    id: 'w47.sleep',
    name: 'W47 Sleep',
    version: '1.0.0',
    trigger: { name: 'w47.sleep' },
    handler: async ({ payload }) => {
      const { label, ms = 0, untilWorkerPaused = false, afterPauseMs = 1_000 } = payload as SleepPayload;

      report('job-start', { label });

      if (untilWorkerPaused) {
        while (!workerPaused) {
          await sleep(50);
        }

        await sleep(afterPauseMs);
      } else {
        await sleep(ms);
      }

      report('job-end', { label });
    },
  });

  const failedOnce = new Set<string>();

  provider.defineJob({
    id: 'w47.fail-once',
    name: 'W47 Fail Once',
    version: '1.0.0',
    trigger: { name: 'w47.fail-once' },
    // eslint-disable-next-line @typescript-eslint/require-await
    handler: async ({ payload }) => {
      const { label } = payload as { label: string };

      if (!failedOnce.has(label)) {
        failedOnce.add(label);
        report('job-fail', { label });
        throw new Error(`w47 fail-once ${label}`);
      }

      report('job-end', { label });
    },
  });

  if (process.env.W47_CRON) {
    provider.defineJob({
      id: 'w47.cron',
      name: 'W47 Cron',
      version: '1.0.0',
      trigger: { name: 'w47.cron', cron: process.env.W47_CRON },
      // eslint-disable-next-line @typescript-eslint/require-await
      handler: async () => {
        report('cron-run');
      },
    });
  }

  let workerRunning = worker.isRunning();

  setInterval(() => {
    const paused = worker.isPaused();
    const running = worker.isRunning();

    if (paused !== workerPaused) {
      workerPaused = paused;
      report(paused ? 'worker-paused' : 'worker-resumed');
    }

    // isRunning() turns false once bullmq's main loop has returned, so no fetch
    // is in flight any more (worker.js run(), bullmq 5.76.7).
    if (running !== workerRunning) {
      workerRunning = running;
      report(running ? 'worker-running' : 'worker-stopped');
    }
  }, 50).unref();

  // bullmq 5.76.7 returns the Worker's blocking client from waitUntilReady().
  // The spec pins that (path 6 depends on it), so the child names the client it
  // was given, and the test looks for that name on a connection blocked in
  // BZPOPMIN.
  const blocking = (await worker.waitUntilReady()) as unknown as import('ioredis').Cluster | import('ioredis').Redis;
  const isCluster = 'nodes' in blocking && typeof blocking.nodes === 'function';

  blocking.on('end', () => report('blocking-end', { closing: Boolean(worker.closing) }));
  blocking.on('ready', () => report('blocking-ready'));

  const connections = isCluster ? (blocking as import('ioredis').Cluster).nodes('master') : [blocking];

  await Promise.all(
    connections.map(async (connection) => {
      await connection.call('CLIENT', 'SETNAME', BLOCKING_CLIENT_NAME).catch(() => undefined);
    }),
  );

  report('ready', { isCluster, status: blocking.status, connections: connections.length });

  const commands = readline.createInterface({ input: process.stdin });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
  const queue = (provider as any)._queue as import('bullmq').Queue;

  commands.on('line', (line) => {
    const [command, argument = ''] = line.trim().split(/\s+/, 2);

    if (command === 'close') {
      report('closing');
      void provider
        .close()
        .then(async () => {
          report('closed');
          await sleep(LINGER_AFTER_CLOSE_MS);
          process.exit(0);
        })
        .catch((error) => {
          report('close-error', { message: error instanceof Error ? error.message : String(error) });
          process.exit(4);
        });
    }

    if (command === 'pause-worker') {
      // pause(true), as the provider's own drain pauses. A waiting pause()
      // closes and reopens the blocking client, which emits `end` with
      // worker.closing false and, on a Cluster, often rejects with "Redis is
      // already connecting/connected" (bullmq 5.76.7, seen 2026-10-10).
      void worker
        .pause(true)
        .then(() => report('pause-worker-done'))
        .catch((error) =>
          report('pause-worker-error', { message: error instanceof Error ? error.message : String(error) }),
        );
    }

    if (command === 'pause-worker-wait') {
      // The waiting pause(): bullmq disconnects the blocking client to abort its
      // BZPOPMIN, waits for the main loop, then connects the same client again
      // (whenCurrentJobsFinished, worker.js:846-861).
      void worker
        .pause()
        .then(() => report('pause-worker-wait-done', { status: blocking.status }))
        .catch((error) =>
          report('pause-worker-wait-error', { message: error instanceof Error ? error.message : String(error) }),
        );
    }

    if (command === 'resume-worker') {
      worker.resume();
    }

    if (command === 'blocking-status') {
      report('blocking-status', { status: blocking.status });
    }

    if (command === 'queue-addrs') {
      // B3: where the Queue's own connection sits, as each node sees it, so
      // the spec can tell its commands from the stall check's in MONITOR.
      void (async () => {
        const client = await queue.client;
        const nodes = 'nodes' in client && typeof client.nodes === 'function' ? client.nodes('master') : [client];
        const infos = await Promise.all(nodes.map(async (node) => String(await node.call('CLIENT', 'INFO'))));
        const addrs = infos.map((info) => /\baddr=(\S+)/.exec(info)?.[1] ?? '').filter(Boolean);

        report('queue-addrs', { addrs });
      })().catch((error) =>
        report('queue-addrs-error', { message: error instanceof Error ? error.message : String(error) }),
      );
    }

    if (command === 'block-queue-connection') {
      // B3: a BLPOP that never returns, on the Queue's own connection, under
      // the queue's hash tag, so it blocks that connection on the queue's node.
      // Redis does not run the next command from a blocked client, so every
      // later command the Queue's connection sends to that node waits behind it.
      void (async () => {
        const client = await queue.client;

        report('block-queue-connection-sent');
        await client.blpop(`${process.env.NEXT_PRIVATE_REDIS_PREFIX}:w47-stuck`, 0);
        report('block-queue-connection-returned');
      })().catch((error) =>
        report('block-queue-connection-error', { message: error instanceof Error ? error.message : String(error) }),
      );
    }

    if (command === 'queue-probe') {
      // A read of a key on the queue's node through the Queue's own connection.
      void (async () => {
        const client = await queue.client;

        report('queue-probe-sent');
        await client.get(`${process.env.NEXT_PRIVATE_REDIS_PREFIX}:w47-probe`);
        report('queue-probe-done');
      })().catch((error) =>
        report('queue-probe-error', { message: error instanceof Error ? error.message : String(error) }),
      );
    }

    if (command === 'enqueue') {
      // Through the provider's own Queue and connection, in the shape the
      // provider enqueues (triggerJob would also write a database row).
      const label = argument;

      report('enqueue-start', { label });
      void queue
        .add('w47.sleep', { name: 'w47.sleep', payload: { label } })
        .then((job) => report('enqueue-done', { label, id: job.id }))
        .catch((error) =>
          report('enqueue-error', { label, message: error instanceof Error ? error.message : String(error) }),
        );
    }
  });
};

void main().catch((error) => {
  report('child-error', { message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exit(5);
});
