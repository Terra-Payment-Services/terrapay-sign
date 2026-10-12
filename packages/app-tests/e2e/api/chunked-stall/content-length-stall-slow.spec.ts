import { expect, test } from '@playwright/test';

import { JSON_TYPE } from './support/content-length';
import type { RawConnection } from './support/raw-connection';
import {
  buildJsonBody,
  buildMultipartBody,
  buildPdfMultipartBody,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  openRawConnection,
  TRPC_PATH,
  UPLOAD_PATH,
} from './support/raw-connection';
import { signInCookieHeader } from './support/session';

/**
 * criterion 5 and F4, F7: a slow but legitimate Content-Length upload reaches the route intact and is answered
 * as the identical request at full speed is. Signed in, so that the route does its session lookup before it reads
 * the body, which is the closest an end-to-end test gets to F7 (a route's own slowness counted against the client).
 * Run on its own: it takes about three minutes.
 */

test.describe.configure({ mode: 'default' });

const open: RawConnection[] = [];
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(() => {
  for (const conn of open.splice(0)) {
    conn.destroy();
  }
});

type Outcome = { status: number; connection: string | null; body: string; sendMs: number };

/**
 * Two uploads of the same bytes get a different id, and the stored PDF is rewritten with a fresh document id and
 * date, so `data` and `initialData` differ in a few bytes and `createdAt` is the time of the upload. The answers must
 * agree in everything else, and in `data` by its start and its size.
 */
const expectSameAnswer = (slow: string, reference: string) => {
  const parse = (body: string) => {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const [a, b] = [parse(slow), parse(reference)];

  if (typeof a?.data !== 'string' || typeof b?.data !== 'string') {
    expect(slow).toBe(reference);
    return;
  }

  const shape = (answer: Record<string, unknown>) => ({
    ...answer,
    id: '#',
    createdAt: '#',
    data: String(answer.data).slice(0, 16),
    initialData: String(answer.initialData).slice(0, 16),
  });

  expect(shape(a)).toEqual(shape(b));
  expect(Math.abs(a.data.length - b.data.length) / b.data.length, 'size of the stored file').toBeLessThan(0.01);
};

/** Send `body` with a Content-Length at `bytesPerSecond` (full speed when 0) and read the answer. */
const exchange = async (path: string, contentType: string, body: Buffer, bytesPerSecond: number): Promise<Outcome> => {
  const conn = await openRawConnection({
    path,
    contentType,
    contentLength: body.length,
    headers: { Cookie: cookie },
  });
  open.push(conn);

  const startedAt = performance.now();

  if (bytesPerSecond > 0) {
    await conn.sendPaced(body, bytesPerSecond);
  } else {
    await conn.sendBody(body);
  }

  const sendMs = performance.now() - startedAt;
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
  };
};

const cases = [
  {
    name: '5 MB at 256 KiB/s to /api/files/upload-pdf',
    path: UPLOAD_PATH,
    type: MULTIPART_CONTENT_TYPE,
    body: () => buildPdfMultipartBody(5_000_000),
    rate: 256 * KIB,
    sendSeconds: { min: 18, max: 26 },
  },
  {
    name: '2 MiB of JSON at 48 KiB/s to /api/trpc',
    path: TRPC_PATH,
    type: JSON_TYPE,
    body: () => buildJsonBody(2 * MIB),
    rate: 48 * KIB,
    sendSeconds: { min: 40, max: 50 },
  },
  {
    name: '2 MiB at 64 KiB/s to /api/files/upload-pdf (a second rate for the session lookup ahead of the read)',
    path: UPLOAD_PATH,
    type: MULTIPART_CONTENT_TYPE,
    body: () => buildPdfMultipartBody(2 * MIB),
    rate: 64 * KIB,
    sendSeconds: { min: 29, max: 37 },
  },
  {
    name: '1 MiB multipart at 40 KiB/s to /api/trpc',
    path: TRPC_PATH,
    type: MULTIPART_CONTENT_TYPE,
    body: () => buildMultipartBody(MIB),
    rate: 40 * KIB,
    sendSeconds: { min: 23, max: 30 },
  },
];

test.describe('criterion 5: a slow but legitimate Content-Length upload is not refused', () => {
  for (const entry of cases) {
    test(`${entry.name} gets the same answer as at full speed`, async () => {
      test.setTimeout(150_000);

      const body = entry.body();
      const reference = await exchange(entry.path, entry.type, body, 0);
      const slow = await exchange(entry.path, entry.type, body, entry.rate);

      console.log(
        `[slow] ${JSON.stringify({ case: entry.name, reference: reference.status, slow: slow.status, sendMs: Math.round(slow.sendMs) })}`,
      );

      expect(slow.sendMs, 'the body really was paced').toBeGreaterThanOrEqual(entry.sendSeconds.min * 1000);
      expect(slow.sendMs).toBeLessThanOrEqual(entry.sendSeconds.max * 1000);
      expect([401, 408, 413, 503], `slow answer: ${slow.body.slice(0, 200)}`).not.toContain(slow.status);
      expect([401, 500], `reference answer: ${reference.body.slice(0, 200)}`).not.toContain(reference.status);
      expect(slow.status).toBe(reference.status);
      expectSameAnswer(slow.body, reference.body);
      expect(slow.connection, 'Connection header on the slow answer').not.toBe('close');
    });
  }
});
