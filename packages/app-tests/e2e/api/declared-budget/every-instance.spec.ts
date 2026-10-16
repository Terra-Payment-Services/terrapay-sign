import { test } from '@playwright/test';

import {
  buildJsonBody,
  buildMultipartBody,
  buildPdfMultipartBody,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  TRPC_PATH,
  UPLOAD_PATH,
} from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import type { Hold } from './support/declared';
import {
  addressSource,
  expectBusy,
  expectHoldsAdmitted,
  JSON_TYPE,
  LARGE_HOLD_BYTES,
  openHold,
  openProbe,
  openTrpcHold,
  releaseAll,
  SHARE_BYTES,
} from './support/declared';

/**
 * Required behaviours 2 and 3 on every bodyLimit instance (F1, F2): a Content-Length body on each of /api/files,
 * /api/trpc (JSON and multipart), /api/v2 and /api/v2-beta (JSON and multipart), /api/v1, /api/auth and /api/jobs
 * reserves its declared length against the client's share, and a request on each is refused when its declared length
 * does not fit.
 *
 * Per instance, one client holds 40 MiB on /api/trpc and a small body on the instance, both read by their routes and
 * held open. A request declaring one byte more than what is left of the share is then refused, which it would not be if
 * the instance had not reserved its body. The share is then filled exactly, and a 1 KiB request on the instance itself
 * is refused. Holds on /api/files, /api/trpc and API v2 JSON are signed in, because those routes read the session
 * before the body; API v2 multipart, /api/v1, /api/auth and /api/jobs read the body without one.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(4000);
const holds: Hold[] = [];
let cookie = '';

test.beforeAll(async () => {
  cookie = await signInCookieHeader();
});

test.afterEach(async () => await releaseAll(pool, holds));

type Instance = {
  name: string;
  path: string;
  type: string;
  isSignedIn: boolean;
  body: () => Buffer;
};

const INSTANCES: Instance[] = [
  {
    name: 'api.files',
    path: UPLOAD_PATH,
    type: MULTIPART_CONTENT_TYPE,
    isSignedIn: true,
    body: () => buildPdfMultipartBody(MIB),
  },
  { name: 'api.trpc json', path: TRPC_PATH, type: JSON_TYPE, isSignedIn: true, body: () => buildJsonBody(MIB) },
  {
    name: 'api.trpc multipart',
    path: TRPC_PATH,
    type: MULTIPART_CONTENT_TYPE,
    isSignedIn: true,
    body: () => buildMultipartBody(MIB),
  },
  {
    name: 'api.v2 json',
    path: '/api/v2/envelope/create',
    type: JSON_TYPE,
    isSignedIn: true,
    body: () => buildJsonBody(MIB),
  },
  {
    name: 'api.v2 multipart',
    path: '/api/v2/envelope/create',
    type: MULTIPART_CONTENT_TYPE,
    isSignedIn: false,
    body: () => buildMultipartBody(MIB),
  },
  {
    name: 'api.v2-beta multipart',
    path: '/api/v2-beta/envelope/create',
    type: MULTIPART_CONTENT_TYPE,
    isSignedIn: false,
    body: () => buildMultipartBody(MIB),
  },
  { name: 'api.v1', path: '/api/v1/documents', type: JSON_TYPE, isSignedIn: false, body: () => buildJsonBody(MIB) },
  {
    name: 'api.auth',
    path: '/api/auth/email-password/authorize',
    type: JSON_TYPE,
    isSignedIn: false,
    body: () => buildJsonBody(512 * KIB),
  },
  {
    name: 'api.jobs',
    path: '/api/jobs/declared-budget-46/any-id',
    type: JSON_TYPE,
    isSignedIn: false,
    body: () => buildJsonBody(MIB),
  },
];

for (const instance of INSTANCES) {
  test(`${instance.name}: a held Content-Length body counts against the share, and a request that does not fit is refused`, async () => {
    const client = nextAddress();
    const body = instance.body();

    holds.push(await openTrpcHold(pool, client, cookie, LARGE_HOLD_BYTES));
    holds.push(
      await openHold(pool, {
        path: instance.path,
        contentType: instance.type,
        forwardedFor: client,
        headers: instance.isSignedIn ? { Cookie: cookie } : undefined,
        body,
      }),
    );
    await expectHoldsAdmitted(`${instance.name}: 40 MiB and ${body.length} bytes`, holds);

    const left = SHARE_BYTES - LARGE_HOLD_BYTES - body.length;
    const overByOne = await openProbe(pool, {
      path: TRPC_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor: client,
      bytes: left + 1,
    });

    await expectBusy(`${instance.name}: one byte more than the share has left`, overByOne);

    holds.push(await openTrpcHold(pool, client, cookie, left));
    await expectHoldsAdmitted(`${instance.name}: the share filled exactly`, holds);

    const onInstance = await openProbe(pool, {
      path: instance.path,
      contentType: instance.type,
      forwardedFor: client,
      bytes: KIB,
    });

    await expectBusy(`${instance.name}: 1 KiB on a full share`, onInstance);
  });
}
