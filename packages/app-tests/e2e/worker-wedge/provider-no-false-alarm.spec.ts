/**
 * the stall check leaves a Worker alone when it is not wedged (behaviours
 * 2, 3, 4, 7). Integration level: the real BullMQJobProvider in a child process
 * against a real three-master Redis Cluster. Written from
 * its specification alone.
 *
 * Every test here asserts that the process does not exit. Before the provider
 * implements the check they pass without testing anything, because nothing
 * exits today; they start to mean something once the check exists, and each
 * then fails on the specific mistake named in its comment.
 *
 * | Test                                                            | Behaviour | Failure modes |
 * | --------------------------------------------------------------- | --------- | ------------- |
 * | every slot busy on long jobs, backlog overdue: no exit            | 3         | F3            |
 * | full outage longer than three checks: no exit while down          | 4         | F4            |
 * | reads time out for longer than three checks: no exit, no overlap  | 4, A3     | F4            |
 * | Worker recovers on its own after an outage: no exit, backlog runs | 7         | F7            |
 * | healthy Worker, cron running, a far-off delayed job: no exit      | 1, 7      | F7, F2        |
 * | retried job whose timestamp + delay is past but score is not      | 1         | F12           |
 * | queue paused with an overdue backlog: no exit                     | 2         | F10           |
 * | queue rate-limited with an overdue backlog: no exit               | 2         | F10           |
 * | Worker paused with an overdue backlog: no exit                    | 2         | F10           |
 * | global concurrency 1, one long job active, overdue backlog: no exit | 2, A1     | F10, F3       |
 *
 * The three suppression tests (behaviour 2) prove their premise throughout the
 * watch: every half second the backlog is checked to be still in Redis, in the
 * list it should be in, and not started by the Worker. Without that a backlog
 * the Worker took at once would pass for one held back. Two such cases were
 * found in bullmq 5.76.7:
 *
 * - `worker.pause(true)` does not abort a BZPOPMIN already in flight
 *   (worker.js:678-694 only sets `paused`; only the waiting pause disconnects
 *   the blocking client, worker.js:846-861). When the blocking call returns,
 *   `_getNextJob` calls moveToActive without looking at `paused` again
 *   (worker.js:365-372), and the main loop processes what it fetched
 *   (worker.js:290). A job added just after pause(true) is processed at once.
 *   The test therefore waits until `isRunning()` turns false, which happens when
 *   the main loop has returned (worker.js:244-268), before adding.
 * - `queue.rateLimit()` sets the limiter key's TTL, which `getRateLimitTtl()`
 *   reports, but moveToActive honours that key only when a maximum is known,
 *   from the Worker's `limiter` option or the queue's `meta.max`
 *   (moveToActive-11.lua:62-66, includes/getRateLimitTTL.lua:4-5). The
 *   provider's Worker has no `limiter`, so a bare `queue.rateLimit()` holds
 *   nothing back. The test sets a global rate limit
 *   (`queue.setGlobalRateLimit`, which writes `meta.max`) first, so the
 *   Worker really is limited.
 */
import { Job, type Queue } from 'bullmq';

import { expect, test } from './support/fixture';
import {
  CHECK,
  CONNECTION_ENDED_LINE,
  exitLine,
  IGNORE_CONNECTION_END_VAR,
  type ProviderProcess,
  QUEUE_NAME,
  STALL,
  STALL_VAR,
  sleep,
  WEDGED_LINE,
  waitForBlockingInBzpopmin,
} from './support/provider-process';
import type { MonitorLine } from './support/redis-cluster';

/** Long enough for a wrong implementation to see two wedged checks on an overdue job. */
const WATCH_PAST_OVERDUE_MS = (4 * CHECK + 6) * 1000;

const expectStillRunning = (provider: ProviderProcess, context: string) => {
  expect(provider.hasExited(), `${context}: the process is still running.\nstderr:\n${provider.stderr()}`).toBe(false);
  expect(exitLine(provider, WEDGED_LINE), `${context}: no wedged line`).toHaveLength(0);
  expect(exitLine(provider, CONNECTION_ENDED_LINE), `${context}: no connection-ended line`).toHaveLength(0);
};

/** Waits the given time, failing at once if the process exits during it. */
const expectNoExitFor = async (provider: ProviderProcess, ms: number, context: string) => {
  const exit = await provider.exitWithin(ms);

  expect(exit, `${context}: no exit within ${ms} ms.\nstderr:\n${provider.stderr()}`).toBeNull();
  expectStillRunning(provider, context);
};

/**
 * Watches for the given time and, every half second, checks that the process is
 * still running, that none of the labelled jobs has started, and that the
 * caller's premise still holds. Fails at the first check that does not.
 */
const expectHeldWithoutExit = async (
  provider: ProviderProcess,
  ms: number,
  context: string,
  labels: string[],
  premise: () => Promise<void>,
) => {
  const deadline = Date.now() + ms;
  let checks = 0;

  while (Date.now() < deadline) {
    const exit = await provider.exitWithin(Math.min(500, Math.max(0, deadline - Date.now())));

    expect(exit, `${context}: no exit.\nstderr:\n${provider.stderr()}`).toBeNull();
    expect(
      provider.events().filter((e) => e.event === 'job-start' && labels.includes(String(e.detail.label))),
      `${context}: premise: the backlog is held back, not taken by the Worker`,
    ).toHaveLength(0);
    await premise();
    checks += 1;
  }

  expectStillRunning(provider, context);
  expect(checks, `${context}: the premise was checked throughout`).toBeGreaterThanOrEqual(Math.floor(ms / 1_000));
};

/** Whether the job is in the given list (wait or paused) of the queue. */
const isInList = async (queue: Queue, prefix: string, list: 'wait' | 'paused', jobId: string) => {
  const client = await queue.client;

  return (await client.lpos(`${prefix}:${QUEUE_NAME}:${list}`, jobId)) !== null;
};

// F3: a Worker with every slot busy on long jobs is not wedged, however old the
// backlog behind it.
test('a_worker_with_every_slot_busy_on_long_jobs_is_not_killed_while_a_backlog_waits', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add } = wedge.queue(provider.prefix);

  await add('w47.sleep', { label: 'long-1', ms: 45_000 });
  await add('w47.sleep', { label: 'long-2', ms: 45_000 });
  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'long-1');
  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'long-2');

  const backlog = await Promise.all(['b1', 'b2', 'b3'].map(async (label) => await add('w47.sleep', { label })));

  await sleep(Math.max(0, backlog[0].timestamp + STALL * 1000 - Date.now()));
  await expectNoExitFor(provider, WATCH_PAST_OVERDUE_MS, 'backlog overdue behind two busy slots');

  for (const label of ['b1', 'b2', 'b3']) {
    await provider.waitForEvent('job-end', 60_000, (e) => e.detail.label === label);
  }

  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the backlog ran');
});

// F4: a check that cannot read Redis is inconclusive. With every node stopped
// for longer than three checks, nothing may exit. Path 6 is off so that only
// the stall check is under test.
test('a_full_outage_longer_than_three_checks_does_not_exit_while_redis_is_down', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: { [IGNORE_CONNECTION_END_VAR]: 'true' } });

  await waitForBlockingInBzpopmin(wedge.cluster);
  await wedge.cluster.stopNodes();

  try {
    await expectNoExitFor(provider, (5 * CHECK + 5) * 1000, 'every node stopped');
  } finally {
    await wedge.cluster.startNodes();
  }

  await wedge.cluster.waitForClusterOk();
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the nodes returned');
});

// F4: a check whose read times out (5 s) is inconclusive. Frozen nodes keep
// sockets open and answer nothing, so every read times out.
//
// A3: checks never overlap. A timed-out read is inconclusive, but the next check
// does not start until it has settled, so at most one watchdog read is
// outstanding at any time. Here no read can settle until the nodes thaw, so a
// compliant provider issues one round of reads, the round that met the freeze,
// and then nothing more until the thaw.
//
// The evidence is MONITOR on every node. `docker pause` freezes the
// `redis-cli monitor` inside each container too, so nothing arrives during the
// freeze. A command written into a frozen node's socket waits in the socket and
// runs when the node thaws, so every read the provider issued during the freeze
// arrives in one burst just after the thaw, and the burst counts them. The
// burst is counted per distinct command and key (LINDEX on wait, HEXISTS on
// meta and so on), which needs no knowledge of what a check reads or in what
// order: whatever a check's first read is, it is issued once per check.
//
// The arithmetic, over a freeze of 4 x (CHECK + 5) = 28 s. Amendment v4 (B3)
// gives the check's connection a 5 s command timeout, so a read that meets the
// freeze settles, as a rejection, 5 s after it was sent, and the next check may
// then start. Its command still waits in the frozen node's socket and runs at
// the thaw. So:
// - compliant: one round at most every 5 s, at most ceil(28 / 5) = 6 rounds
//   during the freeze, plus 1 that starts at the thaw: at most 7 per command;
// - a provider that starts a check every CHECK while earlier ones hang: ~14.
// So no command and key may appear more than 7 times in the burst. (Before v4,
// with no command timeout, the bound was 2; it was measured at 6 at 44dfa7e0.)
//
// Only direct commands on the queue's keys count. Commands run inside a script
// are tagged `[0 lua]`, and scripts themselves (EVALSHA), which the Worker also
// sends, are left out, as is the Worker's BZPOPMIN. The premise that the check
// does read Redis directly is shown before the freeze: the same direct reads
// recur at the CHECK cadence.
const FREEZE_MS = 4 * (CHECK + 5) * 1000;

test('reads_that_time_out_for_longer_than_three_checks_do_not_exit', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: { [IGNORE_CONNECTION_END_VAR]: 'true' } });

  await waitForBlockingInBzpopmin(wedge.cluster);

  const monitor = wedge.cluster.monitor();
  const queueKey = `"${provider.prefix}:${QUEUE_NAME}:`;
  const directRead = (line: MonitorLine) => {
    const match = /\] "([^"]+)" "([^"]+)"/.exec(line.line);

    if (!match || !line.line.includes(queueKey) || line.line.includes('[0 lua]')) {
      return null;
    }

    const command = match[1].toLowerCase();

    if (command === 'evalsha' || command === 'eval' || command === 'bzpopmin') {
      return null;
    }

    return `${command} ${match[2]}`;
  };
  const countReads = (from: number, to: number) => {
    const counts: Record<string, number> = {};

    for (const line of monitor.lines()) {
      const read = directRead(line);

      if (read && line.at > from && line.at <= to) {
        counts[read] = (counts[read] ?? 0) + 1;
      }
    }

    return counts;
  };
  const timeline: Record<string, number> = {};

  try {
    // Premise: the check reads Redis directly, every CHECK. Three intervals,
    // from the first direct read: at 44dfa7e0 the first one comes about two
    // intervals after the Worker is ready, not one.
    const firstRead = await monitor.waitFor((line) => directRead(line) !== null, 15_000);
    const watchStart = firstRead.at - 1;

    await sleep((3 * CHECK + 1) * 1000);
    timeline.watchStart = watchStart;
    timeline.watchEnd = Date.now();

    const before = countReads(watchStart, timeline.watchEnd);
    const recurring = Object.entries(before).filter(([, count]) => count >= 3);

    expect(
      recurring.length,
      `premise: some direct read recurs at the CHECK cadence before the freeze: ${JSON.stringify(before)}`,
    ).toBeGreaterThan(0);
    expect(
      Math.max(...Object.values(before)),
      `premise: about one read of each kind per CHECK before the freeze: ${JSON.stringify(before)}`,
    ).toBeLessThanOrEqual(5);

    await wedge.cluster.pauseNodes();
    timeline.pausedAt = Date.now();

    try {
      // Checks never overlap, so each takes up to CHECK + 5 s: four of them.
      await expectNoExitFor(provider, FREEZE_MS, 'every node frozen');
    } finally {
      await wedge.cluster.unpauseNodes();
      timeline.thawedAt = Date.now();
    }

    await wedge.cluster.waitForClusterOk();
    await sleep(1_500);

    const burst = countReads(timeline.pausedAt + 300, timeline.thawedAt + 1_500);

    await test.info().attach('a3-read-counts.json', {
      body: JSON.stringify({ before, burst }, null, 2),
      contentType: 'application/json',
    });

    expect(
      Object.keys(burst).length,
      `premise: reads issued during the freeze ran at the thaw: ${JSON.stringify(burst)}`,
    ).toBeGreaterThan(0);

    for (const [read, count] of Object.entries(burst)) {
      expect(count, `A3: "${read}" was issued ${count} times while earlier reads hung`).toBeLessThanOrEqual(
        Math.ceil(FREEZE_MS / 5_000) + 1,
      );
    }

    await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the nodes thawed');
  } finally {
    monitor.stop();
    await test.info().attach('a3-timeline.json', {
      body: JSON.stringify(
        { ...timeline, lines: monitor.lines().filter((line) => line.line.includes(queueKey)) },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
});

// F7: a Worker that recovers on its own after an outage, and processes the
// backlog, is not killed. Stopped nodes here leave the Worker able to recover
// (7 of 7 local trials). STALL is raised to 20 s so the backlog enqueued during
// the 10 s outage is not yet overdue while the Worker reconnects: with CHECK at
// 2 s, two checks could otherwise both fall inside a normal reconnect.
test('a_worker_that_recovers_on_its_own_after_an_outage_is_not_killed', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: { [STALL_VAR]: '20' } });
  const { add } = wedge.queue(provider.prefix);

  await add('w47.sleep', { label: 'before' });
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'before');
  await waitForBlockingInBzpopmin(wedge.cluster);

  await wedge.cluster.stopNodes();

  const enqueued = Promise.all(['o1', 'o2', 'o3'].map(async (label) => await add('w47.sleep', { label })));

  try {
    await expectNoExitFor(provider, 10_000, 'during the outage');
  } finally {
    await wedge.cluster.startNodes();
  }

  await wedge.cluster.waitForClusterOk();
  await enqueued;

  for (const label of ['o1', 'o2', 'o3']) {
    await provider
      .waitForEvent('job-end', 30_000, (e) => e.detail.label === label)
      .catch((error: Error) => {
        throw new Error(`premise: the Worker did not recover on its own after the outage. ${error.message}`);
      });
  }

  await expectNoExitFor(provider, (20 + 3 * CHECK) * 1000, 'after the recovered Worker drained the backlog');
});

// F7, F2: a healthy Worker with a cron scheduler and a delayed job due in an
// hour runs on. Neither is overdue: a scheduler occurrence and a long delay are
// judged by their due time, not by when they were created.
test('a_healthy_worker_with_cron_and_far_off_delayed_work_is_not_killed', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: { W47_CRON: '*/2 * * * * *' } });
  const { add } = wedge.queue(provider.prefix);

  await add('w47.sleep', { label: 'in-an-hour' }, { delay: 3_600_000 });
  await provider.waitForEvent('cron-run', 30_000);

  await expectNoExitFor(provider, (STALL + 6 * CHECK) * 1000, 'cron running, delayed job not yet due');

  expect(
    provider.events().filter((e) => e.event === 'cron-run').length,
    'the scheduler kept running throughout',
  ).toBeGreaterThanOrEqual(5);
});

// F12: a retried job keeps its creation timestamp and records the retry delay,
// so timestamp + delay is in the past while the delayed score is 20 s ahead. A
// check that adds timestamp and delay would call this idle Worker wedged.
test('a_retried_job_whose_timestamp_plus_delay_has_passed_is_judged_by_its_delayed_score', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add, delayedDueAt, queue } = wedge.queue(provider.prefix);

  const job = await add(
    'w47.fail-once',
    { label: 'retried' },
    { delay: 30_000, attempts: 2, backoff: { type: 'fixed', delay: 25_000 } },
  );

  await provider.waitForEvent('job-fail', 60_000, (e) => e.detail.label === 'retried');

  // The handler reports the failure before BullMQ moves the job back to delayed.
  await expect
    .poll(async () => await (await Job.fromId(queue, job.id ?? ''))?.getState(), {
      message: 'premise: back in delayed for its retry',
      timeout: 10_000,
    })
    .toBe('delayed');

  const retried = await Job.fromId(queue, job.id ?? '');
  const dueAt = await delayedDueAt(job.id ?? '');

  expect(dueAt, 'premise: in the delayed set').not.toBeNull();
  expect(
    (dueAt ?? 0) - ((retried?.timestamp ?? 0) + (retried?.delay ?? 0)),
    'premise: timestamp + delay lies well before the real due time',
  ).toBeGreaterThanOrEqual(25_000);

  // From now until the retry falls due, timestamp + delay is more than STALL past.
  await provider
    .waitForEvent('job-end', 60_000, (e) => e.detail.label === 'retried')
    .catch((error: Error) => {
      throw new Error(`the retry did not run: ${error.message}`);
    });
  expectStillRunning(provider, 'up to the retry');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the retry ran');
});

// F10: a paused queue holds its backlog legitimately, and a persisted pause would
// otherwise make every replacement exit too. A plain job added to a paused queue
// goes to its `paused` list, which the stall check does not read (behaviour 1),
// so that job alone would not test the suppression. A prioritized job stays in
// `prioritized` while the queue is paused (addPrioritizedJob-9.lua:106-107), so
// the check does see it overdue, and only the pause stops it counting.
test('a_paused_queue_with_an_overdue_backlog_is_not_read_as_a_wedge', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add, queue } = wedge.queue(provider.prefix);

  await waitForBlockingInBzpopmin(wedge.cluster);
  await queue.pause();

  const plain = await add('w47.sleep', { label: 'while-paused' });
  const prioritized = await add('w47.sleep', { label: 'while-paused-prioritized' }, { priority: 5 });

  const premise = async () => {
    expect(await queue.isPaused(), 'premise: the queue is paused').toBe(true);
    expect(
      await isInList(queue, provider.prefix, 'paused', plain.id ?? ''),
      'premise: the plain job sits in the paused list',
    ).toBe(true);
    expect(
      await (await Job.fromId(queue, prioritized.id ?? ''))?.getState(),
      'premise: the prioritized job sits in prioritized, where the check reads it',
    ).toBe('prioritized');
  };

  await premise();
  await sleep(Math.max(0, prioritized.timestamp + STALL * 1000 - Date.now()));
  await expectHeldWithoutExit(
    provider,
    WATCH_PAST_OVERDUE_MS,
    'queue paused, backlog overdue',
    ['while-paused', 'while-paused-prioritized'],
    premise,
  );

  await queue.resume();
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'while-paused');
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'while-paused-prioritized');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after resume');
});

// F10: while the queue's rate-limit TTL is positive the Worker legitimately
// takes nothing. A bare queue.rateLimit() does not hold the provider's Worker
// back (see the header), so the queue gets a global rate limit first: one job
// per minute, with the limiter then forced over that for 45 s.
test('a_rate_limited_queue_with_an_overdue_backlog_is_not_read_as_a_wedge', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add, queue } = wedge.queue(provider.prefix);

  await waitForBlockingInBzpopmin(wedge.cluster);
  await queue.setGlobalRateLimit(1, 60_000);
  await queue.rateLimit(45_000);

  const backlog = await add('w47.sleep', { label: 'while-limited' });

  const premise = async () => {
    expect(await queue.getRateLimitTtl(), 'premise: the queue is rate-limited').toBeGreaterThan(0);
    expect(
      await isInList(queue, provider.prefix, 'wait', backlog.id ?? ''),
      'premise: the job is still in wait, where the check reads it',
    ).toBe(true);
  };

  await premise();
  await sleep(Math.max(0, backlog.timestamp + STALL * 1000 - Date.now()));
  await expectHeldWithoutExit(
    provider,
    WATCH_PAST_OVERDUE_MS,
    'queue rate-limited, backlog overdue',
    ['while-limited'],
    premise,
  );

  // The Worker looks again at most every 30 s (maximumRateLimitDelay) and takes
  // the job once the 45 s limit has passed.
  await provider.waitForEvent('job-end', 60_000, (e) => e.detail.label === 'while-limited');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the limit expired');
});

// F10: a paused Worker takes nothing by choice. pause(true) leaves a BZPOPMIN in
// flight, and that fetch would still take a job added now (see the header), so
// the job is added only after the main loop has returned.
test('a_paused_worker_with_an_overdue_backlog_is_not_read_as_a_wedge', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add, queue } = wedge.queue(provider.prefix);

  // Pause once the Worker has settled into BZPOPMIN; a pause during start-up
  // races bullmq's own reconnect of the blocking client.
  await waitForBlockingInBzpopmin(wedge.cluster);
  provider.send('pause-worker');
  await provider.waitForEvent('pause-worker-done', 30_000);
  await provider.waitForEvent('worker-stopped', 30_000).catch((error: Error) => {
    throw new Error(`premise: the paused Worker's main loop did not return. ${error.message}`);
  });

  const backlog = await add('w47.sleep', { label: 'worker-paused' });

  const premise = async () => {
    expect(
      provider.events().some((e) => e.event === 'worker-resumed' || e.event === 'worker-running'),
      'premise: the Worker stays paused and stopped',
    ).toBe(false);
    expect(
      await isInList(queue, provider.prefix, 'wait', backlog.id ?? ''),
      'premise: the job is still in wait, where the check reads it',
    ).toBe(true);
  };

  await premise();
  await sleep(Math.max(0, backlog.timestamp + STALL * 1000 - Date.now()));
  await expectHeldWithoutExit(
    provider,
    WATCH_PAST_OVERDUE_MS,
    'Worker paused, backlog overdue',
    ['worker-paused'],
    premise,
  );

  provider.send('resume-worker');
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'worker-paused');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after resume');
});

// A1 (behaviour 2), F10, F3: a global concurrency of 1 on the queue, below the
// Worker's own concurrency of 2, leaves the Worker one slot free while the
// queue lets nothing more start. A check that looked only at the Worker's held
// count would see a free slot, an overdue job and no progress, and call it
// wedged; a persisted global limit would then kill every replacement too.
//
// The hold is BullMQ's, read from 5.76.7: with `concurrency` in the queue's
// meta and LLEN active at or above it, getTargetQueueList.lua reports the queue
// maxed, so an add goes to `wait` without a marker and moveToActive-11.lua
// returns nothing. The premise is checked every half second throughout the
// watch: the limit is still 1, the long job is still the one active job and has
// not ended, and the backlog is still in `wait`, where the check reads it.
test('a_queue_at_its_global_concurrency_with_an_overdue_backlog_is_not_read_as_a_wedge', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider();
  const { add, queue } = wedge.queue(provider.prefix);

  await waitForBlockingInBzpopmin(wedge.cluster);
  await queue.setGlobalConcurrency(1);

  const long = await add('w47.sleep', { label: 'global-long', ms: 45_000 });

  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'global-long');

  const backlog = await add('w47.sleep', { label: 'behind-global-limit' });

  const premise = async () => {
    expect(await queue.getGlobalConcurrency(), 'premise: the queue has a global concurrency of 1').toBe(1);
    expect(await queue.getActiveCount(), 'premise: one job is active, the limit').toBe(1);
    expect(await (await Job.fromId(queue, long.id ?? ''))?.getState(), 'premise: the long job is the active one').toBe(
      'active',
    );
    expect(
      provider.events().some((e) => e.event === 'job-end' && e.detail.label === 'global-long'),
      'premise: the long job is still running',
    ).toBe(false);
    expect(
      await isInList(queue, provider.prefix, 'wait', backlog.id ?? ''),
      'premise: the backlog is still in wait, where the check reads it',
    ).toBe(true);
  };

  await premise();
  await sleep(Math.max(0, backlog.timestamp + STALL * 1000 - Date.now()));
  await expectHeldWithoutExit(
    provider,
    WATCH_PAST_OVERDUE_MS,
    'queue at its global concurrency, backlog overdue',
    ['behind-global-limit'],
    premise,
  );

  // The hold was the limit and not a broken queue: once the long job ends, the
  // backlog runs.
  await provider.waitForEvent('job-end', 60_000, (e) => e.detail.label === 'global-long');
  await provider.waitForEvent('job-end', 30_000, (e) => e.detail.label === 'behind-global-limit');
  await expectNoExitFor(provider, 2 * CHECK * 1000, 'after the backlog ran');
});
