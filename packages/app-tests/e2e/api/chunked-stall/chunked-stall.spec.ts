import http from 'node:http';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { expect, test } from '@playwright/test';

import { expectClosedBetween, expectTimeoutIfAnswered } from './support/assertions';
import type { RawConnection } from './support/raw-connection';
import {
  buildJsonBody,
  buildMultipartBody,
  FILE_UPLOAD_LIMIT_BYTES,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  STALL_ROUTES,
  sleepMs,
  TRPC_PATH,
  UPLOAD_PATH,
} from './support/raw-connection';

/**
 * a chunked body that stalls or trickles is answered within a bound.
 *
 * Times are milliseconds
 * from the end of the header write. The 180 s ceiling is in
 * chunked-stall-ceiling.spec.ts and the byte budget in
 * chunked-stall-budget.spec.ts, each a group of its own. Chunked bodies held
 * in memory share one process-wide budget, so run this file, the budget file
 * and the ceiling file one at a time.
 */

test.describe.configure({ mode: 'default' });

const open: RawConnection[] = [];

const connect = async (options: Parameters<typeof openRawConnection>[0]) => {
  const conn = await openRawConnection(options);
  open.push(conn);

  return conn;
};

test.afterEach(() => {
  for (const conn of open.splice(0)) {
    conn.destroy();
  }
});

const JSON_TYPE = 'application/json';

test.describe('criterion 1: headers only, chunked', () => {
  for (const route of STALL_ROUTES) {
    test(`${route.name} answers 408 with Connection: close at 3 s and frees the socket by 4.1 s`, async () => {
      const conn = await connect({ path: route.path, contentType: JSON_TYPE });

      const closedAt = await expectClosedBetween(route.name, conn, { minMs: 2900, maxMs: 4100 }, 9000);
      const response = conn.response();

      expect(response, `${route.name}: no status line before the close`).not.toBeNull();
      expect(response?.statusCode).toBe(408);
      expect(response?.headers.connection?.toLowerCase()).toBe('close');
      expect(JSON.parse(response?.body ?? 'null')).toEqual({ error: 'Request timeout' });
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

test.describe('criterion 2: trickle from the start, 100 bytes a second', () => {
  for (const route of [STALL_ROUTES[0], STALL_ROUTES[3]]) {
    test(`${route.name} frees the socket between 9.9 s and 11 s`, async () => {
      const conn = await connect({ path: route.path, contentType: JSON_TYPE });

      void conn.sendPaced(null, 100, { tickMs: 1000 });

      await expectClosedBetween(route.name, conn, { minMs: 9900, maxMs: 11000 }, 16000);

      const response = expectTimeoutIfAnswered(route.name, conn);

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

test.describe('criterion 2: a trickler that keeps writing after its 408', () => {
  // 16 KiB a second, half the floor, written until the socket closes. The 408 must arrive whole before any reset,
  // which needs the server to read and drop what is still arriving while the answer goes out.
  for (const route of [STALL_ROUTES[0], STALL_ROUTES[3]]) {
    test(`${route.name} answers 408 in full while the client is still writing`, async () => {
      const conn = await connect({ path: route.path, contentType: JSON_TYPE });

      void conn.sendPaced(null, 16 * KIB, { tickMs: 100 });

      const closedAt = await conn.waitClosed(16_000);
      const response = conn.response();

      expect(closedAt, `${route.name}: still open at 16 s`).not.toBeNull();
      expect(response, `${route.name}: closed (${conn.closeKind()}) with no 408`).not.toBeNull();
      expect(response?.statusCode).toBe(408);
      expect(JSON.parse(response?.body ?? 'null')).toEqual({ error: 'Request timeout' });
      expect(response?.headAtMs).toBeGreaterThanOrEqual(9900);
      expect(response?.headAtMs).toBeLessThanOrEqual(11000);
    });
  }
});

test.describe('criterion 2: the server reads and drops what arrives after its 408', () => {
  // The trickle above fits in the kernel's socket buffers, so it passes whether or not the server keeps reading.
  // 32 MiB written the moment the 408 arrives does not: about 10 MiB fits between the two ends (4 MiB send buffer,
  // 6 MiB receive buffer at most on Linux, 4 MiB each on macOS), so more than 16 MiB flushed before the socket is
  // gone means the server read and dropped the body during its linger. The server sends its FIN with the 408 and
  // reads on, so the client keeps writing past the FIN.
  const AFTER_BYTES = 32 * MIB;
  const MIN_READ_BYTES = 16 * MIB;

  for (const route of [STALL_ROUTES[0], STALL_ROUTES[3]]) {
    test(`${route.name} keeps reading after the 408 until the socket closes`, async () => {
      const conn = await connect({ path: route.path, contentType: JSON_TYPE, allowHalfOpen: true });

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

test.describe('criterion 3: burst of 9 MiB, then a stall', () => {
  const BURST_BYTES = 9 * MIB;

  test('one byte every 2 s after the burst is cut within 11 s of the burst ending', async () => {
    const conn = await connect({ path: TRPC_PATH, contentType: JSON_TYPE });

    await conn.sendBody(Buffer.alloc(BURST_BYTES, 0x61));

    const burstEndedAt = conn.elapsedMs();

    expect(conn.closedAtMs(), 'closed during the burst').toBeNull();
    expect(conn.bytesSent()).toBe(BURST_BYTES);

    void conn.sendPaced(null, 0.5, { tickMs: 2000 });

    await expectClosedBetween(
      'burst then trickle',
      conn,
      { minMs: 9900, maxMs: burstEndedAt + 11000 },
      burstEndedAt + 16000,
    );
    expectTimeoutIfAnswered('burst then trickle', conn);
  });

  test('the same burst with nothing after it is cut the same way', async () => {
    const conn = await connect({ path: TRPC_PATH, contentType: JSON_TYPE });

    await conn.sendBody(Buffer.alloc(BURST_BYTES, 0x61));

    const burstEndedAt = conn.elapsedMs();

    expect(conn.closedAtMs(), 'closed during the burst').toBeNull();

    await expectClosedBetween(
      'burst then silence',
      conn,
      { minMs: 9900, maxMs: burstEndedAt + 11000 },
      burstEndedAt + 16000,
    );
    expectTimeoutIfAnswered('burst then silence', conn);
  });
});

type Outcome = {
  status: number;
  connection: string | null;
  body: string;
  sendMs: number;
  answeredAfterLastByteMs: number;
};

/** Send `body` with the given framing at `bytesPerSecond` (full speed when 0) and read the answer. */
const exchange = async (
  path: string,
  contentType: string,
  body: Buffer,
  framing: { chunked: boolean; bytesPerSecond: number },
): Promise<Outcome> => {
  const conn = await connect({ path, contentType, contentLength: framing.chunked ? undefined : body.length });
  const startedAt = performance.now();

  if (framing.bytesPerSecond > 0) {
    await conn.sendPaced(body, framing.bytesPerSecond);
  } else {
    await conn.sendBody(body);
  }

  const sendMs = performance.now() - startedAt;

  if (framing.chunked) {
    await conn.finish();
  }

  const lastByteAt = conn.elapsedMs();
  const response = await conn.waitResponse(15_000);

  expect(
    response,
    `${path}: no answer within 15 s of the last byte (${conn.writeError() ?? 'no error'})`,
  ).not.toBeNull();

  return {
    status: response?.statusCode ?? 0,
    connection: response?.headers.connection?.toLowerCase() ?? null,
    body: response?.body ?? '',
    sendMs,
    answeredAfterLastByteMs: (response?.headAtMs ?? 0) - lastByteAt,
  };
};

test.describe('criterion 5: a slow but legitimate chunked upload is not refused', () => {
  test('5 MB at 256 KiB/s to /api/files/upload-pdf gets the same answer as Content-Length at full speed', async () => {
    test.setTimeout(90_000);

    const body = buildMultipartBody(5_000_000);
    const reference = await exchange(UPLOAD_PATH, MULTIPART_CONTENT_TYPE, body, { chunked: false, bytesPerSecond: 0 });
    const slow = await exchange(UPLOAD_PATH, MULTIPART_CONTENT_TYPE, body, {
      chunked: true,
      bytesPerSecond: 256 * KIB,
    });

    console.log(
      `[slow upload] ${JSON.stringify({ reference: reference.status, slow: slow.status, sendMs: Math.round(slow.sendMs) })}`,
    );

    expect(slow.sendMs, 'the body really was paced over about 20 s').toBeGreaterThanOrEqual(18_000);
    expect(slow.sendMs).toBeLessThanOrEqual(26_000);
    expect([408, 413, 503]).not.toContain(slow.status);
    expect(slow.status).toBe(reference.status);
    expect(slow.body).toBe(reference.body);
    expect(slow.connection, 'Connection header on the slow answer').not.toBe('close');
  });

  test('2 MiB of JSON at 48 KiB/s to /api/trpc gets the same answer as Content-Length at full speed', async () => {
    test.setTimeout(120_000);

    const body = buildJsonBody(2 * MIB);
    const reference = await exchange(TRPC_PATH, JSON_TYPE, body, { chunked: false, bytesPerSecond: 0 });
    const slow = await exchange(TRPC_PATH, JSON_TYPE, body, { chunked: true, bytesPerSecond: 48 * KIB });

    console.log(
      `[slow json] ${JSON.stringify({ reference: reference.status, slow: slow.status, sendMs: Math.round(slow.sendMs) })}`,
    );

    expect(slow.sendMs, 'the body really was paced over about 43 s, across several windows').toBeGreaterThanOrEqual(
      40_000,
    );
    expect(slow.sendMs).toBeLessThanOrEqual(50_000);
    expect([408, 413, 503]).not.toContain(slow.status);
    expect(slow.status).toBe(reference.status);
    expect(slow.body).toBe(reference.body);
    expect(slow.connection, 'Connection header on the slow answer').not.toBe('close');
  });
});

test.describe('criterion 6: fast chunked bodies just under each limit are passed through', () => {
  const cases = [
    {
      name: 'a 10 MiB JSON body on /api/trpc',
      path: TRPC_PATH,
      type: JSON_TYPE,
      body: () => buildJsonBody(10 * MIB - KIB),
    },
    {
      name: 'a body just under the file upload limit on /api/files/upload-pdf',
      path: UPLOAD_PATH,
      type: MULTIPART_CONTENT_TYPE,
      body: () => buildMultipartBody(FILE_UPLOAD_LIMIT_BYTES - KIB),
    },
    {
      name: 'a chunked multipart body just under the chunked multipart limit on /api/trpc',
      path: TRPC_PATH,
      type: MULTIPART_CONTENT_TYPE,
      body: () => buildMultipartBody(FILE_UPLOAD_LIMIT_BYTES - MIB),
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} gets the answer the Content-Length request gets`, async () => {
      test.setTimeout(90_000);

      const body = entry.body();
      const reference = await exchange(entry.path, entry.type, body, { chunked: false, bytesPerSecond: 0 });
      const chunked = await exchange(entry.path, entry.type, body, { chunked: true, bytesPerSecond: 0 });

      expect([408, 413, 503]).not.toContain(chunked.status);
      expect(chunked.status).toBe(reference.status);
      expect(chunked.body).toBe(reference.body);
    });
  }
});

test.describe('criterion 7: chunked multipart is held to the file upload limit', () => {
  test('a chunked multipart body 1 MiB over the file upload limit on /api/trpc gets 413', async () => {
    test.setTimeout(90_000);

    const conn = await connect({ path: TRPC_PATH, contentType: MULTIPART_CONTENT_TYPE });

    await conn.sendBody(buildMultipartBody(FILE_UPLOAD_LIMIT_BYTES + MIB));
    await conn.finish();

    const response = await conn.waitResponse(20_000);

    expect(response?.statusCode, `no answer (${conn.writeError() ?? 'no error'})`).toBe(413);
  });

  test('the same body sent with Content-Length is not refused for size', async () => {
    test.setTimeout(90_000);

    const body = buildMultipartBody(FILE_UPLOAD_LIMIT_BYTES + MIB);
    const conn = await connect({ path: TRPC_PATH, contentType: MULTIPART_CONTENT_TYPE, contentLength: body.length });

    await conn.sendBody(body);

    const response = await conn.waitResponse(20_000);

    expect(response, `no answer (${conn.writeError() ?? 'no error'})`).not.toBeNull();
    expect(response?.statusCode).not.toBe(413);
  });
});

const getFresh = async (path: string) =>
  await new Promise<{ status: number; ms: number }>((resolve, reject) => {
    const startedAt = performance.now();
    const url = new URL(path, NEXT_PUBLIC_WEBAPP_URL());
    const req = http.get(url, { agent: false, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - startedAt }));
    });

    req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
    req.on('error', reject);
  });

test.describe('criteria 9 and 10: stalled connections do not crowd anyone out', () => {
  test('with 50 header-only and 50 trickling connections open, a normal request is answered in under 1 s and every stalled socket is freed within its bound', async () => {
    test.setTimeout(60_000);

    const headerOnly = await Promise.all(
      Array.from({ length: 50 }, async (_, index) =>
        connect({ path: STALL_ROUTES[index % 4].path, contentType: JSON_TYPE }),
      ),
    );
    const trickling = await Promise.all(
      Array.from({ length: 50 }, async (_, index) =>
        connect({ path: STALL_ROUTES[index % 4].path, contentType: JSON_TYPE }),
      ),
    );

    trickling.forEach((conn) => void conn.sendPaced(null, 100, { tickMs: 1000 }));
    await sleepMs(1000);

    const health = await getFresh('/api/health');
    const trpc = await getFresh('/api/trpc/document.find?input=%7B%7D');

    console.log(
      `[crowding] ${JSON.stringify({ healthStatus: health.status, healthMs: Math.round(health.ms), trpcStatus: trpc.status, trpcMs: Math.round(trpc.ms) })}`,
    );

    expect(health.status).toBe(200);
    expect(health.ms, '/api/health latency').toBeLessThan(1000);
    expect(trpc.status).toBeLessThan(500);
    expect(trpc.ms, '/api/trpc latency').toBeLessThan(1000);

    await Promise.all([
      ...headerOnly.map(async (conn, index) =>
        expectClosedBetween(`header-only ${index}`, conn, { minMs: 2900, maxMs: 4100 }, 9000),
      ),
      ...trickling.map(async (conn, index) =>
        expectClosedBetween(`trickle ${index}`, conn, { minMs: 9900, maxMs: 11000 }, 16000),
      ),
    ]);
  });

  test('more than 16 timed-out pre-reads each get their own 408 at once, and a drain slot is free afterwards', async () => {
    test.setTimeout(60_000);

    const headerOnly = await Promise.all(
      Array.from({ length: 20 }, async () => connect({ path: TRPC_PATH, contentType: JSON_TYPE })),
    );
    const trickling = await Promise.all(
      Array.from({ length: 20 }, async () => connect({ path: UPLOAD_PATH, contentType: JSON_TYPE })),
    );

    trickling.forEach((conn) => void conn.sendPaced(null, 100, { tickMs: 1000 }));

    await Promise.all([
      ...headerOnly.map(async (conn, index) =>
        expectClosedBetween(`header-only ${index}`, conn, { minMs: 2900, maxMs: 4100 }, 9000),
      ),
      ...trickling.map(async (conn, index) =>
        expectClosedBetween(`trickle ${index}`, conn, { minMs: 9900, maxMs: 11000 }, 16000),
      ),
    ]);

    for (const [index, conn] of headerOnly.entries()) {
      const response = conn.response();

      expect(response?.statusCode, `header-only ${index}: status`).toBe(408);
      expect(
        response?.headAtMs,
        `header-only ${index}: the 408 went out at ${Math.round(response?.headAtMs ?? 0)} ms, not after drain bounds`,
      ).toBeLessThanOrEqual(3500);
    }

    for (const [index, conn] of trickling.entries()) {
      const response = expectTimeoutIfAnswered(`trickle ${index}`, conn);

      if (response) {
        expect(
          response.headAtMs,
          `trickle ${index}: the 408 went out at ${Math.round(response.headAtMs)} ms`,
        ).toBeLessThanOrEqual(11000);
      }
    }

    const oversize = await connect({ path: TRPC_PATH, contentType: JSON_TYPE });
    const startedAt = performance.now();

    await oversize.sendBody(buildJsonBody(11 * MIB));
    await oversize.finish();

    const answer = await oversize.waitResponse(5000);

    expect(answer?.statusCode).toBe(413);
    expect(performance.now() - startedAt, 'the 413 for an oversized body after the timeouts').toBeLessThan(3000);
  });
});
