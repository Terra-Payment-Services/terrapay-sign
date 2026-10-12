import http from 'node:http';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { expect, test } from '@playwright/test';

import { expectClosedBetween } from './support/assertions';
import { CL_ROUTES, DECLARED_BYTES, expectOnlyTheTimeout, JSON_TYPE } from './support/content-length';
import type { RawConnection } from './support/raw-connection';
import {
  addressFor,
  buildJsonBody,
  buildMultipartBody,
  FILE_UPLOAD_LIMIT_BYTES,
  KIB,
  MIB,
  MULTIPART_API_LIMIT_BYTES,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  TRPC_PATH,
  UPLOAD_PATH,
} from './support/raw-connection';
import { signInCookieHeader } from './support/session';

/**
 * criteria 6, 7 and 9: what must not change, and that stalled Content-Length connections crowd nobody out.
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

test.describe('criterion 6: fast Content-Length bodies just under each limit reach the route', () => {
  const cases = [
    {
      name: 'a body just under 10 MiB of JSON on /api/trpc',
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
      name: 'a multipart body just under the multipart API limit on /api/trpc',
      path: TRPC_PATH,
      type: MULTIPART_CONTENT_TYPE,
      body: () => buildMultipartBody(MULTIPART_API_LIMIT_BYTES - KIB),
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} is answered by the route`, async () => {
      test.setTimeout(90_000);

      const body = entry.body();
      const conn = await connect({
        path: entry.path,
        contentType: entry.type,
        contentLength: body.length,
      });

      await conn.sendBody(body);

      const response = await conn.waitResponse(30_000);

      console.log(
        `[fast] ${JSON.stringify({ case: entry.name, status: response?.statusCode, connection: response?.headers.connection, body: response?.body.slice(0, 120) })}`,
      );

      expect(response, `no answer (${conn.writeError() ?? 'no error'})`).not.toBeNull();
      expect([401, 408, 413, 503], `answer: ${response?.body.slice(0, 200)}`).not.toContain(response?.statusCode);
      expect(response?.body).not.toContain('Request timeout');
      expect(response?.body).not.toContain('Payload too large');
      expect(response?.headers.connection?.toLowerCase(), 'Connection header').not.toBe('close');
    });
  }
});

test.describe('criterion 7: a declared length over the limit is refused as before', () => {
  test('JSON 1 MiB over its limit on /api/trpc gets 413 within 5 s of the last byte', async () => {
    const body = buildJsonBody(11 * MIB);
    const conn = await connect({ path: TRPC_PATH, contentType: JSON_TYPE, contentLength: body.length });

    await conn.sendBody(body);

    const sentAt = conn.elapsedMs();
    const response = await conn.waitResponse(15_000);

    expect(response?.statusCode, `no answer (${conn.writeError() ?? 'no error'})`).toBe(413);
    expect(JSON.parse(response?.body ?? 'null')).toEqual({ error: 'Payload too large' });
    expect((response?.headAtMs ?? 0) - sentAt, 'time from the last byte to the 413').toBeLessThan(5000);
  });

  test('1 MiB over the file upload limit on /api/files/upload-pdf gets 413 within 5 s of the last byte', async () => {
    const body = buildMultipartBody(FILE_UPLOAD_LIMIT_BYTES + MIB);
    const conn = await connect({ path: UPLOAD_PATH, contentType: MULTIPART_CONTENT_TYPE, contentLength: body.length });

    await conn.sendBody(body);

    const sentAt = conn.elapsedMs();
    const response = await conn.waitResponse(15_000);

    expect(response?.statusCode, `no answer (${conn.writeError() ?? 'no error'})`).toBe(413);
    expect(JSON.parse(response?.body ?? 'null')).toEqual({ error: 'Payload too large' });
    expect((response?.headAtMs ?? 0) - sentAt, 'time from the last byte to the 413').toBeLessThan(5000);
  });

  test('a length more than 64 MiB over the limit is refused at once with Connection: close and no body sent', async () => {
    const conn = await connect({
      path: UPLOAD_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      contentLength: FILE_UPLOAD_LIMIT_BYTES + 64 * MIB + 1,
    });

    const response = await conn.waitResponse(5000);

    expect(response?.statusCode, 'status').toBe(413);
    expect(response?.headers.connection?.toLowerCase(), 'Connection header').toBe('close');
    expect(response?.headAtMs, '413 arrival').toBeLessThan(1000);
  });
});

const getFresh = async (path: string) =>
  await new Promise<{ status: number; ms: number }>((resolve, reject) => {
    const startedAt = performance.now();
    const url = new URL(path, NEXT_PUBLIC_WEBAPP_URL());
    const req = http.get(url, { agent: false, timeout: 5000, headers: { Cookie: cookie } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - startedAt }));
    });

    req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
    req.on('error', reject);
  });

test.describe('criterion 9: stalled Content-Length connections do not crowd anyone out', () => {
  test('with 50 declared-nothing-sent and 50 trickling connections open, normal requests are answered in under 1 s and every stalled socket is freed within its bound', async () => {
    test.setTimeout(60_000);

    const silent = await Promise.all(
      Array.from({ length: 50 }, async (_, index) =>
        connect({
          path: CL_ROUTES[index % 4].path,
          contentType: CL_ROUTES[index % 4].type,
          contentLength: DECLARED_BYTES,
        }),
      ),
    );
    const trickling = await Promise.all(
      Array.from({ length: 50 }, async (_, index) =>
        connect({
          path: CL_ROUTES[index % 4].path,
          contentType: CL_ROUTES[index % 4].type,
          contentLength: DECLARED_BYTES,
        }),
      ),
    );

    trickling.forEach((conn) => void conn.sendPaced(null, 100, { tickMs: 1000 }));
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const health = await getFresh('/api/health');
    const trpc = await getFresh('/api/trpc/organisation.internal.getOrganisationSession');

    console.log(
      `[crowding] ${JSON.stringify({ healthStatus: health.status, healthMs: Math.round(health.ms), trpcStatus: trpc.status, trpcMs: Math.round(trpc.ms) })}`,
    );

    expect(health.status).toBe(200);
    expect(health.ms, '/api/health latency').toBeLessThan(1000);
    expect(trpc.status).toBe(200);
    expect(trpc.ms, '/api/trpc latency').toBeLessThan(1000);

    await Promise.all([
      ...silent.map(async (conn, index) =>
        expectClosedBetween(`silent ${index}`, conn, { minMs: 2900, maxMs: 4100 }, 9000),
      ),
      ...trickling.map(async (conn, index) =>
        expectClosedBetween(`trickle ${index}`, conn, { minMs: 9900, maxMs: 11000 }, 16000),
      ),
    ]);

    for (const [index, conn] of silent.entries()) {
      expectOnlyTheTimeout(`silent ${index}`, conn);
    }

    for (const [index, conn] of trickling.entries()) {
      expectOnlyTheTimeout(`trickle ${index}`, conn, { mayBeReset: true });
    }
  });
});
