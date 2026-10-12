/**
 * amendment v4: the stall check's reads are bounded (B3, B4). Integration
 * level: the real BullMQJobProvider in a child process against a real
 * three-master Redis Cluster. Written from its specification
 * alone.
 *
 * | Test                                                                 | Behaviour | Failure modes |
 * | -------------------------------------------------------------------- | --------- | ------------- |
 * | Queue's own connection stuck, Redis fine: the check still exits 1     | B3, 1-5   | F1, F4        |
 * |   and its reads come from a connection other than the Queue's        |           |               |
 * | close() closes the check's own connection                            | B3        | F5            |
 * | 150 overdue prioritized jobs on a wedged Worker: exit 1, naming the   | B4, 1     | F12           |
 * |   oldest, with no read of more than 100 members                      |           |               |
 *
 * How the Queue's connection is made stuck while Redis is fine. The child sends
 * `BLPOP <prefix>:w47-stuck 0` through the provider's Queue's own client
 * (`await queue.client`; bullmq uses a passed ioredis instance as is,
 * redis-connection.js:47). The key carries the queue's hash tag, so it lands on
 * the queue's node. Redis runs nothing else a blocked client sends until the
 * block ends, so every later command on that connection to that node waits
 * behind it, for ever. The premise is checked three ways: CLIENT LIST shows the
 * Queue's connection blocked in BLPOP, a GET the child sends through the Queue's
 * connection neither returns nor reaches Redis (it never appears in MONITOR),
 * and the spec's own connection reads that node throughout.
 *
 * A provider whose check, or any read the check depends on (the pause, rate
 * limit or global concurrency reads of behaviour 2), still goes through the
 * Queue's connection never completes a check here: every check is
 * inconclusive and the process does not exit. That is what a failure of the
 * first test means.
 *
 * Which MONITOR lines are the check's reads. As in the expiry test of
 * provider-canary.spec.ts: direct reads of the `wait` list (not inside a
 * script, not EVAL/EVALSHA). With the Worker wedged nothing else reads that key
 * outside a script. MONITOR shows each command's client address as the node
 * sees it, and the child reports the Queue's connection addresses with CLIENT
 * INFO through that connection, so the two are compared in the node's own terms.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from './support/fixture';
import {
  CHECK,
  exitLine,
  fieldOf,
  IGNORE_CONNECTION_END_VAR,
  type ProviderProcess,
  QUEUE_NAME,
  STALL,
  sleep,
  WEDGED_LINE,
  wedgeModeA,
} from './support/provider-process';
import type { MonitorLine, RedisCluster } from './support/redis-cluster';

const PATH_6_OFF = { [IGNORE_CONNECTION_END_VAR]: 'true' };

const EARLIEST_EXIT_AFTER_DUE_MS = (STALL + CHECK) * 1000 - 500;
const LATEST_EXIT_AFTER_DUE_MS = (STALL + 3 * CHECK + 8) * 1000;

/** The client address in a MONITOR line, `1696000000.123456 [0 172.17.0.1:54321] "lindex" ...`. */
const addrOf = (line: MonitorLine) => /^\d+\.\d+ \[\d+ ([^\]]+)\]/.exec(line.line)?.[1] ?? '';

const isScripted = (line: MonitorLine) => line.line.includes('[0 lua]') || /\] "(evalsha|eval)" /i.test(line.line);

/** A direct read of the `wait` list: the stall check's, with the Worker wedged. */
const isCheckReadOf = (prefix: string) => {
  const waitKey = `"${prefix}:${QUEUE_NAME}:wait"`;

  return (line: MonitorLine) => line.line.includes(waitKey) && !isScripted(line);
};

/** The quoted arguments of a MONITOR line, the command first. */
const argsOf = (line: MonitorLine) =>
  [...line.line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, '$1'));

/** The Queue connection's addresses, as the nodes see them. Asked once per provider. */
const queueAddrs = async (provider: ProviderProcess) => {
  provider.send('queue-addrs');

  return (await provider.waitForEvent('queue-addrs', 15_000)).detail.addrs as string[];
};

/** CLIENT LIST lines, from every node, that are blocked in BLPOP. */
const blockedInBlpop = async (cluster: RedisCluster) =>
  (await cluster.clientList()).filter((line) => / cmd=blpop\b/.test(line));

const addrInClientLine = (line: string) => /\baddr=(\S+)/.exec(line)?.[1] ?? '';

// B3: the Queue's own connection is stuck behind a BLPOP that never returns,
// while Redis answers everyone else. The stall check, on a connection of its
// own, still reads the queue, sees the overdue job and exits 1.
test('the_stall_check_detects_a_wedge_while_the_queue_connection_is_stuck_and_redis_is_fine', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, connection } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  // After the outage: every client reconnected, so the addresses are taken now.
  const addrs = await queueAddrs(provider);

  expect(addrs, 'premise: the Queue connection reports one address per master').toHaveLength(3);

  const monitor = wedge.cluster.monitor();
  const isCheckRead = isCheckReadOf(provider.prefix);
  const timeline: Record<string, number> = {};

  try {
    // Premise: MONITOR sees the checks.
    await monitor.waitFor(isCheckRead, 15_000);

    provider.send('block-queue-connection');
    await provider.waitForEvent('block-queue-connection-sent', 5_000);

    await expect
      .poll(async () => (await blockedInBlpop(wedge.cluster)).map(addrInClientLine), {
        message: 'premise: the Queue connection is blocked in BLPOP on a node',
        timeout: 10_000,
      })
      .toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^(${addrs.join('|')})$`))]));

    timeline.blockedAt = Date.now();

    provider.send('queue-probe');
    await provider.waitForEvent('queue-probe-sent', 5_000);

    const job = await add('w47.sleep', { label: 'stuck' }, { jobId: `w47-stuck-${randomUUID()}` });

    timeline.dueAt = job.timestamp;

    // Premise: Redis is fine for everyone but the Queue's connection.
    expect(await connection.get(`${provider.prefix}:w47-fine`), 'the spec reads the same node').toBeNull();

    const exit = await provider.exitWithin(Math.max(0, job.timestamp + LATEST_EXIT_AFTER_DUE_MS - Date.now()) + 1_000);

    timeline.exitAt = exit?.at ?? 0;

    expect(
      exit,
      `the wedged process exits while its Queue connection is stuck.\nstderr:\n${provider.stderr()}`,
    ).not.toBeNull();
    expect(exit?.code).toBe(1);
    expect((exit?.at ?? 0) - job.timestamp, 'not before two wedged checks').toBeGreaterThanOrEqual(
      EARLIEST_EXIT_AFTER_DUE_MS,
    );

    const lines = exitLine(provider, WEDGED_LINE);

    expect(lines, `one wedged line on stderr:\n${provider.stderr()}`).toHaveLength(1);
    expect(lines[0], 'the line names the overdue job').toContain(job.id ?? '');
    expect(fieldOf(lines[0], 'age') ?? 0, 'the age is past STALL').toBeGreaterThanOrEqual(STALL);

    // Premise, held to the end: the Queue's connection stayed stuck.
    const names = provider.events().map((e) => e.event);

    expect(names, 'the BLPOP never returned').not.toContain('block-queue-connection-returned');
    expect(names, 'the probe through the Queue connection never returned').not.toContain('queue-probe-done');
    expect(
      monitor.lines().filter((line) => line.line.includes(`"${provider.prefix}:w47-probe"`)),
      'the probe never reached Redis: it waited behind the BLPOP',
    ).toHaveLength(0);

    // B3: the check's reads, before and after the block, come from a
    // connection other than the Queue's, and keep coming after the block.
    const reads = monitor.lines().filter((line) => isCheckRead(line) && line.at <= (exit?.at ?? 0) + 100);
    const fromQueue = reads.filter((line) => addrs.includes(addrOf(line)));

    expect(
      reads.filter((line) => line.at > timeline.blockedAt).length,
      'the check kept reading after the Queue connection stuck',
    ).toBeGreaterThanOrEqual(2);
    expect(
      fromQueue.map((line) => line.line),
      `no check read came from the Queue connection (${addrs.join(', ')})`,
    ).toEqual([]);
  } finally {
    monitor.stop();
    await test.info().attach('timeline.json', {
      body: JSON.stringify(
        {
          ...timeline,
          queueAddrs: addrs,
          checkReads: monitor
            .lines()
            .filter(isCheckRead)
            .map((line) => ({ at: line.at, addr: addrOf(line), line: line.line })),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
});

// B3: the check's own connection is closed by close(). The child lingers after
// close, so a connection still open would show in CLIENT LIST.
test('close_closes_the_stall_check_connection', async ({ wedge }) => {
  test.setTimeout(120_000);

  const provider = await wedge.provider({ env: { W47_LINGER_AFTER_CLOSE_MS: '15000' } });
  const addrs = await queueAddrs(provider);
  const monitor = wedge.cluster.monitor();
  const isCheckRead = isCheckReadOf(provider.prefix);
  let checkAddrs: string[] = [];

  try {
    const first = await monitor.waitFor(isCheckRead, 15_000);

    await monitor.waitFor(isCheckRead, 15_000, first.at + 100);

    checkAddrs = [...new Set(monitor.lines().filter(isCheckRead).map(addrOf))];

    expect(checkAddrs.length, 'premise: the check reads were seen with their address').toBeGreaterThan(0);
    expect(
      checkAddrs.filter((addr) => addrs.includes(addr)),
      'B3: the check reads over a connection other than the Queue',
    ).toEqual([]);

    const listed = async () =>
      (await wedge.cluster.clientList()).map(addrInClientLine).filter((addr) => checkAddrs.includes(addr));

    expect(await listed(), 'premise: CLIENT LIST shows the check connection while it runs').not.toEqual([]);

    provider.send('close');
    await provider.waitForEvent('closed', 30_000);

    await expect
      .poll(listed, { message: 'B3: the check connection is gone after close()', timeout: 5_000 })
      .toEqual([]);
    expect(provider.hasExited(), 'premise: the process still runs, so close() closed it').toBe(false);

    const exit = await provider.exitWithin(30_000);

    expect(exit?.code, 'graceful close exits 0').toBe(0);
    expect(provider.stderr()).not.toContain(WEDGED_LINE);
  } finally {
    monitor.stop();
    await test.info().attach('check-addrs.json', {
      body: JSON.stringify({ queueAddrs: addrs, checkAddrs }, null, 2),
      contentType: 'application/json',
    });
  }
});

const PRIORITIZED_MAX = 100;

/**
 * Why a direct command on the prioritized set reads more than 100 members, or
 * null when it does not. Counting and scoring commands read no members.
 */
const unboundedRead = (args: string[]): string | null => {
  const [rawCommand, , ...rest] = args;
  const command = rawCommand.toLowerCase();
  const upper = rest.map((arg) => arg.toUpperCase());
  const limitAt = upper.indexOf('LIMIT');
  const limitCount = limitAt >= 0 ? Number(rest[limitAt + 2]) : null;
  const limited = limitCount !== null && limitCount >= 0 && limitCount <= PRIORITIZED_MAX;

  if (['zcard', 'zcount', 'zscore', 'zmscore', 'zrank', 'zrevrank', 'exists', 'type'].includes(command)) {
    return null;
  }

  if (['zrangebyscore', 'zrevrangebyscore', 'zrangebylex', 'zrevrangebylex'].includes(command)) {
    return limited ? null : 'a by-score or by-lex range without LIMIT of at most 100';
  }

  if (command === 'zrange' && (upper.includes('BYSCORE') || upper.includes('BYLEX'))) {
    return limited ? null : 'ZRANGE BYSCORE/BYLEX without LIMIT of at most 100';
  }

  if (command === 'zrange' || command === 'zrevrange') {
    const start = Number(rest[0]);
    const stop = Number(rest[1]);

    if (!Number.isInteger(start) || !Number.isInteger(stop) || start < 0 || stop < 0) {
      return 'an index range that is not two non-negative integers';
    }

    return stop - start + 1 <= PRIORITIZED_MAX ? null : `an index range of ${stop - start + 1} members`;
  }

  return `a member read by ${command}`;
};

const isBoundedRange = (args: string[]) =>
  ['zrange', 'zrevrange', 'zrangebyscore', 'zrevrangebyscore', 'zrangebylex', 'zrevrangebylex'].includes(
    args[0]?.toLowerCase() ?? '',
  ) && unboundedRead(args) === null;

// B4, F12: 150 prioritized jobs at one priority are ordered by when they were
// added, so the first 100 members are the oldest 100. The check finds the oldest,
// exits 1 naming it, and never reads more than 100 members: no range wider than
// 100 on the set, and no direct read of the hash of any of the last 50 jobs.
// The existing prioritized test in provider-canary.spec.ts keeps the case where
// the oldest job is not the highest priority.
test('an_overdue_prioritized_backlog_of_150_exits_1_reading_at_most_100_members', async ({ wedge }) => {
  test.setTimeout(240_000);

  const provider = await wedge.provider({ env: PATH_6_OFF });
  const { add, queue, connection } = wedge.queue(provider.prefix);

  expect(await wedgeModeA(wedge.cluster, provider), 'Mode A reached: the blocking client ended').toBe(true);

  const monitor = wedge.cluster.monitor();
  const prioritizedKey = `${provider.prefix}:${QUEUE_NAME}:prioritized`;
  const run = randomUUID().slice(0, 8);
  const ids = Array.from({ length: 150 }, (_, index) => `w47-b4-${run}-${String(index).padStart(3, '0')}`);
  let exitAt = 0;

  try {
    const oldest = await add('w47.sleep', { label: 'b4-0' }, { priority: 5, jobId: ids[0] });

    await sleep(1_000);
    await queue.addBulk(
      ids.slice(1).map((jobId, index) => ({
        name: 'w47.sleep',
        data: { name: 'w47.sleep', payload: { label: `b4-${index + 1}` } },
        opts: { priority: 5, jobId },
      })),
    );

    const exit = await provider.exitWithin(
      Math.max(0, oldest.timestamp + LATEST_EXIT_AFTER_DUE_MS - Date.now()) + 1_000,
    );

    exitAt = exit?.at ?? 0;

    expect(exit, `the wedged process exits.\nstderr:\n${provider.stderr()}`).not.toBeNull();
    expect(exit?.code).toBe(1);
    expect(exitAt - oldest.timestamp, 'not before two wedged checks').toBeGreaterThanOrEqual(
      EARLIEST_EXIT_AFTER_DUE_MS,
    );

    // Premise, read after the exit so that MONITOR before it holds only the
    // provider's reads: all 150 are still prioritized, in the order added.
    expect(await connection.zcard(prioritizedKey), 'premise: 150 prioritized jobs, none taken').toBe(150);
    expect(
      await connection.zrange(prioritizedKey, 0, PRIORITIZED_MAX - 1),
      'premise: the first 100 are the oldest',
    ).toEqual(ids.slice(0, PRIORITIZED_MAX));

    const lines = exitLine(provider, WEDGED_LINE);

    expect(lines, `one wedged line on stderr:\n${provider.stderr()}`).toHaveLength(1);
    expect(lines[0], 'the line names the oldest job').toContain(ids[0]);
    expect(
      ids.slice(PRIORITIZED_MAX).filter((id) => lines[0].includes(id)),
      'and none of the last 50',
    ).toEqual([]);
    expect(fieldOf(lines[0], 'age') ?? 0, 'the age is past STALL').toBeGreaterThanOrEqual(STALL);

    const direct = monitor.lines().filter((line) => line.at <= exitAt + 100 && !isScripted(line));
    const onSet = direct.filter((line) => line.line.includes(`"${prioritizedKey}"`)).map(argsOf);
    const violations = onSet
      .map((args) => ({ args, reason: unboundedRead(args) }))
      .filter((entry) => entry.reason !== null);

    expect(violations, 'B4: no direct read of more than 100 prioritized members').toEqual([]);
    expect(onSet.filter(isBoundedRange).length, 'premise: the check read the set by a bounded range').toBeGreaterThan(
      0,
    );

    const lastFifty = new Set(ids.slice(PRIORITIZED_MAX).map((id) => `"${provider.prefix}:${QUEUE_NAME}:${id}"`));

    expect(
      direct.filter((line) => [...lastFifty].some((key) => line.line.includes(key))).map((line) => line.line),
      'B4: the hash of none of the last 50 members was read',
    ).toEqual([]);
  } finally {
    monitor.stop();
    await test.info().attach('prioritized-reads.json', {
      body: JSON.stringify(
        {
          exitAt,
          reads: monitor
            .lines()
            .filter((line) => line.line.includes(`"${prioritizedKey}"`) && !isScripted(line))
            .map((line) => ({ at: line.at, line: line.line })),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
});
