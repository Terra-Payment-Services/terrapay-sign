import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { userProtectedPdf } from '@documenso/lib/server-only/pdf/__fixtures__/protected-pdfs';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../../../fixtures/authentication';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const examplePdf = fs.readFileSync(path.join(__dirname, '../../../../../../assets/example.pdf'));

test.describe.configure({
  mode: 'parallel',
});

const createApiTokenForUser = async (userId: number, teamId: number) => {
  const { token } = await createApiToken({
    userId,
    teamId,
    tokenName: 'file-upload-test',
    expiresIn: null,
  });

  return token;
};

/** The JSON body ceiling on tRPC and API v2, from its specification. */
const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** A tRPC-shaped JSON body of exactly `totalBytes` bytes. */
const buildJsonBody = (totalBytes: number) => {
  const prefix = '{"json":{"name":"';
  const suffix = '"}}';
  const padding = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);

  return Buffer.from(`${prefix}${'a'.repeat(padding)}${suffix}`);
};

/**
 * `reusedSocket` records whether the request went out on a connection kept
 * alive from an earlier one; `connection` is the response's Connection header,
 * for diagnosis.
 */
type RawPostResult =
  | { status: number; bytesWritten: number; reusedSocket: boolean; connection: string | null }
  | { error: string; bytesWritten: number; reusedSocket: boolean };

/**
 * POST a body with node:http, optionally as Transfer-Encoding: chunked, so the
 * test controls framing. The whole body is written even after a response
 * arrives, as a real client does, so whatever the server leaves unread stays
 * on the connection for the next request. Resolves once the response has been
 * read and the body written, with the status, or with the error if the
 * connection fails before any response. Errors after a response (EPIPE on
 * writes the server no longer reads) are expected and ignored.
 */
const rawPost = async (
  url: string,
  body: Buffer,
  options: { chunked: boolean; agent: http.Agent },
): Promise<RawPostResult> => {
  const target = new URL(url);
  const SLICE_BYTES = 64 * 1024;

  return await new Promise<RawPostResult>((resolve) => {
    let bytesWritten = 0;
    let isAnswered = false;
    let isSettled = false;
    let status: number | null = null;
    let connection: string | null = null;
    let isResponseRead = false;
    let isBodyDone = false;

    const settle = (result: RawPostResult) => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      resolve(result);
    };

    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      agent: options.agent,
      headers: {
        'Content-Type': 'application/json',
        ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(body.length) }),
      },
    });

    const settleIfComplete = () => {
      if (status !== null && isResponseRead && isBodyDone) {
        settle({ status, bytesWritten, reusedSocket: req.reusedSocket, connection });
      }
    };

    req.setTimeout(30_000, () => {
      settle({ error: 'TIMEOUT: no response and no close within 30 s', bytesWritten, reusedSocket: req.reusedSocket });
      req.destroy();
    });

    req.on('response', (res) => {
      isAnswered = true;
      status = res.statusCode ?? 0;
      connection = res.headers.connection ?? null;
      res.resume();

      const onRead = () => {
        isResponseRead = true;
        settleIfComplete();
      };

      res.on('end', onRead);
      res.on('error', onRead);
    });

    req.on('finish', () => {
      isBodyDone = true;
      settleIfComplete();
    });

    // A server that closes after answering cuts the body short; the answer still counts.
    req.on('close', () => {
      if (!isAnswered) {
        settle({ error: 'CLOSED: connection closed with no response', bytesWritten, reusedSocket: req.reusedSocket });
        return;
      }

      isBodyDone = true;
      isResponseRead = isResponseRead || isAnswered;
      settleIfComplete();
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (isAnswered) {
        return;
      }

      settle({ error: `${err.code ?? 'ERROR'}: ${err.message}`, bytesWritten, reusedSocket: req.reusedSocket });
    });

    const writeNext = () => {
      while (!req.destroyed && bytesWritten < body.length) {
        const slice = body.subarray(bytesWritten, bytesWritten + SLICE_BYTES);
        bytesWritten += slice.length;

        if (!req.write(slice)) {
          req.once('drain', writeNext);
          return;
        }
      }

      if (!req.destroyed) {
        req.end();
      }
    };

    writeNext();
  });
};

const TRPC_URL = `${WEBAPP_BASE_URL}/api/trpc/profile.updateProfile`;

/**
 * Send the same body `attempts` times in sequence over one kept-alive
 * connection, so each request after the first lands on whatever the previous
 * one left behind.
 */
const postRepeatedly = async (url: string, body: Buffer, options: { chunked: boolean }, attempts: number) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const outcomes: RawPostResult[] = [];

  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      outcomes.push(await rawPost(url, body, { ...options, agent }));
    }
  } finally {
    agent.destroy();
  }

  return outcomes;
};

/**
 * Every request after the first must have gone out on the kept-alive socket,
 * or the sequence never exercised a reused connection and proves nothing.
 */
const expectEveryLaterRequestReusedTheSocket = (outcomes: RawPostResult[]) => {
  expect(outcomes.length).toBeGreaterThan(1);
  expect(outcomes.slice(1).map((outcome) => outcome.reusedSocket)).toEqual(Array(outcomes.length - 1).fill(true));
};

/**
 * A server that answers before it has read a Content-Length body may stop
 * reading, but criterion 2 then requires it to say Connection: close. So each
 * request after the first must either have reused the socket, or follow a
 * response that announced the close. A connection dropped after a
 * `keep-alive` answer fails this.
 */
const expectSocketReusedUnlessCloseAnnounced = (outcomes: RawPostResult[]) => {
  expect(outcomes.length).toBeGreaterThan(1);

  const unannouncedDrops = outcomes.slice(1).flatMap((outcome, index) => {
    const previous = outcomes[index];
    const isCloseAnnounced = 'status' in previous && previous.connection?.toLowerCase() === 'close';

    return outcome.reusedSocket || isCloseAnnounced ? [] : [{ attempt: index + 2, previous }];
  });

  expect(unannouncedDrops).toEqual([]);
};

/** Record the outcomes and the reset count in the report and the run log. */
const attachOutcomes = async (label: string, outcomes: RawPostResult[]) => {
  const resets = outcomes.filter((outcome) => 'error' in outcome).length;
  const statuses = outcomes.map((outcome) => ('status' in outcome ? outcome.status : null));

  const reused = outcomes.filter((outcome) => outcome.reusedSocket).length;

  console.log(`[${label}] ${JSON.stringify({ attempts: outcomes.length, resets, reused, statuses })}`);
  await test.info().attach(`${label}-outcomes.json`, {
    body: JSON.stringify({ attempts: outcomes.length, resets, reused, outcomes }, null, 2),
    contentType: 'application/json',
  });
};

const buildPdfFormData = () => {
  const formData = new FormData();
  formData.append('file', new File([examplePdf], 'test.pdf', { type: 'application/pdf' }));

  return formData;
};

test.describe('File upload endpoint authorization', () => {
  test('rejects an unauthenticated upload-pdf request', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      multipart: buildPdfFormData(),
    });

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(401);
  });

  // Embedded authoring, which sent a presign token here, is removed. A bearer
  // token of any kind must now be refused exactly as no credential is.
  test('refuses an upload-pdf request that carries only a bearer token', async ({ request }) => {
    const { user, team } = await seedUser();
    const apiToken = await createApiTokenForUser(user.id, team.id);

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      multipart: buildPdfFormData(),
    });

    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBe(401);
  });

  test('refuses a PDF that needs a password to open with a 400 the client can name', async ({ page }) => {
    const { user } = await seedUser();

    await apiSignin({ page, email: user.email });

    const { request } = page.context();

    const formData = new FormData();
    formData.append('file', new File([await userProtectedPdf()], 'locked.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, { multipart: formData });

    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('PASSWORD_PROTECTED_DOCUMENT');
  });

  test('refuses an upload larger than the limit before it is parsed or authenticated', async ({ request }) => {
    // One byte past the file limit plus the 1 MiB multipart allowance.
    const oversized = Buffer.alloc((APP_DOCUMENT_UPLOAD_SIZE_LIMIT + 1) * 1024 * 1024 + 1);

    const formData = new FormData();
    formData.append('file', new File([oversized], 'huge.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      multipart: formData,
    });

    expect(res.status()).toBe(413);
  });

  // criteria 1 and 4. A socket hang up throws here and fails the test.
  test('refuses a tRPC JSON body over the 10 MiB limit', async ({ request }) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/profile.updateProfile`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ json: { name: 'a'.repeat(11 * 1024 * 1024) } }),
    });

    expect(res.status()).toBe(413);
  });
});

test.describe('JSON body limit answers 413 reliably', () => {
  // Criteria 1 and 4: every one of 20 sequential oversized requests gets a 413.
  // Resets are counted rather than thrown so the run records how many there were.
  test('answers 413 to 20 oversized tRPC JSON bodies in a row', async ({ request }) => {
    test.slow();

    const ATTEMPTS = 20;
    const data = JSON.stringify({ json: { name: 'a'.repeat(11 * 1024 * 1024) } });
    const outcomes: Array<{ attempt: number; status?: number; error?: string }> = [];

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await request.post(`${WEBAPP_BASE_URL}/api/trpc/profile.updateProfile`, {
          headers: { 'Content-Type': 'application/json' },
          data,
        });

        outcomes.push({ attempt, status: res.status() });
      } catch (err) {
        outcomes.push({ attempt, error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      }
    }

    const resets = outcomes.filter((outcome) => outcome.error !== undefined);
    const answered413 = outcomes.filter((outcome) => outcome.status === 413);
    const summary = { attempts: ATTEMPTS, answered413: answered413.length, resets: resets.length, outcomes };

    console.log(`[repeated] ${JSON.stringify({ ...summary, outcomes: undefined })}`);
    await test.info().attach('repeated-oversized-outcomes.json', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });

    expect(resets).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(ATTEMPTS).fill(413));
  });

  // Criterion 1: a chunked body declares no length, so the limit must be enforced as it arrives.
  test('answers 413 to 20 oversized tRPC JSON bodies sent with chunked transfer encoding', async () => {
    test.slow();

    const outcomes = await postRepeatedly(TRPC_URL, buildJsonBody(11 * 1024 * 1024), { chunked: true }, 20);

    await attachOutcomes('chunked-oversized', outcomes);

    expect(outcomes.filter((outcome) => 'error' in outcome)).toEqual([]);
    expect(outcomes.map((outcome) => ('status' in outcome ? outcome.status : null))).toEqual(Array(20).fill(413));
    expectEveryLaterRequestReusedTheSocket(outcomes);
  });

  // Criterion 3: a body of exactly the limit is not refused for size. It may be
  // refused for another reason (no session), so only 413 and a reset fail it.
  test('does not refuse a tRPC JSON body of exactly 10 MiB for size', async () => {
    test.slow();

    const body = buildJsonBody(JSON_BODY_LIMIT_BYTES);
    expect(body.length).toBe(JSON_BODY_LIMIT_BYTES);

    const withLength = await postRepeatedly(TRPC_URL, body, { chunked: false }, 5);
    const chunked = await postRepeatedly(TRPC_URL, body, { chunked: true }, 5);

    await attachOutcomes('at-limit-content-length', withLength);
    await attachOutcomes('at-limit-chunked', chunked);

    for (const outcome of [...withLength, ...chunked]) {
      expect(outcome).not.toHaveProperty('error');
      expect(outcome).not.toMatchObject({ status: 413 });
    }

    expectSocketReusedUnlessCloseAnnounced(withLength);
    expectEveryLaterRequestReusedTheSocket(chunked);
  });

  // Criterion 5: API v2 and v2-beta share the tRPC JSON body limit middleware.
  for (const prefix of ['/api/v2', '/api/v2-beta']) {
    test(`answers 413 to 20 oversized JSON bodies on ${prefix}, with Content-Length and chunked`, async () => {
      test.slow();

      const url = `${WEBAPP_BASE_URL}${prefix}/document/update`;
      const body = buildJsonBody(11 * 1024 * 1024);

      const withLength = await postRepeatedly(url, body, { chunked: false }, 20);
      const chunked = await postRepeatedly(url, body, { chunked: true }, 20);

      await attachOutcomes(`${prefix.slice(5)}-content-length`, withLength);
      await attachOutcomes(`${prefix.slice(5)}-chunked`, chunked);

      expect([...withLength, ...chunked].filter((outcome) => 'error' in outcome)).toEqual([]);
      expect([...withLength, ...chunked].map((outcome) => ('status' in outcome ? outcome.status : null))).toEqual(
        Array(40).fill(413),
      );
      expectSocketReusedUnlessCloseAnnounced(withLength);
      expectEveryLaterRequestReusedTheSocket(chunked);
    });
  }
});
