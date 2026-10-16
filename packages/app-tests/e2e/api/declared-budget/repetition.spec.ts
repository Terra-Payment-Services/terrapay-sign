import { test } from '@playwright/test';

import { MIB } from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import { addressSource, expectShareFree, releaseAll } from './support/declared';
import { ENDINGS } from './support/endings';

/**
 * criterion 7 (F3, F4): fifty sequential 10 MiB Content-Length requests from one client, ending in turn as a 413,
 * a 408, an abort and a route's 401, leave the client able to reserve exactly its whole share. A leak of 10 MiB on any
 * ending kind would refuse later requests of the run (each asserts its literal answer) and the share check after it.
 * Thirteen of the fifty are 3 s timeouts, so the run takes about a minute. The client sends 38 requests through the
 * /api/trpc rate limiter (100 a minute); the 413s are answered before it.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(6000);
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, []));

const REQUESTS = 50;

test('criterion 7: 50 sequential 10 MiB declared requests, each ending another way, leave the share whole', async () => {
  test.setTimeout(150_000);

  const client = nextAddress();

  for (let index = 0; index < REQUESTS; index += 1) {
    const ending = ENDINGS[index % ENDINGS.length];

    await test.step(`request ${index + 1}: ${ending.name}`, async () => {
      await ending.run(pool, client, cookie, 10 * MIB);
    });
  }

  await expectShareFree('after 50 requests', pool, client, cookie);
});
