import { expect, test } from '@playwright/test';

import { openIdleConnection } from './support/idle-connection';
import { spawnOwnServer, waitUntilServing } from './support/own-server';

/**
 * criterion 4 (F4): SIGTERM to a server that has five idle keep-alive connections open. The server is the built
 * one (node build/server/main.js), started by the test on a free port, as worker-wedge/support/wedge-server.ts does,
 * so the signal reaches the real process and its real exit code is read.
 *
 * Time bounds are checked on both sides: every socket is still open when the signal is sent, so none can have been
 * closed before it, and the process exits within the 25 s bound the server's graceful shutdown already has.
 *
 * Against the unfixed server this passes, because the shutdown is unchanged by the fix; it guards F4, a fix that
 * lets idle connections hold the shutdown open.
 */
test('criterion 4: SIGTERM with five idle keep-alive connections open exits 0 within 25 s and the server closes each socket', async () => {
  test.setTimeout(180_000);

  const server = await spawnOwnServer();
  const connections: Awaited<ReturnType<typeof openIdleConnection>>[] = [];

  try {
    await waitUntilServing(server);

    for (let index = 0; index < 5; index += 1) {
      const conn = await openIdleConnection(server.origin);
      const response = await conn.get('/api/health', 10_000);

      expect(response?.statusCode, `connection ${index + 1}: the one request's status`).toBe(200);
      connections.push(conn);
    }

    for (const [index, conn] of connections.entries()) {
      expect(conn.closedAt(), `connection ${index + 1} is open when SIGTERM is sent`).toBeNull();
    }

    const signalledAt = performance.now();

    server.signal('SIGTERM');

    const outcome = await Promise.race([
      server.exit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000)),
    ]);

    expect(
      outcome,
      `the server did not exit within 25 s of SIGTERM (idle keep-alive connections held it open)\nstderr:\n${server.stderr()}`,
    ).not.toBeNull();
    expect(outcome?.code, 'exit code').toBe(0);
    expect(outcome?.signal, 'exit signal').toBeNull();

    const exitedAfterMs = (outcome?.at as number) - signalledAt;

    expect(exitedAfterMs, 'the exit came after the signal').toBeGreaterThan(0);
    expect(exitedAfterMs, 'the exit came within the 25 s shutdown bound').toBeLessThanOrEqual(25_000);

    for (const [index, conn] of connections.entries()) {
      const closedAt = await conn.waitClosed(2_000);

      expect(closedAt, `connection ${index + 1}: the server closed the idle socket`).not.toBeNull();
      expect(closedAt as number, `connection ${index + 1}: closed no earlier than the signal`).toBeGreaterThanOrEqual(
        signalledAt,
      );
      expect(closedAt as number, `connection ${index + 1}: closed by the time the process exited`).toBeLessThanOrEqual(
        (outcome?.at as number) + 2_000,
      );
      expect(conn.connectCount(), `connection ${index + 1}: one socket throughout`).toBe(1);
    }
  } finally {
    for (const conn of connections) {
      conn.destroy();
    }

    await server.stop();
  }
});
