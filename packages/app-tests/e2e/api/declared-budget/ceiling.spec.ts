import { expect, test } from '@playwright/test';

import type { RawConnection } from '../chunked-stall/support/raw-connection';
import { buildMultipartBody, MIB, MULTIPART_CONTENT_TYPE, TRPC_PATH } from '../chunked-stall/support/raw-connection';
import { connectionPool, expectPayloadTooLarge } from '../family-body-limits/support/families';
import {
  addressSource,
  expectTrpcUnauthorized,
  expectV2Unauthorized,
  MAX_DISCARD_BYTES,
  MULTIPART_CEILING_BYTES,
} from './support/declared';

/**
 * Criterion 1 and F6: the Content-Length multipart ceiling on /api/trpc, /api/v2 and /api/v2-beta is 64 MiB. A
 * body at the ceiling reaches the route, which answers it 401 (no session); one byte over is drained and answered 413;
 * past ceiling + 64 MiB the 413 goes out at once with Connection: close. Every request is unauthenticated, so a body
 * the middleware lets through gets the route's own 401, and no reservation is ever held for long.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(0);

test.afterEach(() => pool.destroyAll());

const MULTIPART_ROUTES = [
  { name: 'api.trpc', path: TRPC_PATH, expectRouteAnswer: expectTrpcUnauthorized },
  { name: 'api.v2', path: '/api/v2/envelope/create', expectRouteAnswer: expectV2Unauthorized },
  { name: 'api.v2-beta', path: '/api/v2-beta/envelope/create', expectRouteAnswer: expectV2Unauthorized },
] as const;

const sendInFull = async (path: string, bytes: number) => {
  const body = buildMultipartBody(bytes);
  const conn = await pool.connect({
    path,
    contentType: MULTIPART_CONTENT_TYPE,
    contentLength: body.length,
    forwardedFor: nextAddress(),
  });

  await conn.sendBody(body);

  return { conn, response: await conn.waitResponse(30_000) };
};

/** The 413 through the drain: the whole body was read, so the connection is kept. */
const expectDrained413 = (label: string, conn: RawConnection, response: ReturnType<RawConnection['response']>) => {
  expectPayloadTooLarge(label, conn, response);
  expect(response?.headers.connection?.toLowerCase(), `${label}: Connection (the body was drained)`).not.toBe('close');
};

for (const route of MULTIPART_ROUTES) {
  test.describe(`criterion 1: ${route.name} multipart`, () => {
    test('a body declaring exactly 64 MiB, sent in full, gets the route its own 401', async () => {
      const { conn, response } = await sendInFull(route.path, MULTIPART_CEILING_BYTES);

      route.expectRouteAnswer(`${route.name} 64 MiB`, conn, response);
    });

    test('a body declaring 64 MiB + 1 byte, sent in full, is drained and answered 413', async () => {
      const { conn, response } = await sendInFull(route.path, MULTIPART_CEILING_BYTES + 1);

      expectDrained413(`${route.name} 64 MiB + 1`, conn, response);
    });

    test('F6: a body declaring 100 MiB, sent in full, is answered 413 (not 503, not the route)', async () => {
      const { conn, response } = await sendInFull(route.path, 100 * MIB);

      expectDrained413(`${route.name} 100 MiB`, conn, response);
    });

    test('a body declaring 128 MiB (ceiling + the discard allowance), sent in full, is drained and answered 413', async () => {
      const { conn, response } = await sendInFull(route.path, MULTIPART_CEILING_BYTES + MAX_DISCARD_BYTES);

      expectDrained413(`${route.name} 128 MiB`, conn, response);
    });

    test('a body declaring 128 MiB + 1 byte is answered 413 with Connection: close at once, before any body byte', async () => {
      const conn = await pool.connect({
        path: route.path,
        contentType: MULTIPART_CONTENT_TYPE,
        contentLength: MULTIPART_CEILING_BYTES + MAX_DISCARD_BYTES + 1,
        forwardedFor: nextAddress(),
      });
      const response = await conn.waitResponse(5000);

      expectPayloadTooLarge(`${route.name} 128 MiB + 1`, conn, response);
      expect(response?.headers.connection?.toLowerCase(), 'Connection').toBe('close');
      expect(response?.headAtMs ?? Number.NaN, '413 arrival').toBeGreaterThanOrEqual(0);
      expect(response?.headAtMs ?? Number.NaN, '413 arrival, not at once').toBeLessThan(300);
      expect(conn.bytesSent(), 'body bytes sent').toBe(0);
    });
  });
}
