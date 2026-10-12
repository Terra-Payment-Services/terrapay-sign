/**
 * the stall check finds a wedged Worker from the queue alone (behaviours
 * 1, 3, 4, 5). Integration level: the real BullMQJobProvider in a child
 * process against a real three-master Redis Cluster. Written from
 * its specification alone.
 *
 * The Worker is wedged deterministically in Mode A (the nodes are frozen until
 * its blocking client ends) with path 6 turned off by the test-only setting
 * NEXT_PRIVATE_JOBS_TEST_IGNORE_CONNECTION_END=true, so that only the stall
 * check can end the process. Work is enqueued after the wedge, because a
 * working Worker would take it.
 *
 * | Test                                                          | Behaviour | Failure modes |
 * | ------------------------------------------------------------- | --------- | ------------- |
 * | overdue waiting job: exit 1, line on stderr with id, name, age | 1, 3-5    | F6, F4        |
 * | overdue delayed job                                            | 1         | F2            |
 * | only a cron occurrence, overdue in delayed                     | 1         | F2            |
 * | prioritized backlog: the oldest job, not the highest priority  | 1         | F12           |
 * | delayed job after changeDelay: due from the delayed score       | 1         | F12, F2       |
 * | held job finishes during the drain, then exit                  | 5         | F11           |
 * | held job longer than DRAIN does not hold the exit past DRAIN    | 5         | F11           |
 * | a wedged check older than 3 CHECK does not pair with a new one  | 4         | F4            |
 *
 * Timing. Overdue means due for longer than STALL; the exit needs two wedged
 * checks at least one CHECK apart (behaviour 4). So no exit may come before
 * due + STALL + CHECK (less a half-second for clock rounding), and with Redis
 * readable it should come by due + STALL + 3 CHECK plus a margin.
 */
import { randomUUID } from 'node:crypto';

import { Job } from 'bullmq';

import { expect, test } from './support/fixture';
import {
  CHECK,
  CONNECTION_ENDED_LINE,
  DRAIN,
  exitLine,
  fieldOf,
  IGNORE_CONNECTION_END_VAR,
  type ProviderProcess,
  QUEUE_NAME,
  STALL,
  sleep,
  WEDGED_LINE,
  waitForBlockingInBzpopmin,
  wedgeModeA,
} from './support/provider-process';
import type { MonitorLine } from './support/redis-cluster';

const PATH_6_OFF = { [IGNORE_CONNECTION_END_VAR]: 'true' };

const EARLIEST_EXIT_AFTER_DUE_MS = (STALL + CHECK) * 1000 - 500;
const LATEST_EXIT_AFTER_DUE_MS = (STALL + 3 * CHECK + 8) * 1000;

type Expected = {
  jobId: string;
  /** Either form of the job's name is accepted: the BullMQ job name or the definition's display name. */
  names: string[];
  dueAt: number;
  held: number;
  running: number;
  /** Added to the latest allowed exit when jobs are held and the drain runs. */
  drainMs?: number;
};

/** The process exits 1 within the window, with one wedged line on stderr carrying what the spec lists. */
const expectWedgedExit = async (provider: ProviderProcess, expected: Expected) => {
  const latest = expected.dueAt + LATEST_EXIT_AFTER_DUE_MS + (expected.drainMs ?? 0);
  const exit = await provider.exitWithin(Math.max(0, latest - Date.now()) + 1_000);

  expect(
    exit,
    `the wedged process exits by due + ${LATEST_EXIT_AFTER_DUE_MS} ms.\nstderr:\n${provider.stderr()}`,
  ).not.toBeNull();
  expect(exit?.code).toBe(1);

  const exitAt = exit?.at ?? Date.now();

  expect(
    exitAt - expected.dueAt,
    'no exit before two wedged checks one interval apart, both after the job was overdue',
  ).toBeGreaterThanOrEqual(EARLIEST_EXIT_AFTER_DUE_MS);

  const lines = exitLine(provider, WEDGED_LINE);

  expect(lines, `one wedged line on stderr:\n${provider.stderr()}`).toHaveLength(1);
  expect(exitLine(provider, CONNECTION_ENDED_LINE), 'path 6 is off in these specs').toHaveLength(0);

  const [line] = lines;

  expect(line, 'the line names the overdue job by id').toContain(expected.jobId);
  expect(
    expected.names.some((name) => line.includes(name)),
    `the line names the job (${expected.names.join(' or ')}): ${line}`,
  ).toBe(true);

  const age = fieldOf(line, 'age');

  expect(age, `the line carries the job's age in seconds: ${line}`).not.toBeNull();
  expect(age ?? 0, 'the age is how long the job has been due, past STALL').toBeGreaterThanOrEqual(STALL);
  expect(age ?? 0, 'the age is measured from the due time, not from an earlier one').toBeLessThanOrEqual(
    (exitAt - expected.dueAt) / 1000 + 1,
  );

  expect(fieldOf(line, 'held'), `jobs held at detection: ${line}`).toBe(expected.held);
  expect(fieldOf(line, 'running'), `jobs still running at exit: ${line}`).toBe(expected.running);

  return { exitAt, line };
};

const SLEEP_NAMES = ['w47.sleep', 'W47 Sleep'];

/** BullMQ numbers jobs 1, 2, 3, which any count or age in the line could contain. These ids cannot be mistaken. */
const jobIdFor = (label: string) => `w47-${label}-${randomUUID()}`;

// F6, F4: the basic canary. Exit 1, the line on stderr with id, name and age,
// and not before a second wedged check.
test('a_waiting_job_overdue_on_a_wedged_worker_exits_1_with_the_job_id_name_and_age_on_stderr', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, queue } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const job = await add('w47.sleep', { label: 'waiting' }, { jobId: jobIdFor('waiting') });

  await sleep(STALL * 1000);
  expect(await (await Job.fromId(queue, job.id ?? ''))?.getState(), 'premise: the wedged Worker did not take it').toBe(
    'waiting',
  );

  await expectWedgedExit(provider, {
    jobId: job.id ?? '',
    names: SLEEP_NAMES,
    dueAt: job.timestamp,
    held: 0,
    running: 0,
  });
});

// F2: a delayed job is promoted only by a working Worker's fetch, so on a wedged
// Worker it stays in `delayed` past its due time.
test('a_delayed_job_overdue_on_a_wedged_worker_exits_1', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, delayedDueAt, firstDelayed } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const job = await add('w47.sleep', { label: 'delayed' }, { delay: 1_000, jobId: jobIdFor('delayed') });
  const dueAt = (await delayedDueAt(job.id ?? '')) ?? 0;

  expect(dueAt, 'premise: the job is in the delayed set').toBeGreaterThan(0);

  await sleep(Math.max(0, dueAt + STALL * 1000 - Date.now()));
  expect((await firstDelayed())?.id, 'premise: still delayed after it fell due').toBe(job.id);

  await expectWedgedExit(provider, { jobId: job.id ?? '', names: SLEEP_NAMES, dueAt, held: 0, running: 0 });
});

// F2: with only cron work, the next occurrence of the scheduler sits in
// `delayed` and falls overdue when the Worker stops fetching.
test('a_wedged_worker_with_only_a_cron_occurrence_overdue_exits_1', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: { ...PATH_6_OFF, W47_CRON: '*/2 * * * * *' } });
  const { firstDelayed } = wedge.queue(provider.prefix);

  // Premise: the scheduler runs while the Worker works.
  await provider.waitForEvent('cron-run', 30_000);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const occurrence = await firstDelayed();

  expect(occurrence?.id, 'premise: the next cron occurrence waits in delayed').toMatch(/^repeat:/);

  await expectWedgedExit(provider, {
    jobId: occurrence?.id ?? '',
    names: ['w47.cron', 'W47 Cron'],
    dueAt: occurrence?.dueAt ?? 0,
    held: 0,
    running: 0,
  });
});

// F12: the prioritized set is ordered by priority. The older, lower-priority job
// is the most overdue and is the one reported.
test('a_prioritized_backlog_on_a_wedged_worker_exits_1_naming_its_oldest_job_not_its_first', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, queue } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const older = await add('w47.sleep', { label: 'older-low-priority' }, { priority: 10, jobId: jobIdFor('older') });

  await sleep(4_000);

  const newer = await add('w47.sleep', { label: 'newer-high-priority' }, { priority: 1, jobId: jobIdFor('newer') });

  expect(await (await Job.fromId(queue, older.id ?? ''))?.getState(), 'premise: prioritized').toBe('prioritized');

  const { line } = await expectWedgedExit(provider, {
    jobId: older.id ?? '',
    names: SLEEP_NAMES,
    dueAt: older.timestamp,
    held: 0,
    running: 0,
  });

  expect(line, 'the newer job is not the most overdue').not.toContain(newer.id ?? '');
});

// F12, F2: after changeDelay the job keeps its creation timestamp and records
// the new delay, so timestamp + delay lies 15 s before the real due time. The
// due time is the delayed score over 0x1000.
test('a_delayed_job_after_change_delay_is_judged_by_its_delayed_score', async ({ wedge }) => {
  test.setTimeout(180_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, delayedDueAt } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const job = await add('w47.sleep', { label: 'changed' }, { delay: 3_600_000, jobId: jobIdFor('changed') });

  await sleep(15_000);
  await job.changeDelay(1_000);

  const dueAt = (await delayedDueAt(job.id ?? '')) ?? 0;

  expect(dueAt - (job.timestamp + 1_000), 'premise: timestamp + delay is well before the score').toBeGreaterThanOrEqual(
    14_000,
  );

  await expectWedgedExit(provider, { jobId: job.id ?? '', names: SLEEP_NAMES, dueAt, held: 0, running: 0 });
});

// F11: on a confirmed wedge the provider pauses the Worker and waits for the job
// it holds. Here that job finishes a second after the pause, inside DRAIN.
test('a_held_job_that_finishes_during_the_drain_finishes_before_the_exit', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add } = wedge.queue(provider.prefix);

  const held = await add('w47.sleep', { label: 'held', untilWorkerPaused: true, afterPauseMs: 1_000 });

  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'held');
  // One of two slots is busy and the Worker blocks for the other.
  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const backlog = await add('w47.sleep', { label: 'backlog' }, { jobId: jobIdFor('backlog') });

  const { exitAt } = await expectWedgedExit(provider, {
    jobId: backlog.id ?? '',
    names: SLEEP_NAMES,
    dueAt: backlog.timestamp,
    held: 1,
    running: 0,
    drainMs: DRAIN * 1000,
  });

  const paused = provider.events().find((e) => e.event === 'worker-paused');
  const ended = provider.events().find((e) => e.event === 'job-end' && e.detail.label === 'held');

  expect(paused, 'the Worker was paused before the exit').toBeDefined();
  expect(ended, `the held job (${held.id}) finished`).toBeDefined();
  expect(ended?.at ?? Infinity, 'the held job finished before the exit').toBeLessThanOrEqual(exitAt);
});

// F11: a held job longer than DRAIN does not hold the exit beyond DRAIN plus a
// margin, and the exit does not come before DRAIN either.
test('a_held_job_longer_than_drain_does_not_hold_the_exit_past_drain', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add } = wedge.queue(provider.prefix);

  await add('w47.sleep', { label: 'long', ms: 600_000 });
  await provider.waitForEvent('job-start', 30_000, (e) => e.detail.label === 'long');
  await waitForBlockingInBzpopmin(wedge.cluster);
  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const backlog = await add('w47.sleep', { label: 'backlog' }, { jobId: jobIdFor('backlog') });

  const { exitAt } = await expectWedgedExit(provider, {
    jobId: backlog.id ?? '',
    names: SLEEP_NAMES,
    dueAt: backlog.timestamp,
    held: 1,
    running: 1,
    drainMs: DRAIN * 1000,
  });

  const paused = provider.events().find((e) => e.event === 'worker-paused');

  expect(paused, 'the Worker was paused when the wedge was confirmed').toBeDefined();
  expect(exitAt - (paused?.at ?? 0), 'the exit waits for DRAIN').toBeGreaterThanOrEqual(DRAIN * 1000 - 500);
  expect(exitAt - (paused?.at ?? 0), 'and no longer than DRAIN plus a margin').toBeLessThanOrEqual(
    DRAIN * 1000 + 3_000,
  );
});

// F4, behaviour 4: a wedged observation expires. Exactly one check sees the job
// overdue, then every read is refused for longer than 3 CHECK, then reads work
// again. The first check after the gap is the first of a new pair, so the exit
// waits one more interval; a provider that paired it with the old observation
// would exit on it.
//
// The checks are observed, not assumed. MONITOR on the nodes shows each check's
// direct read of the `wait` list (an LINDEX on HEAD; any direct read of the key
// counts), and with the Worker wedged nothing else reads that key outside a
// script. The job's enqueue time is placed so that it falls overdue 400 ms after
// a check, which the measured cadence (2000 ms, within a few ms) predicts. The
// next check, about 1.6 s after the job fell overdue, is then the first to see
// it overdue under any rounding of the age to whole seconds, and the one before
// it saw the job not yet overdue.
//
// Reads are refused with an ACL that leaves the connections and the slot map
// alone: every keyspace and script command gets NOPERM at once. A NOPERM reply
// is a check that "cannot" read (behaviour 4), so it is inconclusive. Freezing
// the nodes instead would leave reads in flight that land when they thaw, which
// blurs which check is the first after the gap, and stopping them would lose
// the job, since the nodes keep nothing on disk. A provider that reset its count
// on an inconclusive check, rather than ignoring it, would time its exit the
// same way here, so this test pins the expiry and not that distinction.
//
// Margins. Times are taken on this process's clock as MONITOR lines arrive,
// a few milliseconds after the read, and the child stamps its exit on the same
// clock. No exit may come before the first check after the gap plus CHECK, less
// 500 ms for pipe latency and jitter. The exit must come by that check plus
// CHECK plus 3 s: no job is held, so the drain does not wait.
test('a_wedged_observation_older_than_three_checks_does_not_pair_with_a_new_one', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const monitor = wedge.cluster.monitor();
  const timeline: Record<string, number> = {};

  try {
    const waitKey = `"${provider.prefix}:${QUEUE_NAME}:wait"`;
    const isCheckRead = (line: MonitorLine) =>
      line.line.includes(waitKey) && !line.line.includes('[0 lua]') && !/\] "(evalsha|eval)" /i.test(line.line);
    const checkReads = (from: number, to: number) =>
      monitor.lines().filter((line) => isCheckRead(line) && line.at > from && line.at <= to);

    // The cadence, from three consecutive checks.
    const first = await monitor.waitFor(isCheckRead, 15_000);
    const third = await monitor.waitFor(isCheckRead, 15_000, first.at + CHECK * 1000 + 500);
    const period = (third.at - first.at) / 2;

    expect(period, 'premise: the checks run every CHECK').toBeGreaterThan(CHECK * 1000 - 200);
    expect(period, 'premise: the checks run every CHECK').toBeLessThan(CHECK * 1000 + 200);

    // The job falls overdue 400 ms after a predicted check.
    const earliestAdd = Date.now() + 500;
    const ticks = Math.ceil((earliestAdd + STALL * 1000 - 400 - third.at) / period);

    await sleep(Math.max(0, third.at + ticks * period + 400 - STALL * 1000 - Date.now()));

    const job = await add('w47.sleep', { label: 'expiry' }, { jobId: jobIdFor('expiry') });
    const overdueAt = job.timestamp + STALL * 1000;

    timeline.overdueAt = overdueAt;

    const seen = await monitor.waitFor(isCheckRead, (STALL + 2 * CHECK) * 1000, overdueAt);

    timeline.seenOverdue = seen.at;

    expect(
      seen.at - overdueAt,
      'premise: the first check after the job fell overdue saw it at least 1 s overdue',
    ).toBeGreaterThanOrEqual(1_000);
    expect(seen.at - overdueAt, 'premise: and was the first check to see it overdue').toBeLessThan(CHECK * 1000);

    let deniedAt = 0;
    let allowedAt = 0;

    // Let the check finish its reads, then refuse every read before the next.
    await sleep(200);

    try {
      await wedge.cluster.denyReads();
      deniedAt = Date.now();
      timeline.deniedAt = deniedAt;

      expect(deniedAt - seen.at, 'premise: reads were refused before the next check').toBeLessThan(period - 300);
      expect(checkReads(seen.at, deniedAt), 'premise: exactly one check saw the job overdue').toHaveLength(0);
      expect(provider.hasExited(), 'premise: one wedged check did not exit').toBe(false);

      const gap = await provider.exitWithin((3 * CHECK + 3) * 1000);

      expect(gap, `no exit while every read is refused.\nstderr:\n${provider.stderr()}`).toBeNull();
    } finally {
      await wedge.cluster.allowReads();
      allowedAt = Date.now();
      timeline.allowedAt = allowedAt;
    }

    expect(checkReads(deniedAt + 100, allowedAt - 100), 'premise: no check read Redis during the gap').toHaveLength(0);

    const after = await monitor.waitFor(isCheckRead, (2 * CHECK + 6) * 1000, deniedAt + 100);

    timeline.firstCheckAfterGap = after.at;

    expect(after.at - seen.at, 'premise: the old observation is older than 3 CHECK').toBeGreaterThan(
      (3 * CHECK + 1) * 1000,
    );

    const early = await provider.exitWithin(Math.max(0, after.at + CHECK * 1000 - 500 - Date.now()));

    expect(
      early,
      `no exit on the first check after the gap: it pairs with nothing.\nstderr:\n${provider.stderr()}`,
    ).toBeNull();

    const exit = await provider.exitWithin(Math.max(0, after.at + CHECK * 1000 + 3_000 - Date.now()));

    timeline.exitAt = exit?.at ?? 0;
    expect(exit, `exit after a second fresh wedged check.\nstderr:\n${provider.stderr()}`).not.toBeNull();
    expect(exit?.code).toBe(1);

    const lines = exitLine(provider, WEDGED_LINE);

    expect(lines, 'one wedged line on stderr').toHaveLength(1);
    expect(lines[0], 'the line names the overdue job').toContain(job.id ?? '');
    expect(
      checkReads(after.at + CHECK * 1000 - 500, (exit?.at ?? 0) + 100),
      'the exit follows a second check after the gap',
    ).not.toHaveLength(0);
  } finally {
    monitor.stop();
    await test.info().attach('timeline.json', {
      body: JSON.stringify(
        {
          ...timeline,
          checkReads: monitor
            .lines()
            .filter((l) => l.line.includes(`${provider.prefix}:${QUEUE_NAME}:wait"`))
            .map((l) => l.at),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
});
