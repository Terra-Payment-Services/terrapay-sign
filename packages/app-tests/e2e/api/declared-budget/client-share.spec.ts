import { test } from '@playwright/test';

import { buildMultipartBody, MIB, MULTIPART_CONTENT_TYPE, TRPC_PATH } from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import type { Hold } from './support/declared';
import {
  addressSource,
  expectBusy,
  expectHoldsAdmitted,
  expectTrpcUnauthorized,
  LARGE_HOLD_BYTES,
  openProbe,
  openTrpcHold,
  releaseAll,
} from './support/declared';

/**
 * criterion 3 (F1, F2): one client holds a 40 MiB declared upload open; its second request, declaring 30 MiB,
 * would take it past its 64 MiB share and is answered 503 at once, though the process is far from its budget. Another
 * client's 30 MiB request at the same moment reaches the route, which answers 401 (no session).
 *
 * The hold is multipart on /api/trpc, signed in, so the route reads it and waits; /api/files/upload-pdf takes one file's
 * worth, 6 MiB when the server is configured for 5 MB files.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(2000);
const holds: Hold[] = [];
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, holds));

const SECOND_BYTES = 30 * MIB;

test('criterion 3: a client holding 40 MiB is refused 30 MiB more, and another client is not', async () => {
  const clientA = nextAddress();
  const clientB = nextAddress();

  holds.push(await openTrpcHold(pool, clientA, cookie, LARGE_HOLD_BYTES));
  await expectHoldsAdmitted('client A at 40 MiB', holds);

  const second = await openProbe(pool, {
    path: TRPC_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    forwardedFor: clientA,
    bytes: SECOND_BYTES,
  });

  await expectBusy('client A at 70 MiB', second);

  const body = buildMultipartBody(SECOND_BYTES);
  const other = await pool.connect({
    path: TRPC_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    contentLength: body.length,
    forwardedFor: clientB,
  });

  await other.sendBody(body);

  expectTrpcUnauthorized('client B at 30 MiB', other, await other.waitResponse(15_000));
});
