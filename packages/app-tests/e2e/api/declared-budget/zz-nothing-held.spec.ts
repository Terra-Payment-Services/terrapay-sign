import fs from 'node:fs';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { expect, test } from '@playwright/test';

import { KIB, MULTIPART_CONTENT_TYPE, TRPC_PATH } from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import type { Hold } from './support/declared';
import {
  addressSource,
  BUDGET_BYTES,
  expectBusy,
  expectHoldsAdmitted,
  LARGE_HOLD_BYTES,
  openProbe,
  openTrpcHold,
  releaseAll,
  SHARE_BYTES,
  SHARE_REMAINDER_BYTES,
} from './support/declared';

/**
 * Last in the directory (the project runs one file at a time, in order). After every other declared-budget file the process holds
 * nothing: four clients are admitted for their whole shares, exactly the 256 MiB budget, and a fifth client's 1 KiB
 * request is refused (F3: a leak anywhere refuses one of the four; F4: a budget released twice admits the fifth). Then
 * the server is still up and its log carries no unhandled rejection or uncaught exception. E2E_SERVER_LOG names the log;
 * that test is skipped without it.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(7000);
const holds: Hold[] = [];
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, holds));

test('the whole 256 MiB budget is free: four full shares are admitted and 1 KiB more is refused', async () => {
  expect(4 * SHARE_BYTES, 'four shares make the budget').toBe(BUDGET_BYTES);

  for (let client = 0; client < 4; client += 1) {
    const forwardedFor = nextAddress();

    holds.push(await openTrpcHold(pool, forwardedFor, cookie, LARGE_HOLD_BYTES));
    holds.push(await openTrpcHold(pool, forwardedFor, cookie, SHARE_REMAINDER_BYTES));
  }

  await expectHoldsAdmitted('four full shares', holds);

  const fifth = await openProbe(pool, {
    path: TRPC_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    forwardedFor: nextAddress(),
    bytes: KIB,
  });

  await expectBusy('a fifth client at 256 MiB + 1 KiB', fifth);
});

test('/api/health answers 200', async ({ request }) => {
  const response = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/health`);

  expect(response.status()).toBe(200);
});

test('the server log carries no unhandled rejection or uncaught exception', () => {
  const logPath = process.env.E2E_SERVER_LOG;

  test.skip(!logPath, 'E2E_SERVER_LOG is not set, so the server log cannot be read');

  const log = fs.readFileSync(logPath as string, 'utf8');
  const offending = log
    .split('\n')
    .filter((line) => /unhandled ?rejection|uncaught ?exception|ERR_UNHANDLED/i.test(line));

  expect(offending, 'log lines naming an unhandled rejection or uncaught exception').toEqual([]);
  expect(log.length, 'the log is empty, so it is not the server log').toBeGreaterThan(0);
});
