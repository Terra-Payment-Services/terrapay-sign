import { test } from '@playwright/test';

import { MIB } from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import { addressSource, expectShareFree, releaseAll } from './support/declared';
import { ENDINGS } from './support/endings';

/**
 * Criterion 6 (F3, F4): whatever way a 20 MiB Content-Length request ends, the client is left holding nothing. The
 * same client is then admitted for exactly its whole share (40 MiB and 24 MiB held at once) and refused 1 KiB beside it.
 * Before the fix nothing is reserved, so the 1 KiB request is admitted and each test fails at that step.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(5000);
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, []));

for (const ending of ENDINGS) {
  test(`criterion 6: after a ${ending.name}, the same client can reserve its whole share and no more`, async () => {
    const client = nextAddress();

    await ending.run(pool, client, cookie, 20 * MIB);
    await expectShareFree(ending.name, pool, client, cookie);
  });
}
