/**
 * at product level: a built Sign server on BullMQ against a real
 * three-master Redis Cluster. Written from
 * its specification alone.
 *
 * | Test                                                              | Behaviour | Failure modes  |
 * | ----------------------------------------------------------------- | --------- | -------------- |
 * | outage wedges the server: it exits 1 with a line; a document sent  | 5, 6, A2  | F1, F6, F9     |
 * |   during the outage gets its 200 before the exit, the exit runs    |           |                |
 * |   the server's graceful shutdown, and the document reaches its     |           |                |
 * |   signer through the replacement                                   |           |                |
 * |   a request accepted before the wedge shutdown, whose body arrives | B1, B2    | F9             |
 * |   only after the server has stopped accepting connections, gets    |           |                |
 * |   its 200 and its job, which the replacement delivers; the server  |           |                |
 * |   stops accepting connections within 2 s of the wedge line         |           |                |
 * | SIGTERM while a request is held open and the Worker is wedged,     | 7, C1     | F5             |
 * |   at a moment either watchdog path would confirm during the hold:  |           |                |
 * |   exit 0, neither line, and the held request gets its 200          |           |                |
 * | healthy server with its cron schedulers runs on and sends mail      | 7         | F7             |
 *
 * Product work is a V1 document send: POST /api/v1/documents/:id/send, whose
 * signing invitation goes out through a background job. The effect is judged in
 * the Inbucket mail catcher (E2E_INBUCKET_URL), not by reading the queue.
 *
 * The outage freezes the nodes (docker pause) until the server has had time to
 * reach Mode A, as the integration specs do; see support/provider-process.ts
 * for why stopping them does not wedge the Worker here.
 *
 * B1 without a test seam. A V1 send reads its JSON body before the handler
 * runs, and the handler enqueues the invitation job only after that (ts-rest
 * passes the parsed body to sendDocument in packages/api/v1/implementation.ts,
 * which calls jobs.triggerJob in send-document.ts). So the spec opens a send
 * before the outage, writes its headers and half its body, and holds the rest
 * back until the wedge line is on stderr and the server refuses new
 * connections. The job is then enqueued after the shutdown began, by
 * construction. The document is still a draft when the body is released, which
 * shows the handler had not yet run.
 *
 * The held part of the body is not idle. The server answers 408 to a body that
 * sends less than 32 KiB/s over 10 s, so the spec pads the JSON with
 * leading whitespace and trickles the padding at 48 KiB/s until release.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, Prisma } from '@prisma/client';
import { Cluster } from 'ioredis';

import { apiCreateTestContext } from '../fixtures/api-seeds';
import { addressFor, assertMailCatcherReachable, readMailbox, uniqueLocalPart } from '../fixtures/send-path';
import {
  CHECK,
  CHECK_VAR,
  CONNECTION_ENDED_LINE,
  DRAIN,
  DRAIN_VAR,
  fieldOf,
  QUEUE_NAME,
  STALL,
  STALL_VAR,
  sleep,
  WEDGED_LINE,
  waitForBlockingInBzpopmin,
} from './support/provider-process';
import { prefixServedBy, type RedisCluster, startRedisCluster } from './support/redis-cluster';
import { spawnWedgeServer, type WedgeServer, waitUntilServing } from './support/wedge-server';

test.beforeAll(async ({ request }) => {
  await assertMailCatcherReachable(request);
});

const SHORT_SETTINGS = { [STALL_VAR]: String(STALL), [CHECK_VAR]: String(CHECK), [DRAIN_VAR]: String(DRAIN) };

/** A V1 draft with one signer holding a signature field, as the send-path specs seed it. */
const seedV1Document = async (userId: number, teamId: number, label: string) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const localPart = uniqueLocalPart(`wedge-${label}`);
  const document = await seedDraftDocument(owner, teamId, [addressFor(localPart)], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  await prisma.field.create({
    data: {
      envelopeId: document.id,
      envelopeItemId: document.envelopeItems[0].id,
      recipientId: recipient.id,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: new Prisma.Decimal(10),
      positionY: new Prisma.Decimal(60),
      width: new Prisma.Decimal(25),
      height: new Prisma.Decimal(8),
      customText: '',
      inserted: false,
    },
  });

  return { documentId: mapSecondaryIdToDocumentId(document.secondaryId), envelopeId: document.id, localPart };
};

type SendResult = { status: number; text: string; at: number } | { error: string; at: number };

/** Whitespace ahead of the held send's JSON: 48 KiB/s for about 170 s, under the 10 MiB JSON limit. */
const HOLD_PADDING_BYTES = 8 * 1024 * 1024;
const HOLD_TRICKLE_BYTES = 4.8 * 1024;
const HOLD_TRICKLE_MS = 100;

/**
 * A V1 send whose headers go out at once and whose body trickles whitespace
 * until `release()` sends the rest. Its own connection (no agent), so nothing
 * else shares or reuses it.
 */
const holdSend = (server: WedgeServer, token: string, documentId: number) => {
  const body = ' '.repeat(HOLD_PADDING_BYTES) + JSON.stringify({ sendEmail: true });
  let split = Math.floor(HOLD_TRICKLE_BYTES);
  const url = new URL(`${server.origin}/api/v1/documents/${documentId}/send`);
  let release: () => number = () => 0;
  let connected: () => void = () => {};
  const isConnected = new Promise<void>((resolve) => (connected = resolve));

  const response = new Promise<SendResult>((resolve) => {
    let trickle: NodeJS.Timeout | undefined;

    // Stop the trickle however the request ends, so a failure before release does not keep writing.
    const settle = (result: SendResult) => {
      clearInterval(trickle);
      resolve(result);
    };

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => settle({ status: res.statusCode ?? 0, text, at: Date.now() }));
        res.on('error', (error) => settle({ error: error.message, at: Date.now() }));
      },
    );

    req.on('error', (error) => settle({ error: error.message, at: Date.now() }));
    req.on('socket', (socket) => socket.on('connect', () => connected()));
    req.flushHeaders();
    req.write(body.slice(0, split));

    trickle = setInterval(() => {
      const next = Math.min(split + Math.floor(HOLD_TRICKLE_BYTES), HOLD_PADDING_BYTES);

      req.write(body.slice(split, next));
      split = next;
    }, HOLD_TRICKLE_MS);

    release = () => {
      clearInterval(trickle);
      req.end(body.slice(split));

      return Date.now();
    };
  });

  return { response, isConnected, release: () => release() };
};

/** Whether a fresh TCP connection to the server is refused. */
const isRefused = async (server: WedgeServer) =>
  await new Promise<boolean>((resolve) => {
    const { hostname, port } = new URL(server.origin);
    const socket = net.connect({ host: hostname, port: Number(port) });

    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) => {
      const codes = [error.code, ...(error.errors ?? []).map((inner) => inner.code)];

      resolve(codes.includes('ECONNREFUSED'));
    });
  });

const send = async (request: APIRequestContext, server: WedgeServer, token: string, documentId: number) =>
  await request.post(`${server.origin}/api/v1/documents/${documentId}/send`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { sendEmail: true },
    timeout: 120_000,
  });

const waitForInvitation = async (request: APIRequestContext, localPart: string, timeout: number, context: string) => {
  await expect
    .poll(async () => (await readMailbox(request, localPart)).length, { message: context, timeout })
    .toBeGreaterThanOrEqual(1);
};

type Started = { cluster?: RedisCluster; servers: WedgeServer[] };

const teardown = async (started: Started, testInfo: import('@playwright/test').TestInfo) => {
  for (const [index, server] of started.servers.entries()) {
    await server.stop();
    await testInfo.attach(`sign-server-${index}-stdout.log`, {
      body: server.stdout(),
      contentType: 'text/plain',
    });
    await testInfo.attach(`sign-server-${index}-stderr.log`, {
      body: server.stderr(),
      contentType: 'text/plain',
    });
  }

  if (started.cluster) {
    await testInfo.attach('redis-cluster.log', { body: await started.cluster.logs(), contentType: 'text/plain' });
    await started.cluster.teardown();
  }
};

// F1, F6, F9: the outage wedges the server, which exits 1 with one of the two
// lines; the document sent during the outage is delivered by its replacement.
test('a_server_wedged_by_a_cluster_outage_exits_1_and_its_replacement_delivers_work_sent_during_the_outage', async ({
  request,
}, testInfo) => {
  test.setTimeout(420_000);

  const started: Started = { servers: [] };

  try {
    const cluster = await startRedisCluster('product-wedge');

    started.cluster = cluster;

    // The queue's keys on the seed node, the only node the server is given; see
    // the SIGTERM test's timing notes for why.
    const redisPrefix = await prefixServedBy(cluster, 0, 'w47-product');
    const serverOptions = { redisUrl: cluster.url, redisPrefix, cluster: true, env: SHORT_SETTINGS };
    const first = await spawnWedgeServer(serverOptions);

    started.servers.push(first);
    await waitUntilServing(first);

    const { token, user, team } = await apiCreateTestContext('w47-product-wedge');

    // Premise: on this cluster the server sends a signing invitation through BullMQ.
    const control = await seedV1Document(user.id, team.id, 'control');
    const controlSend = await send(request, first, token, control.documentId);

    expect(controlSend.status(), `control send: ${await controlSend.text()}`).toBe(200);
    await waitForInvitation(request, control.localPart, 60_000, 'the control invitation arrives before the outage');

    await waitForBlockingInBzpopmin(cluster);

    const during = await seedV1Document(user.id, team.id, 'during-outage');

    // B1: a send accepted before the outage, its body held back.
    const held = await seedV1Document(user.id, team.id, 'held-body');
    const heldSend = holdSend(first, token, held.documentId);

    await heldSend.isConnected;
    expect(await isRefused(first), 'premise: the server accepts new connections before the wedge').toBe(false);

    await cluster.pauseNodes();

    const pausedAt = Date.now();

    let duringSend: Promise<{ status: number; text: string; at: number } | { error: string; at: number }>;

    try {
      duringSend = send(request, first, token, during.documentId)
        .then(async (res) => ({ status: res.status(), text: await res.text(), at: Date.now() }))
        .catch((error: Error) => ({ error: error.message, at: Date.now() }));
      await Promise.race([first.exit, waitForReconnectLoopToStop(first, pausedAt)]);
    } finally {
      await cluster.unpauseNodes();
    }

    // B2: the line is written when the wedge is confirmed and the shutdown
    // starts right after it. The held request keeps the server from exiting.
    // waitForStderr returns the time the line arrived, however late it is
    // called, and it is awaited before the cluster check so that the refusal
    // poll below starts as soon as the line is there (Codex r3).
    const lineAt = await first.waitForStderr(
      (stderr) => stderr.includes(WEDGED_LINE) || stderr.includes(CONNECTION_ENDED_LINE),
      (STALL + 4 * CHECK + DRAIN + 30) * 1000,
    );

    let refusedAt = 0;

    while (Date.now() - lineAt < 10_000 && !first.hasExited()) {
      if (await isRefused(first)) {
        refusedAt = Date.now();
        break;
      }

      await sleep(50);
    }

    await cluster.waitForClusterOk();

    const heldStatusBeforeRelease = (await prisma.envelope.findUniqueOrThrow({ where: { id: held.envelopeId } }))
      .status;
    const runningAtRelease = !first.hasExited();
    const releasedAt = heldSend.release();
    const exit = await first.exitWithin((STALL + 4 * CHECK + DRAIN + 30) * 1000);
    const duringResult = await duringSend;
    const heldResult = await heldSend.response;

    await testInfo.attach('send-during-outage.json', {
      body: JSON.stringify(
        {
          during: duringResult,
          held: heldResult,
          heldStatusBeforeRelease,
          lineAt,
          refusedAt,
          releasedAt,
          exitAt: exit?.at ?? null,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    // B2: once the wedge is confirmed the server stops taking connections at
    // once, well before DRAIN would have run out. The product server holds no
    // job at that moment, so this does not tell a drain-first exit apart.
    expect(refusedAt, `new connections are refused after the wedge line.\nstderr:\n${first.stderr()}`).toBeGreaterThan(
      0,
    );
    expect(refusedAt - lineAt, 'new connections are refused within 2 s of the wedge line').toBeLessThanOrEqual(2_000);
    expect(refusedAt - lineAt, 'which is well inside DRAIN').toBeLessThan(DRAIN * 1000);

    // B1 premise: the held request's handler had not run before its body was
    // released, after the shutdown had begun.
    expect(heldStatusBeforeRelease, 'premise: the held document was still a draft at release').toBe('DRAFT');
    expect(runningAtRelease, 'premise: the server was still running at release').toBe(true);

    expect(exit, `the wedged server exits.\nstderr:\n${first.stderr()}`).not.toBeNull();
    expect(exit?.code, 'the exit code is 1, whatever the shutdown itself returned').toBe(1);

    // A2: the request in flight through the outage and the wedge completes with
    // its normal response, and before the server exits: the exit went through
    // the server's graceful shutdown, which finishes open requests.
    expect(
      'status' in duringResult ? duringResult.status : duringResult.error,
      `A2: the send made during the outage gets its normal response: ${JSON.stringify(duringResult)}`,
    ).toBe(200);
    expect(duringResult.at, 'A2: the response arrived before the server exited').toBeLessThanOrEqual(exit?.at ?? 0);

    // B1: the request accepted before the shutdown, which enqueued its job only
    // after the shutdown began, gets its normal response before the exit.
    expect(
      'status' in heldResult ? heldResult.status : heldResult.error,
      `B1: the held send gets its normal response: ${JSON.stringify(heldResult)}`,
    ).toBe(200);
    expect(heldResult.at, 'B1: the held response arrived before the server exited').toBeLessThanOrEqual(exit?.at ?? 0);

    // A2: the server's graceful shutdown ran. createGracefulShutdown logs its
    // lines with the `[SHUTDOWN]:` prefix (packages/lib/utils/graceful-shutdown.ts),
    // the start of a shutdown with console.log and its failures with
    // console.error, so both streams are read.
    expect(
      `${first.stdout()}\n${first.stderr()}`,
      'A2: the wedge exit ran the server graceful shutdown, which logs [SHUTDOWN]:',
    ).toContain('[SHUTDOWN]:');

    const lines = first
      .stderr()
      .split('\n')
      .filter((line) => line.includes(WEDGED_LINE) || line.includes(CONNECTION_ENDED_LINE));

    expect(lines, 'one of the two lines explains the exit, on stderr').toHaveLength(1);

    // B2: with the server's handler, held and running both count the jobs held
    // at confirmation, since the line is written then.
    const heldField = fieldOf(lines[0], 'held');
    const runningField = fieldOf(lines[0], 'running');

    expect(heldField, `B2: the line counts the jobs held: ${lines[0]}`).not.toBeNull();
    expect(runningField, `B2: the line counts the jobs still running: ${lines[0]}`).not.toBeNull();
    expect(runningField, `B2: running equals held in the line: ${lines[0]}`).toBe(heldField);

    // The held send's invitation was not sent by the wedged server.
    expect(await readMailbox(request, held.localPart), 'no invitation before the replacement starts').toHaveLength(0);

    const replacement = await spawnWedgeServer(serverOptions);

    started.servers.push(replacement);
    await waitUntilServing(replacement);

    await waitForInvitation(
      request,
      during.localPart,
      90_000,
      'the invitation for the document sent during the outage arrives through the replacement',
    );
    await waitForInvitation(
      request,
      held.localPart,
      90_000,
      'B1: the invitation for the held send, enqueued after the shutdown began, arrives through the replacement',
    );
  } finally {
    await teardown(started, testInfo);
  }
});

/**
 * How long, in ms, the most overdue job on the queue has been due, read as the
 * watchdog is specified to read it (behaviour 1): the tail of `wait` (the
 * provider enqueues FIFO, A4) by its enqueue timestamp, and the head of
 * `delayed` by its score over 0x1000. Null when both are empty.
 */
const mostOverdueMs = async (cluster: RedisCluster, prefix: string) => {
  const reader = new Cluster([{ host: '127.0.0.1', port: cluster.ports[0] }], {
    redisOptions: { maxRetriesPerRequest: null },
    dnsLookup: (address, callback) => callback(null, address),
  });

  try {
    const now = Date.now();
    const ages: number[] = [];
    const [oldestWaiting] = await reader.lrange(`${prefix}:${QUEUE_NAME}:wait`, -1, -1);

    if (oldestWaiting) {
      const timestamp = await reader.hget(`${prefix}:${QUEUE_NAME}:${oldestWaiting}`, 'timestamp');

      if (timestamp !== null) {
        ages.push(now - Number(timestamp));
      }
    }

    const [, firstDelayedScore] = await reader.zrange(`${prefix}:${QUEUE_NAME}:delayed`, 0, 0, 'WITHSCORES');

    if (firstDelayedScore !== undefined) {
      ages.push(now - Math.floor(Number(firstDelayedScore) / 0x1000));
    }

    return ages.length > 0 ? Math.max(...ages) : null;
  } finally {
    reader.disconnect();
  }
};

const SLOT_REFRESH_FAILURE = /Failed to refresh slots cache|None of startup nodes is available/;

/**
 * When each of the Worker's slot-refresh failures reached stderr: matched on
 * the whole of stderr, so a line split across chunks still counts, and stamped
 * with the arrival of the chunk that completed it.
 */
const slotRefreshFailures = (server: WedgeServer) => {
  const chunks = server.stderrChunks();
  const ends: number[] = [];
  let end = 0;

  for (const chunk of chunks) {
    end += chunk.text.length;
    ends.push(end);
  }

  return [
    ...chunks
      .map((chunk) => chunk.text)
      .join('')
      .matchAll(new RegExp(SLOT_REFRESH_FAILURE.source, 'g')),
  ].map((match) => chunks[ends.findIndex((chunkEnd) => chunkEnd >= match.index + match[0].length)].at);
};

/**
 * Keeps the freeze going until the Worker's blocking client has had time to
 * reach Mode A. Its own timer fires at most maximumBlockTimeout + 1 = 11 s into
 * the freeze (bullmq worker.js:20 and :434) and disconnects it. While ioredis
 * retries that reconnect, a `Failed to refresh slots cache` line reaches stderr
 * about every 1.1 s; once the client is in `end` no line can follow, and a
 * client still retrying at the thaw reconnects and the Worker is healthy. So
 * the freeze lasts at least MIN_MS, and until no line has arrived for QUIET_MS:
 * from MIN_MS that window covers 11 s onwards, so a live retry loop always
 * shows in it. A loop that has not stopped by MAX_MS ends the freeze anyway,
 * and the premise at release then fails with the timings attached.
 *
 * The match is on any stderr text, so this does not hold with DEBUG=ioredis:*
 * set for the server, whose own lines carry the same words.
 */
const waitForReconnectLoopToStop = async (server: WedgeServer, pausedAt: number) => {
  const MIN_MS = 15_000;
  const QUIET_MS = 4_000;
  const MAX_MS = 25_000;

  while (Date.now() - pausedAt < MAX_MS) {
    const last = Math.max(pausedAt, ...slotRefreshFailures(server));

    if (Date.now() - pausedAt >= MIN_MS && Date.now() - last >= QUIET_MS) {
      return;
    }

    await sleep(100);
  }
};

const waitForOutput = async (server: WedgeServer, text: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (`${server.stdout()}\n${server.stderr()}`.includes(text)) {
      return true;
    }

    await sleep(50);
  }

  return false;
};

/**
 * C1: any shutdown stops the watchdog at once. Before C1 the watchdog stopped
 * only when the job provider closed, which B1 puts after the open requests, so
 * a SIGTERM shutdown held open by a request left the watchdog free to confirm a
 * wedge, write its line and pause the Worker (Codex r3).
 *
 * The timing, with STALL 10, CHECK 2 (support/provider-process.ts):
 *
 * - t = 0: the Worker is blocked in BZPOPMIN, a send has its headers and half
 *   its body in, and every node is frozen. A second send is made at once; its
 *   job is added inside the freeze, so it carries a timestamp from then (bullmq
 *   classes/job.js:90 sets `timestamp` to Date.now() in the constructor) and
 *   waits in the offline queue.
 * - t >= 15 s: Mode A has been reached, and the second send's job is already
 *   older than STALL. The freeze lasts until the Worker's reconnect retries
 *   have stopped (waitForReconnectLoopToStop), about 17 s. Mode A depends on
 *   where the queue lives: the server is given only the seed node, and with the
 *   queue's hash slot on the seed the first freeze reached Mode A in 5 runs of
 *   5; with it on another node, in 0 of 5, the reconnect retries running on
 *   until the thaw. So the spec picks a key prefix the seed node serves.
 *   SIGTERM goes to the server while the nodes are still frozen. Neither
 *   watchdog path can confirm before this: the connection-ended path needs a
 *   ping to succeed and the stall check needs two reads to succeed, and a
 *   frozen node answers nothing. The spec checks that neither line is there.
 * - The nodes are thawed once the server has logged `[SHUTDOWN]:`, so the
 *   shutdown has begun before Redis answers again.
 * - Without C1, from the thaw: an outstanding ping settles at once, or the next
 *   starts within CHECK, so the connection-ended path confirms within
 *   CHECK + 5 s = 7 s; a stall-check read in flight settles at once, or within
 *   its 5 s bound, and two wedged checks CHECK apart confirm within
 *   5 + 2 x CHECK = 9 s. The held body is released HOLD_MS = 12 s after the
 *   thaw, later than either. Just before release the spec checks that a job
 *   has been due for longer than STALL + 2 x CHECK + 5 s and is still not
 *   taken, which shows the Worker was wedged throughout and the stall check
 *   had what it needed to confirm.
 * - The shutdown's single deadline is 25 s from SIGTERM (llms.txt/operations.md).
 *   SIGTERM to release is about 13 s, which leaves about 12 s for the held
 *   response and the job close. The exit-0 assertion depends on the job close
 *   of a wedged Worker finishing inside that.
 *
 * Exit 0 does not tell C1 apart: before C1 the wedge shutdown nested in a
 * SIGTERM one was ignored and the SIGTERM shutdown still exited 0. What tells
 * it apart is that neither line reaches stderr.
 */
test('a_sigterm_shutdown_held_open_by_a_request_while_the_worker_is_wedged_exits_0_without_either_line', async ({
  request,
}, testInfo) => {
  test.setTimeout(300_000);

  const HOLD_MS = 12_000;
  const started: Started = { servers: [] };

  try {
    const cluster = await startRedisCluster('product-sigterm');

    started.cluster = cluster;

    // The queue's keys on the seed node, the only node the server is given; see
    // the timing notes above for why.
    const redisPrefix = await prefixServedBy(cluster, 0, 'w47-product');
    const server = await spawnWedgeServer({ redisUrl: cluster.url, redisPrefix, cluster: true, env: SHORT_SETTINGS });

    started.servers.push(server);
    await waitUntilServing(server);

    const { token, user, team } = await apiCreateTestContext('w47-product-sigterm');
    const during = await seedV1Document(user.id, team.id, 'sigterm-during');
    const held = await seedV1Document(user.id, team.id, 'sigterm-held');

    await waitForBlockingInBzpopmin(cluster);

    const heldSend = holdSend(server, token, held.documentId);

    await heldSend.isConnected;

    await cluster.pauseNodes();

    const pausedAt = Date.now();

    let duringSend: Promise<SendResult>;
    let linesBeforeSigterm = '';
    let runningAtSigterm = false;
    let shutdownLogged = false;
    let sigtermAt = 0;
    let thawedAt = 0;

    try {
      duringSend = send(request, server, token, during.documentId)
        .then(async (res) => ({ status: res.status(), text: await res.text(), at: Date.now() }))
        .catch((error: Error) => ({ error: error.message, at: Date.now() }));

      await Promise.race([server.exit, waitForReconnectLoopToStop(server, pausedAt)]);

      runningAtSigterm = !server.hasExited();
      linesBeforeSigterm = server
        .stderr()
        .split('\n')
        .filter((line) => line.includes(WEDGED_LINE) || line.includes(CONNECTION_ENDED_LINE))
        .join('\n');
      sigtermAt = Date.now();
      server.signal('SIGTERM');
      shutdownLogged = await waitForOutput(server, '[SHUTDOWN]:', 5_000);
    } finally {
      await cluster.unpauseNodes();
      thawedAt = Date.now();
    }

    expect(runningAtSigterm, `premise: the server ran through the freeze.\nstderr:\n${server.stderr()}`).toBe(true);
    expect(linesBeforeSigterm, 'premise: no watchdog line before SIGTERM, while the nodes were frozen').toBe('');
    expect(shutdownLogged, 'premise: the SIGTERM shutdown began before the nodes were thawed').toBe(true);

    // The reader in mostOverdueMs needs a cluster that answers; the hold is
    // measured from the thaw, so this does not move the release.
    await cluster.waitForClusterOk();

    // Evidence only: a Worker in Mode A never blocks again.
    const reblockedAfterThawMs = await waitForBlockingInBzpopmin(cluster, 5_000)
      .then(() => Date.now() - thawedAt)
      .catch(() => null);

    await sleep(Math.max(0, thawedAt + HOLD_MS - Date.now()));

    const overdueMsAtRelease = await mostOverdueMs(cluster, redisPrefix);
    const heldStatusBeforeRelease = (await prisma.envelope.findUniqueOrThrow({ where: { id: held.envelopeId } }))
      .status;
    const runningAtRelease = !server.hasExited();
    const releasedAt = heldSend.release();
    const exit = await server.exitWithin(30_000);
    const duringResult = await duringSend;
    const heldResult = await heldSend.response;

    await testInfo.attach('sigterm-held-open.json', {
      body: JSON.stringify(
        {
          during: duringResult,
          held: heldResult,
          heldStatusBeforeRelease,
          overdueMsAtRelease,
          reblockedAfterThawMs,
          slotRefreshFailuresMsAfterPause: slotRefreshFailures(server)
            .filter((at) => at >= pausedAt)
            .map((at) => at - pausedAt),
          pausedAt,
          sigtermAt,
          thawedAt,
          releasedAt,
          exitAt: exit?.at ?? null,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    // Premises: the request was still held, and the server still shutting down,
    // when the watchdog would have confirmed; a job had been due for longer
    // than STALL + 2 x CHECK + 5 s and the Worker still had not taken it.
    expect(heldStatusBeforeRelease, 'premise: the held document was still a draft at release').toBe('DRAFT');
    expect(runningAtRelease, 'premise: the server was still shutting down at release').toBe(true);
    expect(overdueMsAtRelease, 'premise: a job was waiting at release').not.toBeNull();
    expect(
      overdueMsAtRelease ?? 0,
      'premise: the Worker stayed wedged with a job overdue long enough for the stall check to confirm',
    ).toBeGreaterThan((STALL + 2 * CHECK + 5) * 1000);

    expect(exit, `the server exits after the held request.\nstderr:\n${server.stderr()}`).not.toBeNull();
    expect(exit?.code, `a SIGTERM shutdown exits 0.\nstderr:\n${server.stderr()}`).toBe(0);

    // C1, the part that tells it apart: the watchdog stopped when the shutdown began.
    expect(server.stderr(), 'C1: no wedge line during a SIGTERM shutdown').not.toContain(WEDGED_LINE);
    expect(server.stderr(), 'C1: no connection-ended line during a SIGTERM shutdown').not.toContain(
      CONNECTION_ENDED_LINE,
    );

    expect(
      'status' in heldResult ? heldResult.status : heldResult.error,
      `the held send gets its normal response: ${JSON.stringify(heldResult)}`,
    ).toBe(200);
    expect(heldResult.at, 'the held response arrived before the server exited').toBeLessThanOrEqual(exit?.at ?? 0);
    expect(
      'status' in duringResult ? duringResult.status : duringResult.error,
      `the send made during the freeze gets its normal response: ${JSON.stringify(duringResult)}`,
    ).toBe(200);
  } finally {
    await teardown(started, testInfo);
  }
});

// F7: no outage. With its cron schedulers registered and running for several
// check intervals, the server does not exit, and still sends mail.
test('a_healthy_server_with_its_cron_schedulers_runs_on_for_several_check_intervals', async ({ request }, testInfo) => {
  test.setTimeout(300_000);

  const started: Started = { servers: [] };

  try {
    const cluster = await startRedisCluster('product-healthy');

    started.cluster = cluster;

    const redisPrefix = `{w47-product-${randomUUID()}}`;
    const server = await spawnWedgeServer({ redisUrl: cluster.url, redisPrefix, cluster: true, env: SHORT_SETTINGS });

    started.servers.push(server);
    await waitUntilServing(server);

    // Premise: the app's cron schedulers are registered, so their next
    // occurrences wait in the delayed set while the server runs.
    const reader = new Cluster([{ host: '127.0.0.1', port: cluster.ports[0] }], {
      redisOptions: { maxRetriesPerRequest: null },
      dnsLookup: (address, callback) => callback(null, address),
    });

    try {
      await expect
        .poll(async () => await reader.zcard(`${redisPrefix}:${QUEUE_NAME}:delayed`), {
          message: 'cron occurrences are scheduled',
          timeout: 60_000,
        })
        .toBeGreaterThan(0);
    } finally {
      reader.disconnect();
    }

    const { token, user, team } = await apiCreateTestContext('w47-product-healthy');
    const first = await seedV1Document(user.id, team.id, 'healthy-first');

    expect((await send(request, server, token, first.documentId)).status()).toBe(200);
    await waitForInvitation(request, first.localPart, 60_000, 'an invitation arrives');

    const exit = await server.exitWithin((STALL + 8 * CHECK) * 1000);

    expect(exit, `the healthy server runs on.\nstderr:\n${server.stderr()}`).toBeNull();

    const second = await seedV1Document(user.id, team.id, 'healthy-second');

    expect((await send(request, server, token, second.documentId)).status()).toBe(200);
    await waitForInvitation(request, second.localPart, 60_000, 'a later invitation arrives too');

    expect(server.stderr()).not.toContain(WEDGED_LINE);
    expect(server.stderr()).not.toContain(CONNECTION_ENDED_LINE);
  } finally {
    await teardown(started, testInfo);
  }
});
