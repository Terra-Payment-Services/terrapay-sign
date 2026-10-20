/**
 * The BullMQ job dashboard at /api/jobs/board refuses cross-site requests and changes nothing.
 * Written from the specification alone.
 *
 * | Test                                                                   | Criterion |
 * | ---------------------------------------------------------------------- | --------- |
 * | a cross-site text/plain add from an admin is refused 403, no job added  | C1        |
 * | a same-origin add and pause from an admin are refused, nothing changes  | C2        |
 * | an admin can still read the dashboard page and its queue listing        | C3        |
 * | a signed-in non-admin is refused 401 on both                            | C4        |
 * | a cross-site POST to a job handler path is answered 200 OK              | C5        |
 *
 * The shared E2E server runs the local job provider, which mounts no dashboard, so the spec starts a built server of
 * its own on BullMQ, in production mode so the admin check applies. It uses the suite's Redis under a key prefix of
 * its own, so its queue starts empty and nothing else sees it. Each added job carries a one-hour delay, so the
 * server's own worker leaves it in the delayed list, where the listing can find it.
 *
 * Nothing here changes process.env: the project hands its worker environment to cleanup-script.
 */
import { randomUUID } from 'node:crypto';

import { seedUser } from '@documenso/prisma/seed/users';
import { expect, request, test } from '@playwright/test';

import { spawnWedgeServer, type WedgeServer, waitUntilServing } from './support/wedge-server';

test.describe.configure({ mode: 'default' });

const QUEUE = 'documenso-jobs';
const BOARD = '/api/jobs/board';
const EVIL_ORIGIN = 'https://evil.example';

let server: WedgeServer | undefined;
let adminCookie = '';
let userCookie = '';

/** Signs `email` in against the spec's own server and returns a Cookie header value. */
const signIn = async (origin: string, email: string) => {
  const context = await request.newContext({ baseURL: origin });

  try {
    const { csrfToken } = await (await context.get('/api/auth/csrf')).json();
    const response = await context.post('/api/auth/email-password/authorize', {
      data: { email, password: 'password', csrfToken },
    });

    if (!response.ok()) {
      throw new Error(`sign-in of ${email} failed with ${response.status()}`);
    }

    const { cookies } = await context.storageState();

    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } finally {
    await context.dispose();
  }
};

const origin = () => {
  if (!server) {
    throw new Error('the spec server did not start');
  }

  return server.origin;
};

type Answer = { status: number; body: string; contentType: string };

/**
 * One request from a request context of its own, so no cookie the server sets on one answer rides along on the
 * next, and each request carries exactly the session (or none) its headers name.
 */
const send = async (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  headers: Record<string, string> = {},
  data?: string,
): Promise<Answer> => {
  const context = await request.newContext();

  try {
    const response = await context.fetch(`${origin()}${path}`, { method, headers, data });

    return {
      status: response.status(),
      body: await response.text(),
      contentType: response.headers()['content-type'] ?? '',
    };
  } finally {
    await context.dispose();
  }
};

type BoardQueue = { name: string; isPaused: boolean; jobs: { name: string }[] };

/** The app's queue as the dashboard lists it, with every job in every status (up to 1000 each). */
const listQueue = async () => {
  const response = await send('GET', `${BOARD}/api/queues?activeQueue=${QUEUE}&status=latest&jobsPerPage=1000`, {
    Cookie: adminCookie,
  });

  expect(response.status, `GET ${BOARD}/api/queues: status (body ${response.body.slice(0, 200)})`).toBe(200);

  const { queues } = JSON.parse(response.body) as { queues: BoardQueue[] };
  const queue = queues.find((entry) => entry.name === QUEUE);

  expect(queue, `the listing includes ${QUEUE}`).toBeDefined();

  return queue as BoardQueue;
};

/** A JSON job with a name nobody else uses, held back an hour so the worker does not take it. */
const jobBody = () => {
  const name = `j65-${randomUUID()}`;

  return { name, body: JSON.stringify({ name, data: {}, options: { delay: 3_600_000 } }) };
};

test.beforeAll(async () => {
  test.setTimeout(180_000);

  const redisUrl = process.env.NEXT_PRIVATE_REDIS_URL;

  if (!redisUrl) {
    throw new Error('NEXT_PRIVATE_REDIS_URL is not set; the dashboard needs the BullMQ provider and a Redis.');
  }

  server = await spawnWedgeServer({ redisUrl, redisPrefix: `j65-${randomUUID()}`, cluster: false });
  await waitUntilServing(server);

  const { user: admin } = await seedUser({ isAdmin: true });
  const { user } = await seedUser();

  adminCookie = await signIn(server.origin, admin.email);
  userCookie = await signIn(server.origin, user.email);
});

test.afterAll(async () => {
  await server?.stop();
});

test.afterEach(async () => {
  const testInfo = test.info();

  // A failure leaves only this server's output to say whether it refused, crashed or never mounted the board.
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

/**
 * C1: a hostile page on a sibling host visited by a signed-in admin can send the Lax session cookie with a text/plain POST,
 * which needs no preflight. The same-origin check must answer it 403, and the job in its body must not exist.
 */
test('C1: a cross-site text/plain add from an admin is refused 403 and adds no job', async () => {
  const { name, body } = jobBody();
  const response = await send(
    'POST',
    `${BOARD}/api/queues/${QUEUE}/add`,
    { Cookie: adminCookie, Origin: EVIL_ORIGIN, 'Content-Type': 'text/plain' },
    body,
  );

  expect(response.status, `cross-site add: status (body ${response.body.slice(0, 200)})`).toBe(403);

  const queue = await listQueue();

  expect(
    queue.jobs.map((job) => job.name),
    'the cross-site job is not in the queue',
  ).not.toContain(name);
});

/**
 * C2: the dashboard is read-only, so even the app's own admin, from the app's own origin, cannot add a job or pause
 * the queue through it. The refusal is a 4xx that is neither an authentication nor a same-origin refusal (bull-board
 * answers 405 for a read-only queue), and the queue is unchanged.
 */
test('C2: a same-origin add and pause from an admin are refused and change nothing', async () => {
  const { name, body } = jobBody();
  const headers = { Cookie: adminCookie, Origin: origin(), 'Content-Type': 'application/json' };

  const add = await send('POST', `${BOARD}/api/queues/${QUEUE}/add`, headers, body);
  const addStatus = add.status;

  expect(addStatus, `same-origin add: status (body ${add.body.slice(0, 200)})`).toBeGreaterThanOrEqual(400);
  expect(addStatus, 'same-origin add: a 4xx').toBeLessThan(500);
  expect([401, 403], 'same-origin add: not an authentication or same-origin refusal').not.toContain(addStatus);

  let paused = false;

  try {
    const pause = await send('PUT', `${BOARD}/api/queues/${QUEUE}/pause`, headers, '{}');
    const pauseStatus = pause.status;

    paused = pauseStatus === 200;

    expect(pauseStatus, `same-origin pause: status (body ${pause.body.slice(0, 200)})`).toBeGreaterThanOrEqual(400);
    expect(pauseStatus, 'same-origin pause: a 4xx').toBeLessThan(500);
    expect([401, 403], 'same-origin pause: not an authentication or same-origin refusal').not.toContain(pauseStatus);

    const queue = await listQueue();

    expect(
      queue.jobs.map((job) => job.name),
      'the same-origin job is not in the queue',
    ).not.toContain(name);
    expect(queue.isPaused, 'the queue is not paused').toBe(false);
  } finally {
    // On the unfixed board the pause takes effect; resume, so the controls below see a working queue.
    if (paused) {
      await send('PUT', `${BOARD}/api/queues/${QUEUE}/resume`, headers, '{}');
    }
  }
});

/** C3 (control): the fix must not take the dashboard away from the admin who is allowed to read it. */
test('C3: an admin can still read the dashboard page and its queue listing', async () => {
  const page = await send('GET', BOARD, { Cookie: adminCookie });

  expect(page.status, `GET ${BOARD}: status (body ${page.body.slice(0, 200)})`).toBe(200);
  expect(page.contentType, `GET ${BOARD}: content type`).toContain('text/html');

  await listQueue();
});

/** C4 (control): a signed-in user without the ADMIN role is still refused, on the page and on the API. */
test('C4: a signed-in non-admin is refused 401 on the dashboard page and its queue listing', async () => {
  for (const path of [BOARD, `${BOARD}/api/queues`]) {
    const response = await send('GET', path, { Cookie: userCookie });

    expect(response.status, `GET ${path} as a non-admin: status (body ${response.body.slice(0, 200)})`).toBe(401);
  }
});

/**
 * C5 (control): every other path under /api/jobs/ is the background job handler, called by the job provider rather
 * than a browser, and keeps its exemption from the same-origin check. On BullMQ the handler answers a cross-site POST
 * there 200 with the body OK, so the request passed the check and reached the handler rather than failing elsewhere.
 */
test('C5: a cross-site POST to a job handler path is answered 200 OK', async () => {
  const response = await send('POST', '/api/jobs/x/y', { Origin: EVIL_ORIGIN, 'Content-Type': 'text/plain' }, '{}');

  expect(response.status, `cross-site POST /api/jobs/x/y: status (body ${response.body.slice(0, 200)})`).toBe(200);
  expect(response.body, 'cross-site POST /api/jobs/x/y: body').toBe('OK');
});
