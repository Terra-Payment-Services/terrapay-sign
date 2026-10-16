import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { sign } from '@documenso/lib/server-only/crypto/sign';
import { prisma } from '@documenso/prisma';
import { BackgroundJobStatus } from '@documenso/prisma/client';
import { expect, request } from '@playwright/test';

import type { OpenOptions, RawConnection } from '../../chunked-stall/support/raw-connection';
import { KIB, MIB, openRawConnection } from '../../chunked-stall/support/raw-connection';

/**
 * Shared by the family body-limit specs: body limits on /api/v1, /api/auth and /api/jobs. The
 * ceilings are the specification's figures, written here rather than imported from
 * the server, so that a ceiling set wrong in the server (F4) cannot move the test with it.
 */

export const JSON_TYPE = 'application/json';

export type FamilyName = 'v1' | 'auth' | 'jobs';

export const CEILING_BYTES: Record<FamilyName, number> = {
  v1: 10 * MIB,
  auth: MIB,
  jobs: 16 * MIB,
};

/** The discard allowance: a declared length past ceiling + 64 MiB is refused without reading. */
export const MAX_DISCARD_BYTES = 64 * MIB;

/** The declared length of the stall and trickle cases: 1 MiB, or 512 KiB on /api/auth, inside each ceiling. */
export const STALL_DECLARED_BYTES: Record<FamilyName, number> = {
  v1: MIB,
  auth: 512 * KIB,
  jobs: MIB,
};

/**
 * A token-shaped Authorization header that no token matches. The Zapier handlers answer 401 at once when the header
 * is missing and read the body only when one is present, so the bogus header is what makes the route read the body
 * before it checks the token, which is the order the bug is about. The request is still unauthenticated.
 */
const BOGUS_BEARER = { Authorization: 'Bearer api_family45bogustoken' };

export type FamilyRoute = {
  name: string;
  family: FamilyName;
  path: string;
  headers?: Record<string, string>;
  /** What the route answers today to a JSON body of the buildJsonBody shape: measured on the unfixed server. */
  ownAnswer: { status: number; body: (text: string) => void };
};

const expectJsonMessage = (message: string) => (text: string) => {
  expect(JSON.parse(text).message, 'route body').toBe(message);
};

/** The five routes criteria 1 to 6 and 8 run on. */
export const FAMILY_ROUTES: FamilyRoute[] = [
  {
    name: 'POST /api/v1/documents',
    family: 'v1',
    path: '/api/v1/documents',
    ownAnswer: { status: 400, body: expectJsonMessage('Request validation failed') },
  },
  {
    name: 'POST /api/v1/zapier/subscribe',
    family: 'v1',
    path: '/api/v1/zapier/subscribe',
    headers: BOGUS_BEARER,
    ownAnswer: { status: 400, body: expectJsonMessage('Webhook URL is not a valid URL') },
  },
  {
    name: 'POST /api/v1/<nonexistent>',
    family: 'v1',
    path: '/api/v1/family-body-limits-45-nonexistent',
    ownAnswer: { status: 404, body: expectJsonMessage('Not Found') },
  },
  {
    name: 'POST /api/auth/email-password/authorize',
    family: 'auth',
    path: '/api/auth/email-password/authorize',
    ownAnswer: {
      status: 400,
      body: (text) => {
        const parsed = JSON.parse(text);

        expect(Array.isArray(parsed.error), 'route body: the validator error list').toBe(true);
        expect(
          parsed.error.map((issue: { path: string[] }) => issue.path[0]),
          'route body: fields the validator refused',
        ).toContain('email');
      },
    },
  },
  {
    name: 'POST /api/jobs/<any>/<any>',
    family: 'jobs',
    path: '/api/jobs/family-body-limits-45/any-id',
    ownAnswer: { status: 400, body: (text) => expect(text, 'route body').toBe('Bad request') },
  },
];

/** The routes criterion 4 runs on: /api/v1 and /api/auth. */
export const MULTIPART_ROUTES = FAMILY_ROUTES.filter((route) => route.family !== 'jobs');

/**
 * A raw-socket opener that gives every connection its own client address, so that neither the rate limiters nor the
 * per-client chunked share is what answers, and that destroys whatever is left open after each test.
 */
export const connectionPool = (offset: number) => {
  const open: RawConnection[] = [];
  let next = 0;

  const connect = async (options: OpenOptions) => {
    next += 1;

    const index = offset + next;
    const conn = await openRawConnection({
      ...options,
      forwardedFor: options.forwardedFor ?? `10.45.${Math.floor(index / 250)}.${(index % 250) + 1}`,
    });
    open.push(conn);

    return conn;
  };

  const destroyAll = () => {
    for (const conn of open.splice(0)) {
      conn.destroy();
    }
  };

  return { connect, destroyAll };
};

/** The answer for a body over the limit. */
export const expectPayloadTooLarge = (
  label: string,
  conn: RawConnection,
  response: ReturnType<RawConnection['response']>,
) => {
  expect(
    response,
    `${label}: no answer (${conn.writeError() ?? conn.closeKind() ?? 'socket still open'})`,
  ).not.toBeNull();
  expect(response?.statusCode, `${label}: status (body ${response?.body.slice(0, 200)})`).toBe(413);
  expect(JSON.parse(response?.body || 'null'), `${label}: body`).toEqual({ error: 'Payload too large' });
  expect(conn.responseCount(), `${label}: responses received on the connection`).toBe(1);
};

/**
 * A JSON body of exactly `totalBytes` bytes: `value` with one extra string property padded to the length. Every
 * schema it meets here is a non-strict zod object, so the padding is ignored by the route.
 */
export const paddedJson = (value: Record<string, unknown>, totalBytes: number, key = '_pad') => {
  const base = JSON.stringify({ ...value, [key]: '' });
  const fill = totalBytes - Buffer.byteLength(base);

  if (fill < 0) {
    throw new Error(`paddedJson: ${base.length} bytes before padding, more than ${totalBytes}`);
  }

  return Buffer.from(JSON.stringify({ ...value, [key]: 'a'.repeat(fill) }));
};

// ---------------------------------------------------------------------------
// /api/jobs under the local provider
// ---------------------------------------------------------------------------

/** A job with a schema of z.object({}): its payload's padding is stripped, and it runs in milliseconds. */
export const CLEANUP_JOB = 'internal.cleanup-rate-limits';

export const createPendingCleanupJob = async () =>
  await prisma.backgroundJob.create({
    data: { jobId: CLEANUP_JOB, name: 'Cleanup Rate Limits', version: '1.0.0', payload: {} },
  });

/**
 * A signed local-provider trigger of exactly `totalBytes` bytes, the shape submitJobToEndpoint sends. The padding goes
 * inside the payload, which the signature covers, so the server's HMAC check passes on the whole body.
 */
export const signedCleanupTrigger = (jobId: string, totalBytes: number) => {
  const base = JSON.stringify({ name: CLEANUP_JOB, payload: { pad: '' } });
  const options = { name: CLEANUP_JOB, payload: { pad: 'a'.repeat(totalBytes - Buffer.byteLength(base)) } };
  const body = Buffer.from(JSON.stringify(options));

  return {
    path: `/api/jobs/${CLEANUP_JOB}/${jobId}`,
    body,
    headers: { 'X-Job-Id': jobId, 'X-Job-Signature': sign(options) },
  };
};

export const jobStatus = async (jobId: string) =>
  (await prisma.backgroundJob.findUniqueOrThrow({ where: { id: jobId } })).status;

export { BackgroundJobStatus };

// ---------------------------------------------------------------------------
// /api/auth
// ---------------------------------------------------------------------------

/** A CSRF token and the cookie that carries it, as the sign-in form gets them. */
export const csrfPair = async (forwardedFor: string) => {
  const context = await request.newContext({
    baseURL: NEXT_PUBLIC_WEBAPP_URL(),
    extraHTTPHeaders: { 'X-Forwarded-For': forwardedFor },
  });

  try {
    const { csrfToken } = await (await context.get('/api/auth/csrf')).json();
    const { cookies } = await context.storageState();

    return {
      csrfToken: csrfToken as string,
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    };
  } finally {
    await context.dispose();
  }
};
