import { expect } from '@playwright/test';

import { expectClosedBetween } from '../../chunked-stall/support/assertions';
import { expectOnlyTheTimeout } from '../../chunked-stall/support/content-length';
import {
  buildJsonBody,
  MIB,
  MULTIPART_CONTENT_TYPE,
  sleepMs,
  TRPC_PATH,
} from '../../chunked-stall/support/raw-connection';
import type { connectionPool } from '../../family-body-limits/support/families';
import { expectPayloadTooLarge } from '../../family-body-limits/support/families';
import { expectTrpcUnauthorized, JSON_TYPE, openProbe } from './declared';

/**
 * The ways a Content-Length request ends other than the route's success, for criteria 6 and 7 (F3, F4). Each asserts
 * the literal answer its ending gets on the server before and after the fix, so a reservation that changes how a request
 * ends fails here, and a reservation that outlives its request fails the share check that follows.
 */

type Pool = ReturnType<typeof connectionPool>;

export type Ending = {
  name: string;
  run: (pool: Pool, forwardedFor: string, cookie: string, bytes: number) => Promise<void>;
};

/** /api/auth takes 1 MiB, so a 10 or 20 MiB body is over its limit by less than 64 MiB and is drained, then answered 413. */
const AUTH_PATH = '/api/auth/email-password/authorize';

export const ENDING_413: Ending = {
  name: '413 (declared over the limit and drained)',
  run: async (pool, forwardedFor, _cookie, bytes) => {
    expect(bytes, 'the 413 ending needs a body over the 1 MiB /api/auth limit').toBeGreaterThan(MIB);

    const body = buildJsonBody(bytes);
    const conn = await pool.connect({
      path: AUTH_PATH,
      contentType: JSON_TYPE,
      contentLength: body.length,
      forwardedFor,
    });

    await conn.sendBody(body);

    const response = await conn.waitResponse(15_000);

    expectPayloadTooLarge('413 ending', conn, response);
    expect(response?.headers.connection?.toLowerCase(), '413 ending: Connection (the body was drained)').not.toBe(
      'close',
    );
    conn.destroy();
  },
};

/** Signed in, so the route reads the body; no byte arrives, and the first-byte bound answers 408 at 3 s. */
export const ENDING_408: Ending = {
  name: '408 (declared, then stalled)',
  run: async (pool, forwardedFor, cookie, bytes) => {
    const conn = await openProbe(pool, {
      path: TRPC_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor,
      headers: { Cookie: cookie },
      bytes,
    });

    const closedAt = await expectClosedBetween('408 ending', conn, { minMs: 2900, maxMs: 4100 }, 9000);
    const response = expectOnlyTheTimeout('408 ending', conn);

    expect(response, '408 ending: no status line before the close').not.toBeNull();
    expect(response?.headAtMs ?? Number.NaN, '408 ending: 408 arrival').toBeGreaterThanOrEqual(2900);
    expect(response?.headAtMs ?? Number.NaN, '408 ending: 408 arrival').toBeLessThanOrEqual(3500);
    expect(closedAt).toBeGreaterThanOrEqual(response?.headAtMs ?? 0);
  },
};

/** Signed in, so the route is reading when the client goes away part way through the body. */
export const ENDING_ABORT: Ending = {
  name: 'client abort mid-body',
  run: async (pool, forwardedFor, cookie, bytes) => {
    const conn = await openProbe(pool, {
      path: TRPC_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor,
      headers: { Cookie: cookie },
      bytes,
    });

    await conn.sendBody(Buffer.alloc(Math.min(4 * MIB, Math.floor(bytes / 2)), 0x78));
    await sleepMs(100);

    const response = conn.response();

    expect(
      response,
      `abort ending: answered ${response?.statusCode} (${response?.body.slice(0, 120)}) before the abort`,
    ).toBeNull();
    expect(conn.closedAtMs(), 'abort ending: closed before the abort').toBeNull();

    conn.destroy();
    // The server sees the reset, the route's read fails and the request ends: a moment for that to happen.
    await sleepMs(500);
  },
};

/** No session: the tRPC route answers 401 without reading the body, which never comes. */
export const ENDING_ROUTE_4XX: Ending = {
  name: 'route answers 4xx without reading the body',
  run: async (pool, forwardedFor, _cookie, bytes) => {
    const conn = await openProbe(pool, { path: TRPC_PATH, contentType: MULTIPART_CONTENT_TYPE, forwardedFor, bytes });
    const response = await conn.waitResponse(5000);

    expectTrpcUnauthorized('4xx ending', conn, response);
    expect(response?.headAtMs ?? Number.NaN, '4xx ending: 401 arrival').toBeGreaterThanOrEqual(0);
    expect(response?.headAtMs ?? Number.NaN, '4xx ending: 401 arrival').toBeLessThan(2000);
    conn.destroy();
  },
};

export const ENDINGS = [ENDING_413, ENDING_408, ENDING_ABORT, ENDING_ROUTE_4XX];
