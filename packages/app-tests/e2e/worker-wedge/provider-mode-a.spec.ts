/**
 * the provider exits when the Worker's blocking client ends (behaviour 6),
 * and never on a graceful close (behaviour 7). Integration level: the real
 * BullMQJobProvider in a child process against a real three-master Redis
 * Cluster. Written from its specification alone.
 *
 * | Test                                                        | Behaviour | Failure modes |
 * | ----------------------------------------------------------- | --------- | ------------- |
 * | waitUntilReady() returns the client blocked in BZPOPMIN      | 6 (pin)   | F1            |
 * | Mode A: no exit while Redis is down, exit 1 once it answers   | 6         | F1, F6, F9    |
 * |   and the job the provider enqueued meanwhile is not lost     |           |               |
 * | a job enqueued during the outage runs in the replacement     | 5, 6      | F9            |
 * | an end followed by a reconnect (waiting pause) cancels path 6 | 6         | F7            |
 * | graceful close of a healthy Worker exits 0, logs neither line | 7         | F5            |
 * | close just before a wedge is confirmed exits 0, logs neither  | 2, 7      | F5            |
 * | close while a confirmed wedge drains exits 0, logs neither    | 7, A7     | F5, F11       |
 *
 * The pin passes today by design: it characterises bullmq 5.76.7, which the
 * provider will rely on, so that an upgrade that changes it fails here.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from './support/fixture';
import {
  CHECK,
  CONNECTION_ENDED_LINE,
  DRAIN,
  exitLine,
  IGNORE_CONNECTION_END_VAR,
  type ProviderProcess,
  STALL,
  sleep,
  WEDGED_LINE,
  waitForBlockingInBzpopmin,
  wedgeModeA,
} from './support/provider-process';

// F1 (pin): path 6 listens on what worker.waitUntilReady() returns, so that must
// be the connection the Worker blocks on.
test('worker_wait_until_ready_returns_the_client_that_blocks_in_bzpopmin', async ({ wedge }) => {
  const provider = await wedge.provider({ env: { W47_BLOCKING_CLIENT_NAME: 'w47-pinned' } });

  const blocked = await waitForBlockingInBzpopmin(wedge.cluster);

  expect(
    blocked.some((line) => / name=w47-pinned /.test(line)),
    `the connection blocked in BZPOPMIN carries the name set through waitUntilReady()'s client:\n${blocked.join('\n')}`,
  ).toBe(true);
  expect(provider.hasExited()).toBe(false);
});

/** Hold after `blocking-end`: two ping cycles that fail on the 5 s bound, and two intervals more. */
const HOLD_AFTER_END_MS = (2 * (CHECK + 5) + 2 * CHECK) * 1000;

/** Fails at once if the process exits within the time. */
const expectNoExitFor = async (provider: ProviderProcess, ms: number, context: string) => {
  const exit = await provider.exitWithin(ms);

  expect(exit, `${context}: no exit within ${ms} ms.\nstderr:\n${provider.stderr()}`).toBeNull();
  expect(exitLine(provider, CONNECTION_ENDED_LINE), `${context}: no connection-ended line`).toHaveLength(0);
  expect(exitLine(provider, WEDGED_LINE), `${context}: no wedged line`).toHaveLength(0);
};

// F1, F6, F9: Mode A. The blocking client reaches the terminal `end` while every
// node is frozen. The process must not exit then, because a Queue.add waiting
// on the shared connection would be lost with it (behaviour 6), so the nodes
// stay frozen for HOLD_AFTER_END_MS after `end`: long enough for an exit on
// `end` itself, and for an exit after a ping that failed rather than succeeded
// (each takes up to CHECK + 5 s), to show. Meanwhile the child enqueues a job
// through the provider's own Queue, not through a separate producer. Once the
// nodes answer again the process exits 1 with the connection-ended line, and a
// replacement processes the job (F9). The last assertion asks more: that the
// add has answered its caller before the exit, which is the reason behaviour 6
// gives for waiting ("the web request behind it"). On a Cluster the ping and
// the add can go to different nodes, so a ping that answers does not show that
// the add has been answered; on 38303c3aa this assertion failed in 3 of 5 runs
// (2026-10-10) while the job itself was never lost.
test('when_the_blocking_client_ends_outside_a_close_the_process_exits_1_with_the_connection_ended_line', async ({
  wedge,
}) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider();
  const { add } = wedge.queue(provider.prefix);

  // Premise: the Worker processes work before the outage.
  await add('w47.sleep', { label: 'before' });
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'before');

  await waitForBlockingInBzpopmin(wedge.cluster);
  await wedge.cluster.pauseNodes();

  let restoredAt = 0;

  try {
    const ended = await Promise.race([provider.waitForEvent('blocking-end', 60_000), provider.exit.then(() => null)]);

    expect(ended, `premise: Mode A reached, the blocking client ended.\nstderr:\n${provider.stderr()}`).not.toBeNull();
    expect(ended?.detail.closing, 'premise: the end is not part of a close').toBe(false);

    provider.send('enqueue during-outage');
    await provider.waitForEvent('enqueue-start', 5_000);

    await expectNoExitFor(provider, HOLD_AFTER_END_MS, 'blocking client ended, every node still frozen');

    expect(
      provider.events().filter((e) => e.event === 'enqueue-done' || e.event === 'enqueue-error'),
      'premise: the add is still waiting on the frozen cluster',
    ).toHaveLength(0);
  } finally {
    restoredAt = Date.now();
    await wedge.cluster.unpauseNodes();
  }

  const exit = await provider.exitWithin((CHECK + 5 + DRAIN + 20) * 1000);

  expect(exit, `the process exits once Redis answers.\nstderr:\n${provider.stderr()}`).not.toBeNull();
  expect(exit?.code).toBe(1);
  expect(exit?.at ?? 0, 'the exit follows the restore').toBeGreaterThan(restoredAt);
  expect(exitLine(provider, CONNECTION_ENDED_LINE), 'one connection-ended line on stderr').toHaveLength(1);

  const enqueueError = provider.events().find((e) => e.event === 'enqueue-error');

  expect(enqueueError?.detail.message, 'the add through the provider did not fail').toBeUndefined();

  await wedge.cluster.waitForClusterOk();

  const replacement = await wedge.provider({ prefix: provider.prefix });

  await replacement.waitForEvent('job-end', 60_000, (e) => e.detail.label === 'during-outage');

  const enqueued = provider.events().find((e) => e.event === 'enqueue-done');

  expect(enqueued, 'the add through the provider completed before the exit').toBeDefined();
  expect(enqueued?.at ?? Infinity).toBeLessThanOrEqual(exit?.at ?? 0);
});

// F7: an `end` the client recovers from is not a wedge. A waiting worker.pause()
// disconnects the blocking client to abort its BZPOPMIN, which emits `end` with
// the Worker not closing, and the same client then connects again
// (worker.js:846-861). Behaviour 6 says such a reconnect cancels path 6.
//
// In bullmq 5.76.7 the reconnect is deterministic but not the pause's own:
// ioredis Cluster.disconnect() empties the node pool before the status reaches
// `end` (ioredis cluster/index.js:206-229), the aborted BZPOPMIN's wrapper sees
// a cluster with no nodes and reconnects it (bullmq redis-connection.js:214-231,
// 305-321), and the pause's own reconnect() (worker.js:860) then rejects with
// "Redis is already connecting/connected" (ioredis cluster/index.js:113-116).
// The ordering is read from the events (`ready` about 4 ms after `end`), not
// traced in a debugger. Either outcome of the pause is accepted; the test
// requires `end`, then `ready`, then a status of `ready`.
test('a_blocking_client_that_ends_and_reconnects_does_not_trigger_the_connection_ended_exit', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add } = wedge.queue(provider.prefix);

  await waitForBlockingInBzpopmin(wedge.cluster);
  provider.send('pause-worker-wait');

  const ended = await provider.waitForEvent('blocking-end', 30_000);

  expect(ended.detail.closing, 'premise: the end is not part of a close').toBe(false);

  const ready = await provider
    .waitForEvent('blocking-ready', 30_000, (e) => e.at >= ended.at)
    .catch((error: Error) => {
      throw new Error(`premise: the blocking client did not reconnect after the waiting pause. ${error.message}`);
    });

  const paused = await Promise.race([
    provider.waitForEvent('pause-worker-wait-done', 30_000),
    provider.waitForEvent('pause-worker-wait-error', 30_000),
  ]);

  if (paused.event === 'pause-worker-wait-error') {
    expect(paused.detail.message, 'the only failure seen is the reconnect race').toBe(
      'Redis is already connecting/connected',
    );
  }

  provider.send('blocking-status');
  expect(
    (await provider.waitForEvent('blocking-status', 5_000)).detail.status,
    'premise: the client is ready again',
  ).toBe('ready');

  // Path 6 pings every CHECK; a provider that ignored the reconnect would exit
  // at the first ping. Watched from `ready` for four intervals while paused,
  // and three more after the resume.
  await expectNoExitFor(provider, Math.max(0, ready.at + 4 * CHECK * 1000 - Date.now()), 'paused, client reconnected');

  provider.send('resume-worker');
  await provider.waitForEvent('worker-resumed', 10_000);
  await expectNoExitFor(provider, 3 * CHECK * 1000, 'resumed');

  await add('w47.sleep', { label: 'after-reconnect' });
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'after-reconnect');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the job ran');
});

// F9: a job enqueued while Redis is down is not lost: after the wedged process
// exits, a replacement on the same queue processes it.
test('a_job_enqueued_during_the_outage_is_processed_by_the_replacement_process', async ({ wedge }) => {
  test.setTimeout(240_000);

  const first = await wedge.provider();
  const { add } = wedge.queue(first.prefix);

  await waitForBlockingInBzpopmin(wedge.cluster);
  await wedge.cluster.pauseNodes();

  // Queue.add waits in the producer's offline queue while the nodes are frozen.
  const enqueued = add('w47.sleep', { label: 'during-outage' });

  try {
    await Promise.race([first.waitForEvent('blocking-end', 60_000), first.exit]);
  } finally {
    await wedge.cluster.unpauseNodes();
  }

  await wedge.cluster.waitForClusterOk();
  await enqueued;

  const exit = await first.exitWithin((STALL + 4 * CHECK + DRAIN + 20) * 1000);

  expect(exit, `the wedged process exits.\nstderr:\n${first.stderr()}`).not.toBeNull();
  expect(exit?.code).toBe(1);
  expect(
    [...exitLine(first, CONNECTION_ENDED_LINE), ...exitLine(first, WEDGED_LINE)],
    'the exit is explained by one of the two lines',
  ).toHaveLength(1);

  const replacement = await wedge.provider({ prefix: first.prefix });

  await replacement.waitForEvent('job-end', 60_000, (e) => e.detail.label === 'during-outage');
});

// F5: a graceful close emits `end` on the blocking client (bullmq 5.76.7);
// neither exit path may read that as a wedge.
test('graceful_close_of_a_healthy_worker_exits_0_and_logs_neither_line', async ({ wedge }) => {
  test.setTimeout(120_000);

  const provider = await wedge.provider({ env: { W47_LINGER_AFTER_CLOSE_MS: String(3 * CHECK * 1000) } });

  await waitForBlockingInBzpopmin(wedge.cluster);
  provider.send('close');

  const exit = await provider.exitWithin(60_000);

  expect(exit, 'the child exits after close').not.toBeNull();
  expect(exit?.code, `stderr:\n${provider.stderr()}`).toBe(0);
  expect(provider.events().some((e) => e.event === 'closed')).toBe(true);
  expect(exitLine(provider, CONNECTION_ENDED_LINE)).toHaveLength(0);
  expect(exitLine(provider, WEDGED_LINE)).toHaveLength(0);
  // Premise: the close did end the blocking client, so path 6 had an `end` to ignore.
  expect(
    provider.events().some((e) => e.event === 'blocking-end' && e.detail.closing === true),
    'the blocking client emitted end during the close',
  ).toBe(true);
});

// F5: close() stops the stall check. The close is sent after one check could
// have seen the job overdue and before a second could confirm it.
test('close_while_a_wedge_is_one_check_from_confirmed_exits_0_and_logs_neither_line', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({
    env: { [IGNORE_CONNECTION_END_VAR]: 'true', W47_LINGER_AFTER_CLOSE_MS: String((STALL + 3 * CHECK) * 1000) },
  });
  const { add } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const job = await add('w47.sleep', { label: `overdue-${randomUUID()}` });

  await sleep(Math.max(0, job.timestamp + (STALL + CHECK / 2) * 1000 - Date.now()));
  provider.send('close');

  const exit = await provider.exitWithin(90_000);

  expect(exit, 'the child exits after close').not.toBeNull();
  expect(exit?.code, `stderr:\n${provider.stderr()}`).toBe(0);
  expect(exitLine(provider, CONNECTION_ENDED_LINE)).toHaveLength(0);
  expect(exitLine(provider, WEDGED_LINE)).toHaveLength(0);
});

// A7 (behaviour 7), F5: close() while a confirmed wedge is draining ends in a
// graceful close. Path 6 is off, so only the stall check can confirm the wedge.
// One slot holds a job that runs until the Worker is paused and then 15 s more,
// longer than DRAIN, so the drain is still waiting on it when close is sent.
//
// The drain has begun when the child sees the Worker paused: nothing else
// pauses it here, and the provider pauses it on a confirmed wedge (behaviour 5).
// Close is sent at once. The child lingers DRAIN + 3 s after close() returns
// before it exits 0, so a drain deadline that close() failed to cancel fires
// while the process is still alive and shows as exit 1 with the line. The test
// checks that the process did outlive the drain window measured from the pause.
test('close_while_a_confirmed_wedge_is_draining_exits_0_and_logs_neither_line', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({
    env: { [IGNORE_CONNECTION_END_VAR]: 'true', W47_LINGER_AFTER_CLOSE_MS: String((DRAIN + 3) * 1000) },
  });
  const { add } = wedge.queue(provider.prefix);

  await add('w47.sleep', { label: 'held-through-close', untilWorkerPaused: true, afterPauseMs: 15_000 });
  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'held-through-close');
  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const backlog = await add('w47.sleep', { label: `overdue-${randomUUID()}` });
  const paused = await provider.waitForEvent(
    'worker-paused',
    Math.max(0, backlog.timestamp + (STALL + 3 * CHECK + 8) * 1000 - Date.now()),
  );

  provider.send('close');

  const closing = await provider.waitForEvent('closing', 5_000);
  const heldEnd = () => provider.events().find((e) => e.event === 'job-end' && e.detail.label === 'held-through-close');

  expect(provider.hasExited(), 'premise: the wedge was confirmed but the process had not exited').toBe(false);
  expect(closing.at, 'premise: close was sent after the drain began').toBeGreaterThanOrEqual(paused.at);
  expect(heldEnd()?.at ?? Infinity, 'premise: the held job was still running when close was sent').toBeGreaterThan(
    closing.at,
  );

  const exit = await provider.exitWithin(90_000);

  expect(exit, 'the child exits after close').not.toBeNull();
  expect(exit?.code, `stderr:\n${provider.stderr()}`).toBe(0);
  expect(
    provider.events().some((e) => e.event === 'closed'),
    'close() returned',
  ).toBe(true);
  expect(exitLine(provider, CONNECTION_ENDED_LINE)).toHaveLength(0);
  expect(exitLine(provider, WEDGED_LINE)).toHaveLength(0);
  expect(
    (exit?.at ?? 0) - paused.at,
    'the process outlived the drain window, so a drain that close() left running would have exited first',
  ).toBeGreaterThanOrEqual(DRAIN * 1000 + 1_000);
});
