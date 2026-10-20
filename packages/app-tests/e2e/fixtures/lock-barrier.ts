/**
 * Deterministic interleavings for the G1 round 2 specs. A test takes a row lock
 * in its own transaction on a separate database connection, fires the requests
 * it wants to interleave, waits until the database shows them queued behind the
 * lock, and only then commits. The waiter probe follows the blocking chain: a
 * request queued behind another waiter for the same row is reported by
 * pg_blocking_pids as blocked by that waiter, not by the lock holder.
 */
import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { pause } from './reject-seal';

export type Tx = Prisma.TransactionClient;

/** The backend pid of the transaction's connection. */
export const backendPid = async (tx: Tx) => {
  const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

  return pid;
};

/** How many backends wait on `pid`, directly or behind another waiter. */
export const waiterCount = async (pid: number) => {
  const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
    WITH RECURSIVE waiter(pid) AS (
      SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN waiter w ON w.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT count(*)::int AS n FROM waiter`;

  return n;
};

/** Polls until at least `count` backends wait on `pid`, or `timeoutMs` passes. Returns the count last seen. */
export const waitForWaiters = async (pid: number, count: number, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  while (Date.now() < deadline) {
    seen = await waiterCount(pid);

    if (seen >= count) {
      return seen;
    }

    await pause(50);
  }

  return seen;
};

/**
 * Runs `body` inside a transaction that first runs `lock` (a SELECT ... FOR
 * UPDATE or similar), handing it the transaction's pid. The lock is released
 * when `body` returns and the transaction commits.
 */
export const withLock = async <T>(lock: (tx: Tx) => Promise<unknown>, body: (pid: number, tx: Tx) => Promise<T>) =>
  await prisma.$transaction(
    async (tx) => {
      await lock(tx);

      return await body(await backendPid(tx), tx);
    },
    { timeout: 60_000, maxWait: 5_000 },
  );
