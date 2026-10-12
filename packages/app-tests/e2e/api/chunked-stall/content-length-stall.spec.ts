import { expect, test } from '@playwright/test';

import { expectClosedBetween } from './support/assertions';
import { CL_ROUTES, DECLARED_BYTES, expectOnlyTheTimeout } from './support/content-length';
import type { RawConnection } from './support/raw-connection';
import {
  addressFor,
  FILE_UPLOAD_LIMIT_BYTES,
  KIB,
  MIB,
  MULTIPART_API_LIMIT_BYTES,
  openRawConnection,
  UPLOAD_PATH,
} from './support/raw-connection';
import { signInCookieHeader } from './support/session';

/**
 * a body that declares a Content-Length within the limit and then stalls or trickles is answered within a
 * bound. Times are milliseconds from the end of the
 * header write, and every request is signed in: the routes read the session before the body, and a route that
 * refuses an anonymous caller never reads the body the deadline guards. The 180 s ceiling, the slow uploads and the
 * unchanged behaviours are in the other content-length-stall files.
 */

test.describe.configure({ mode: 'default' });

const open: RawConnection[] = [];
let cookie = '';

let nextClient = 0;

// Each connection is its own client for the rate limiters: a hundred stalled requests from one address would be
// answered 429 before the deadline, on the fixed server as on the unfixed one.
const connect = async (options: Parameters<typeof openRawConnection>[0]) => {
  nextClient += 1;

  const conn = await openRawConnection({
    ...options,
    forwardedFor: addressFor(nextClient),
    headers: { Cookie: cookie },
  });
  open.push(conn);

  return conn;
};

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(() => {
  for (const conn of open.splice(0)) {
    conn.destroy();
  }
});

test.describe('criterion 1: Content-Length declared, no body byte sent', () => {
  for (const route of CL_ROUTES) {
    test(`${route.name} answers 408 with Connection: close at 3 s and frees the socket by 4.1 s`, async () => {
      const conn = await connect({ path: route.path, contentType: route.type, contentLength: DECLARED_BYTES });

      const closedAt = await expectClosedBetween(route.name, conn, { minMs: 2900, maxMs: 4100 }, 9000);
      const response = expectOnlyTheTimeout(route.name, conn);

      expect(response, `${route.name}: no status line before the close`).not.toBeNull();
      expect(
        response?.headAtMs,
        `${route.name}: 408 arrived at ${Math.round(response?.headAtMs ?? 0)} ms`,
      ).toBeGreaterThanOrEqual(2900);
      expect(
        response?.headAtMs,
        `${route.name}: 408 arrived at ${Math.round(response?.headAtMs ?? 0)} ms`,
      ).toBeLessThanOrEqual(3500);
      expect(closedAt).toBeGreaterThanOrEqual(response?.headAtMs ?? 0);
    });
  }
});

test.describe('criterion 2: Content-Length declared, trickle of 100 bytes a second from the start', () => {
  for (const route of CL_ROUTES) {
    test(`${route.name} frees the socket between 9.9 s and 11 s`, async () => {
      const conn = await connect({ path: route.path, contentType: route.type, contentLength: DECLARED_BYTES });

      void conn.sendPaced(null, 100, { tickMs: 1000 });

      await expectClosedBetween(route.name, conn, { minMs: 9900, maxMs: 11000 }, 16000);

      const response = expectOnlyTheTimeout(route.name, conn, { mayBeReset: true });

      if (response) {
        expect(
          response.headAtMs,
          `${route.name}: 408 arrived at ${Math.round(response.headAtMs)} ms`,
        ).toBeGreaterThanOrEqual(9900);
        expect(
          response.headAtMs,
          `${route.name}: 408 arrived at ${Math.round(response.headAtMs)} ms`,
        ).toBeLessThanOrEqual(11000);
      }
    });
  }
});

test.describe('criterion 2: a trickler that keeps writing after its 408 still gets the whole 408', () => {
  // 16 KiB a second, half the floor, until the socket closes. The 408 must arrive before any reset, which needs the
  // server to go on reading while the answer goes out (the linger).
  for (const route of CL_ROUTES) {
    test(`${route.name} answers 408 in full while the client is still writing`, async () => {
      const conn = await connect({ path: route.path, contentType: route.type, contentLength: DECLARED_BYTES });

      void conn.sendPaced(null, 16 * KIB, { tickMs: 100 });

      const closedAt = await conn.waitClosed(16_000);

      expect(closedAt, `${route.name}: still open at 16 s`).not.toBeNull();

      const response = expectOnlyTheTimeout(route.name, conn);

      expect(response, `${route.name}: closed (${conn.closeKind()}) with no 408`).not.toBeNull();
      expect(response?.headAtMs).toBeGreaterThanOrEqual(9900);
      expect(response?.headAtMs).toBeLessThanOrEqual(11000);
    });
  }
});

test.describe('criterion 1: the server reads and drops what arrives after its 408', () => {
  // The server sends a FIN with the 408 and reads on for 500 ms. About 10 MiB fits in the buffers between the two
  // ends, so more than 16 MiB flushed after the 408 means the server read and dropped the body during the linger.
  const AFTER_BYTES = 32 * MIB;
  const MIN_READ_BYTES = 16 * MIB;
  // The declared length must exceed what the client writes after the 408 plus the socket buffers, or the bytes past
  // the declared length are a new request on a closing connection and the flushed total is capped near the declared
  // length whatever the server does.
  const DECLARED = 40 * MIB;

  for (const [route, limitBytes] of [
    [CL_ROUTES[0], FILE_UPLOAD_LIMIT_BYTES],
    [CL_ROUTES[2], MULTIPART_API_LIMIT_BYTES],
  ] as const) {
    test(`${route.name} keeps reading after the 408 until the socket closes`, async () => {
      test.skip(
        limitBytes < DECLARED,
        `${route.name}: its limit is ${limitBytes} bytes, below the ${DECLARED} bytes this test must declare`,
      );

      const conn = await connect({
        path: route.path,
        contentType: route.type,
        contentLength: DECLARED,
        allowHalfOpen: true,
      });

      const response = await conn.waitResponse(9000);

      expect(response?.statusCode, `${route.name}: no 408 by 9 s`).toBe(408);

      const flushed = await conn.sendPastFin(Buffer.alloc(AFTER_BYTES, 0x78));

      expect(
        flushed,
        `${route.name}: ${flushed} bytes flushed after the 408 before the socket was gone`,
      ).toBeGreaterThan(MIN_READ_BYTES);
    });
  }
});

test.describe('criterion 3: burst of 9 MiB under a 10 MiB Content-Length, then a stall', () => {
  // 10 MiB declared and 9 MiB sent where the route's limit allows it (the file upload limit is 6 MiB when the
  // server is configured for 5 MB files, and then the burst is a megabyte short of it).
  for (const route of CL_ROUTES) {
    const DECLARED = route.path === UPLOAD_PATH ? Math.min(10 * MIB, FILE_UPLOAD_LIMIT_BYTES) : 10 * MIB;
    const BURST_BYTES = DECLARED - MIB;

    test(`${route.name}: one byte every 2 s after the burst is cut within 11 s of the burst ending`, async () => {
      const conn = await connect({ path: route.path, contentType: route.type, contentLength: DECLARED });

      await conn.sendBody(Buffer.alloc(BURST_BYTES, 0x61));

      const burstEndedAt = conn.elapsedMs();

      expect(conn.closedAtMs(), `${route.name}: closed during the burst`).toBeNull();
      expect(conn.bytesSent()).toBe(BURST_BYTES);

      void conn.sendPaced(null, 0.5, { tickMs: 2000 });

      await expectClosedBetween(
        `${route.name} burst then trickle`,
        conn,
        { minMs: 9900, maxMs: burstEndedAt + 11000 },
        burstEndedAt + 16000,
      );
      expectOnlyTheTimeout(`${route.name} burst then trickle`, conn, { mayBeReset: true });
    });

    test(`${route.name}: the same burst with nothing after it is cut the same way`, async () => {
      const conn = await connect({ path: route.path, contentType: route.type, contentLength: DECLARED });

      await conn.sendBody(Buffer.alloc(BURST_BYTES, 0x61));

      const burstEndedAt = conn.elapsedMs();

      expect(conn.closedAtMs(), `${route.name}: closed during the burst`).toBeNull();

      await expectClosedBetween(
        `${route.name} burst then silence`,
        conn,
        { minMs: 9900, maxMs: burstEndedAt + 11000 },
        burstEndedAt + 16000,
      );
      expectOnlyTheTimeout(`${route.name} burst then silence`, conn);
    });
  }
});

test.describe('criterion 8: the 408 is the only answer, whatever the route would have said', () => {
  test('after the socket closes no second response has arrived, even for a body that is almost complete', async () => {
    // 1 byte short of the declared length: a route that reads to the end is one byte from answering itself.
    const body = Buffer.alloc(2 * MIB - 1, 0x78);
    const conn = await connect({ path: UPLOAD_PATH, contentType: CL_ROUTES[0].type, contentLength: body.length + 1 });

    await conn.sendBody(body);

    await expectClosedBetween('almost complete upload', conn, { minMs: 9900, maxMs: 11000 }, 16000);
    expectOnlyTheTimeout('almost complete upload', conn);
  });
});
