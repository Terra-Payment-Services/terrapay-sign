import { expect, test } from '@playwright/test';

import type { RawConnection } from '../chunked-stall/support/raw-connection';
import { buildJsonBody, MIB, MULTIPART_CONTENT_TYPE, TRPC_PATH } from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import type { Hold } from './support/declared';
import {
  addressSource,
  expectBusy,
  expectHoldsAdmitted,
  JSON_TYPE,
  LARGE_HOLD_BYTES,
  openProbe,
  openTrpcHold,
  releaseAll,
} from './support/declared';

/**
 * Criterion 4 (F1): chunked pre-reads and declared bodies draw on the same counters.
 *
 * A chunked body on /api/trpc is held to 10 MiB as JSON (and to one file's worth as multipart, 6 MiB when the server is
 * configured for 5 MB files), so the 60 MiB of chunked pre-read is eight JSON bodies of 7.5 MiB from one client. Each is
 * sent in one burst and then nothing: the trailing window keeps a burst that size alive for about ten seconds, and
 * no trickle adds to the client's count while the test runs.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(3000);
const holds: Hold[] = [];
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, holds));

const CHUNKED_TOTAL_BYTES = 60 * MIB;
const CHUNKED_HOLDERS = 8;

test('criterion 4: a client holding 60 MiB of chunked pre-read is refused a 10 MiB declared request', async () => {
  const client = nextAddress();
  const payload = buildJsonBody(CHUNKED_TOTAL_BYTES / CHUNKED_HOLDERS);
  const chunked: RawConnection[] = [];

  for (let index = 0; index < CHUNKED_HOLDERS; index += 1) {
    const conn = await pool.connect({ path: TRPC_PATH, contentType: JSON_TYPE, forwardedFor: client });

    await conn.sendBody(payload);

    const answered = await conn.waitResponse(150);

    expect(
      answered,
      `chunked holder ${index}: answered ${answered?.statusCode} (${answered?.body.slice(0, 120)}) while 60 MiB fits the share`,
    ).toBeNull();
    chunked.push(conn);
  }

  for (const [index, conn] of chunked.entries()) {
    expect(conn.closedAtMs(), `chunked holder ${index}: closed`).toBeNull();
  }

  const declared = await openProbe(pool, {
    path: TRPC_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    forwardedFor: client,
    bytes: 10 * MIB,
  });

  await expectBusy('10 MiB declared beside 60 MiB chunked', declared);
});

test('criterion 4, the other way: a client holding 60 MiB declared is refused when a chunked body crosses its share', async () => {
  const client = nextAddress();

  holds.push(await openTrpcHold(pool, client, cookie, LARGE_HOLD_BYTES));
  holds.push(await openTrpcHold(pool, client, cookie, CHUNKED_TOTAL_BYTES - LARGE_HOLD_BYTES));
  await expectHoldsAdmitted('client at 60 MiB declared', holds);

  // 5 MiB chunked: the chunk that takes the client past 64 MiB is refused, a little after 4 MiB.
  const conn = await pool.connect({ path: TRPC_PATH, contentType: JSON_TYPE, forwardedFor: client });

  await conn.sendBody(buildJsonBody(5 * MIB));

  const response = await conn.waitResponse(5000);

  expect(
    response,
    `chunked body beside 60 MiB declared: no answer (${conn.writeError() ?? 'still open'})`,
  ).not.toBeNull();
  expect(response?.statusCode, `status (body ${response?.body.slice(0, 200)})`).toBe(503);
  expect(response?.headers['retry-after'], 'Retry-After').toBe('1');
  expect(response?.headers.connection?.toLowerCase(), 'Connection').toBe('close');
  expect(JSON.parse(response?.body || 'null'), 'body').toEqual({ error: 'Service unavailable' });
  expect(conn.responseCount(), 'responses on the connection').toBe(1);
});
