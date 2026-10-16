import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { expect, test } from '@playwright/test';
import { spawnWedgeServer, type WedgeServer, waitUntilServing } from '../../worker-wedge/support/wedge-server';
import {
  buildPdfMultipartBody,
  FILE_LIMIT_MB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  sleepMs,
  UPLOAD_PATH,
} from '../chunked-stall/support/raw-connection';
import { signInCookieHeader } from '../chunked-stall/support/session';
import { connectionPool } from '../family-body-limits/support/families';
import type { Hold } from './support/declared';
import {
  addressSource,
  BUDGET_BYTES,
  expectBusy,
  expectHoldsAdmitted,
  openHold,
  openProbe,
  releaseAll,
} from './support/declared';

/**
 * criteria 2 and 5 (F1, F2, F5): five clients each hold 51 MiB of declared uploads open on /api/files/upload-pdf,
 * 255 MiB in all, each client inside its 64 MiB share. A sixth client's 2 MiB declared request would take the process
 * past 256 MiB and is answered 503 at once, from its headers, before the route (which would answer 401, since it
 * carries no session). A request with no body is unaffected. When the uploads finish, each gets the route's 200, and
 * the sixth client's request, retried, reaches the route.
 *
 * The uploads are signed in, so the route reads them and waits. Each request carries at most one file's worth (5 MiB
 * when the server is configured for 5 MB files, 50 MiB at the default), so a client's 51 MiB is one or more uploads of
 * that size plus one of 1 MiB. Every body is a real PDF, so the route stores it and answers 200 once it is complete.
 *
 * The spec runs against a server of its own. A full process budget refuses every client's declared body, as it
 * should, so on the shared server it failed UI specs running alongside it (CI job 179626), and 255 MiB of stored
 * uploads competed with them for the runner.
 */

test.describe.configure({ mode: 'default' });

const pool = connectionPool(0);
const nextAddress = addressSource(1000);
const holds: Hold[] = [];
let cookie = '';
let server: WedgeServer | undefined;
const sharedOrigin = process.env.NEXT_PUBLIC_WEBAPP_URL;

test.beforeAll(async () => {
  test.setTimeout(180_000);

  // The shared server's job and Redis settings, not the wedge specs' BullMQ.
  server = await spawnWedgeServer({
    redisUrl: process.env.NEXT_PRIVATE_REDIS_URL ?? '',
    redisPrefix: process.env.NEXT_PRIVATE_REDIS_PREFIX ?? '',
    cluster: false,
    env: {
      NEXT_PRIVATE_JOBS_PROVIDER: process.env.NEXT_PRIVATE_JOBS_PROVIDER,
      NEXT_PRIVATE_REDIS_URL: process.env.NEXT_PRIVATE_REDIS_URL,
      NEXT_PRIVATE_REDIS_PREFIX: process.env.NEXT_PRIVATE_REDIS_PREFIX,
    },
  });
  await waitUntilServing(server);

  // Every helper here reads the origin from this variable when it connects.
  process.env.NEXT_PUBLIC_WEBAPP_URL = server.origin;
  cookie = await signInCookieHeader();
});

test.afterAll(async () => {
  if (sharedOrigin === undefined) {
    delete process.env.NEXT_PUBLIC_WEBAPP_URL;
  } else {
    process.env.NEXT_PUBLIC_WEBAPP_URL = sharedOrigin;
  }

  await server?.stop();
});

test.afterEach(async () => {
  const testInfo = test.info();

  await releaseAll(pool, holds);

  // A failure on CI leaves only this server's output to say whether it was slow or gone (CI job 179680).
  if (server && testInfo.status !== testInfo.expectedStatus) {
    const exited = server.hasExited() ? await server.exit : null;

    await testInfo.attach('own-server-exit', {
      body: exited ? `code ${exited.code}, signal ${exited.signal}` : 'still running',
      contentType: 'text/plain',
    });
    await testInfo.attach('own-server-stdout', { body: server.stdout(), contentType: 'text/plain' });
    await testInfo.attach('own-server-stderr', { body: server.stderr(), contentType: 'text/plain' });
  }
});

const PER_CLIENT_BYTES = 51 * MIB;
const PIECE_BYTES = FILE_LIMIT_MB * MIB;
const SIXTH_BYTES = 2 * MIB;

/** The sizes of one client's uploads: whole files, then the remainder. */
const pieces = () => {
  const sizes: number[] = [];

  for (let left = PER_CLIENT_BYTES; left > 0; left -= Math.min(left, PIECE_BYTES)) {
    sizes.push(Math.min(left, PIECE_BYTES));
  }

  return sizes;
};

test('criteria 2 and 5: past 256 MiB of declared uploads a 2 MiB request is refused 503 at once, and admitted once they finish', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const bodies = new Map<number, Buffer>();
  const bodyOf = (size: number) => {
    if (!bodies.has(size)) {
      bodies.set(size, buildPdfMultipartBody(size));
    }

    return bodies.get(size) as Buffer;
  };

  for (let client = 0; client < 5; client += 1) {
    const forwardedFor = nextAddress();

    for (const size of pieces()) {
      holds.push(
        await openHold(pool, {
          path: UPLOAD_PATH,
          contentType: MULTIPART_CONTENT_TYPE,
          forwardedFor,
          headers: { Cookie: cookie },
          body: bodyOf(size),
        }),
      );
    }
  }

  expect(
    pieces().reduce((total, size) => total + size, 0),
    'declared per client',
  ).toBe(PER_CLIENT_BYTES);
  expect(5 * PER_CLIENT_BYTES + SIXTH_BYTES, 'the sixth request crosses the budget').toBeGreaterThan(BUDGET_BYTES);
  expect(5 * PER_CLIENT_BYTES, 'the five fit inside it').toBeLessThanOrEqual(BUDGET_BYTES);

  await expectHoldsAdmitted('five clients at 51 MiB each', holds);

  // Criterion 2: the sixth client, no session, headers only.
  const sixth = nextAddress();
  const refused = await openProbe(pool, {
    path: UPLOAD_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    forwardedFor: sixth,
    bytes: SIXTH_BYTES,
  });

  await expectBusy('sixth client at 257 MiB', refused);

  const health = await request.get(`${NEXT_PUBLIC_WEBAPP_URL()}/api/health`);

  expect(health.status(), 'GET /api/health while the budget is full').toBe(200);

  // Criterion 5: the uploads finish and are stored.
  await Promise.all(holds.map(async (hold) => await hold.complete()));

  const completedAt = Date.now();
  const answers = await Promise.all(
    holds.map(async (hold) => {
      const response = await hold.conn.waitResponse(60_000);

      return { response, afterMs: Date.now() - completedAt };
    }),
  );

  await test.info().attach('upload-answers', {
    body: answers
      .map(({ response, afterMs }, index) => `${index} ${response?.statusCode ?? 'none'} ${afterMs}ms`)
      .join('\n'),
    contentType: 'text/plain',
  });

  for (const [index, { response }] of answers.entries()) {
    expect(response?.statusCode, `upload ${index}: status (body ${response?.body.slice(0, 200)})`).toBe(200);
    expect(typeof JSON.parse(response?.body || 'null')?.id, `upload ${index}: stored document data id`).toBe('string');
  }

  // The reservations are released as the route's answers go out; a moment for the last of them.
  await sleepMs(200);

  // The same request again, now sent in full: the route answers it, 401 for the missing session.
  const body = bodyOf(SIXTH_BYTES);
  const retried = await pool.connect({
    path: UPLOAD_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    contentLength: body.length,
    forwardedFor: sixth,
  });

  await retried.sendBody(body);

  const answer = await retried.waitResponse(15_000);

  expect(answer?.statusCode, `retried sixth request: status (body ${answer?.body.slice(0, 200)})`).toBe(401);
  expect(JSON.parse(answer?.body || 'null'), 'retried sixth request: the route body').toEqual({
    error: 'Unauthorized',
  });
});
