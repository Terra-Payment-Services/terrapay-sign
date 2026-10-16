import { expect, test } from '@playwright/test';

import { openDribbleConnection, openIdleConnection, sleepMs } from './support/idle-connection';

/**
 * The server keeps an idle connection open longer than the load balancer's 60 s idle timeout.
 * Written from the specification alone.
 *
 * | Test                                                                    | Criterion | Failure modes |
 * | ----------------------------------------------------------------------- | --------- | ------------- |
 * | one socket idle for 61 s carries a second GET /api/health, still open   | 1, 3 (a)  | F1, F5        |
 * | an idle socket is closed by the server 64 to 70 s after its response    | 2         | F1, F3        |
 * | a request whose headers never finish is closed between 60 and 100 s     | 3 (b)     | F3            |
 *
 * F2 (headersTimeout left at 60 s) is not caught. Node enforces headersTimeout only on a 30 s check timer, so a 60 s
 * and a 66 s deadline both close the dribbled request inside the same window; telling them apart needs control of the
 * server's check interval, which an end-to-end test does not have.
 *
 * Criterion 4 is in shutdown.spec.ts, which starts a server of its own. Criterion 5 is the existing chunked-stall
 * suites, run unchanged.
 *
 * Both specifications' time bounds are checked on both sides. The tests use raw sockets because a pooled HTTP client
 * reconnects silently (F5).
 */
test.describe('keep-alive', () => {
  test('criterion 1 and 3a: one socket idle for 61 s carries a second GET /api/health, and the server never closes it', async () => {
    test.setTimeout(100_000);

    const conn = await openIdleConnection();

    try {
      const first = await conn.get('/api/health', 10_000);

      expect(first, 'the first response arrived').not.toBeNull();
      expect(first?.statusCode, 'first response status').toBe(200);
      expect(first?.headers.connection?.toLowerCase(), 'the server must not announce Connection: close').not.toBe(
        'close',
      );

      const firstEndedAt = conn.lastResponseEndedAt() as number;

      await sleepMs(61_000);

      const idleMs = performance.now() - firstEndedAt;

      expect(idleMs, 'the connection stayed idle for at least 61 s').toBeGreaterThanOrEqual(61_000);
      expect(idleMs, 'the idle wait did not overrun by more than 2 s').toBeLessThanOrEqual(63_000);
      expect(
        conn.events(),
        `the server closed the socket during the idle wait, after ${Math.round(((conn.closedAt() ?? firstEndedAt) - firstEndedAt) / 1000)} s (events: ${conn.events().join(', ')})`,
      ).toEqual(['connect']);
      expect(conn.closedAt(), 'no end or close during the 61 s').toBeNull();

      const second = await conn.get('/api/health', 10_000);

      expect(second, 'the second response arrived on the same socket').not.toBeNull();
      expect(second?.statusCode, 'second response status').toBe(200);

      // F5: the second response came over the socket that carried the first.
      expect(conn.connectCount(), 'the one socket connected once, so there was no reconnect').toBe(1);
      expect(conn.statusLineCount(), 'two complete responses were read from this one socket').toBe(2);
      expect(conn.strayBytes(), 'no bytes beyond the two responses').toBe('');
      expect(conn.events(), 'no end, close or error on the socket across both responses').toEqual(['connect']);
      expect(conn.socket.destroyed, 'the socket is still open after the second response').toBe(false);
    } finally {
      conn.destroy();
    }
  });

  test('criterion 2: a connection left idle after a response is closed by the server 64 to 70 s later', async () => {
    test.setTimeout(100_000);

    const conn = await openIdleConnection();

    try {
      const response = await conn.get('/api/health', 10_000);

      expect(response?.statusCode, 'response status').toBe(200);

      const endedAt = conn.lastResponseEndedAt() as number;
      const closedAt = await conn.waitClosed(80_000 - (performance.now() - endedAt));

      expect(closedAt, 'the server never closed the idle connection within 80 s (infinite keep-alive)').not.toBeNull();

      const idleMs = (closedAt as number) - endedAt;

      expect(
        idleMs,
        `closed ${Math.round(idleMs)} ms after the response, before the 64 000 ms lower bound`,
      ).toBeGreaterThanOrEqual(64_000);
      expect(
        idleMs,
        `closed ${Math.round(idleMs)} ms after the response, after the 70 000 ms upper bound`,
      ).toBeLessThanOrEqual(70_000);
      expect(conn.strayBytes(), 'the server wrote nothing more before closing').toBe('');
      expect(conn.connectCount(), 'one socket throughout').toBe(1);
    } finally {
      conn.destroy();
    }
  });

  // The server's header check runs on a 30 s timer (Node's connectionsCheckingInterval), so a headersTimeout of 66 s is
  // enforced at the first check after 66 s, between 66 and 96 s after the first byte. The specification's 60 to 70 s
  // window cannot hold under that check, and the spec allows widening it to the measured behaviour: the lower bound
  // stays 60 s and the upper bound becomes 100 s (66 s, one 30 s check interval, and 4 s of margin).
  test('criterion 3b: a request whose headers are sent a byte at a time and never finished is closed between 60 and 100 s', async () => {
    test.setTimeout(130_000);

    const conn = await openDribbleConnection();

    try {
      const closedAtMs = await conn.waitClosed(110_000);

      expect(closedAtMs, 'the server never closed the connection whose headers never finished').not.toBeNull();
      expect(
        closedAtMs as number,
        `closed at ${Math.round(closedAtMs as number)} ms, before the 60 000 ms lower bound`,
      ).toBeGreaterThanOrEqual(60_000);
      expect(
        closedAtMs as number,
        `closed at ${Math.round(closedAtMs as number)} ms, after the 100 000 ms upper bound`,
      ).toBeLessThanOrEqual(100_000);

      const status = conn.statusCode();

      if (status !== null) {
        expect(status, 'a status written before the close is the 408').toBe(408);
      }
    } finally {
      conn.destroy();
    }
  });
});
