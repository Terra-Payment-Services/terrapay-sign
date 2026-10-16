import { expect } from '@playwright/test';

import { SHARE_BYTES } from '../../chunked-stall/support/fill';
import type { OpenOptions, RawConnection } from '../../chunked-stall/support/raw-connection';
import {
  buildMultipartBody,
  KIB,
  MIB,
  MULTIPART_CONTENT_TYPE,
  sleepMs,
  TRPC_PATH,
} from '../../chunked-stall/support/raw-connection';
import type { connectionPool } from '../../family-body-limits/support/families';

/**
 * Shared by the declared-budget specs: Content-Length bodies count against the chunked pre-read budget.
 * The budget, the share and the multipart ceiling are the specification's figures,
 * written here rather than read from the server, so that a figure set wrong in the server cannot move the test with it.
 *
 * The server these run against may be configured for 5 MB files (NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT=5), and then
 * /api/files/upload-pdf takes 6 MiB rather than 51 MiB. So every hold that needs more than one file's worth goes to
 * /api/trpc as multipart, signed in (the route then reads the body and waits on it), and every hold is at most 40 MiB,
 * which fits the multipart ceiling under any reading of the specification.
 */

export { SHARE_BYTES };

/** The process-wide budget, shared by chunked pre-reads and declared bodies. */
export const BUDGET_BYTES = 256 * MIB;

/** Criterion 1: the Content-Length multipart ceiling on /api/trpc, /api/v2 and /api/v2-beta. */
export const MULTIPART_CEILING_BYTES = 64 * MIB;

/** The discard allowance: past ceiling + this, the 413 goes out at once with Connection: close. */
export const MAX_DISCARD_BYTES = 64 * MIB;

/** A holder sends this fast after its first bytes: above the 32 KiB/s floor, so the pace bounds never cut it. */
export const HOLD_BYTES_PER_SECOND = 40 * KIB;

/** The largest single hold. Two of them, 40 MiB and 24 MiB, make exactly one client's share. */
export const LARGE_HOLD_BYTES = 40 * MIB;
export const SHARE_REMAINDER_BYTES = SHARE_BYTES - LARGE_HOLD_BYTES;

export const JSON_TYPE = 'application/json';

/** Addresses in 10.46.0.0/16, a range no earlier suite uses, so no rate limiter carries counts over from them. */
export const addressSource = (base: number) => {
  let next = base;

  return () => {
    const index = next;

    next += 1;

    return `10.46.${Math.floor(index / 250)}.${(index % 250) + 1}`;
  };
};

export type Hold = {
  conn: RawConnection;
  /** Stop pacing and send the rest of the body at full speed. */
  complete: () => Promise<void>;
  /** Stop pacing, leaving the body unfinished. */
  stop: () => Promise<void>;
};

/**
 * Open a request that declares `body.length`, send its first 64 KiB at once and the rest at 40 KiB/s. The server
 * reserves the declared length (on the fixed server) when the headers arrive; the pacing only keeps the bounds
 * from ending the request while the test needs it held.
 */
export const openHold = async (
  pool: ReturnType<typeof connectionPool>,
  options: Omit<OpenOptions, 'contentLength'> & { body: Buffer },
): Promise<Hold> => {
  const { body, ...rest } = options;
  const conn = await pool.connect({ ...rest, contentLength: body.length });

  await conn.sendBody(body.subarray(0, 64 * KIB));

  let isStopped = false;
  const paced = conn.sendPaced(body.subarray(conn.bytesSent()), HOLD_BYTES_PER_SECOND, {
    tickMs: 125,
    until: () => isStopped,
  });

  const stop = async () => {
    isStopped = true;
    await paced;
  };

  return {
    conn,
    stop,
    complete: async () => {
      await stop();
      await conn.sendBody(body.subarray(conn.bytesSent()));
    },
  };
};

/** A signed-in multipart hold on /api/trpc of `bytes` declared bytes, which the route reads and waits on. */
export const openTrpcHold = async (
  pool: ReturnType<typeof connectionPool>,
  forwardedFor: string,
  cookie: string,
  bytes: number,
) =>
  await openHold(pool, {
    path: TRPC_PATH,
    contentType: MULTIPART_CONTENT_TYPE,
    forwardedFor,
    headers: { Cookie: cookie },
    body: buildMultipartBody(bytes),
  });

/**
 * Every hold is still open and unanswered. Called a moment after the holds opened, so that a refusal, which the server
 * sends within milliseconds of the headers, has arrived.
 */
export const expectHoldsAdmitted = async (label: string, holds: Hold[]) => {
  await sleepMs(300);

  for (const [index, hold] of holds.entries()) {
    const response = hold.conn.response();

    expect(
      response,
      `${label}: hold ${index} was answered ${response?.statusCode} (${response?.body.slice(0, 120)}) while it should be held`,
    ).toBeNull();
    expect(hold.conn.closedAtMs(), `${label}: hold ${index} was closed while it should be held`).toBeNull();
  }
};

/**
 * Criterion 3 and F5: the busy answer, sent at once from the headers alone (the probe sends no body byte, so an
 * answer at all means nothing waited on the body), and nothing from the route after it.
 */
export const expectBusy = async (label: string, conn: RawConnection) => {
  const response = await conn.waitResponse(5000);

  expect(
    response,
    `${label}: no answer within 5 s (${conn.writeError() ?? conn.closeKind() ?? 'still open'})`,
  ).not.toBeNull();
  expect(response?.statusCode, `${label}: status (body ${response?.body.slice(0, 200)})`).toBe(503);
  expect(response?.headers['retry-after'], `${label}: Retry-After`).toBe('1');
  expect(response?.headers.connection?.toLowerCase(), `${label}: Connection`).toBe('close');
  expect(JSON.parse(response?.body || 'null'), `${label}: body`).toEqual({ error: 'Service unavailable' });

  const headAtMs = response?.headAtMs ?? Number.NaN;

  expect(headAtMs, `${label}: 503 at ${Math.round(headAtMs)} ms`).toBeGreaterThanOrEqual(0);
  expect(headAtMs, `${label}: 503 at ${Math.round(headAtMs)} ms, not at once`).toBeLessThan(1000);

  const closedAt = await conn.waitClosed(headAtMs + 2000);

  expect(closedAt, `${label}: socket still open 2 s after the 503`).not.toBeNull();
  expect(closedAt as number, `${label}: closed before the 503 arrived`).toBeGreaterThanOrEqual(headAtMs);
  expect(
    (closedAt as number) - headAtMs,
    `${label}: closed ${Math.round((closedAt as number) - headAtMs)} ms after the 503`,
  ).toBeLessThanOrEqual(1000);
  expect(conn.responseCount(), `${label}: responses on the connection (the route's answer after the 503?)`).toBe(1);
};

/** Open a request that declares `bytes` and send nothing: whatever answers it has read no body. */
export const openProbe = async (
  pool: ReturnType<typeof connectionPool>,
  options: Omit<OpenOptions, 'contentLength'> & { bytes: number },
) => {
  const { bytes, ...rest } = options;

  return await pool.connect({ ...rest, contentLength: bytes });
};

/** The tRPC route's own answer to a request with no session: 401, before it reads the body. */
export const expectTrpcUnauthorized = (
  label: string,
  conn: RawConnection,
  response: ReturnType<RawConnection['response']>,
) => {
  expect(response, `${label}: no answer (${conn.writeError() ?? conn.closeKind() ?? 'still open'})`).not.toBeNull();
  expect(response?.statusCode, `${label}: status (body ${response?.body.slice(0, 200)})`).toBe(401);
  expect(JSON.parse(response?.body || 'null')?.error?.json?.data?.code, `${label}: route body`).toBe('UNAUTHORIZED');
  expect(conn.responseCount(), `${label}: responses on the connection`).toBe(1);
};

/** The API v2 route's own answer to a request with no session or token: 401, after it has read the body. */
export const expectV2Unauthorized = (
  label: string,
  conn: RawConnection,
  response: ReturnType<RawConnection['response']>,
) => {
  expect(response, `${label}: no answer (${conn.writeError() ?? conn.closeKind() ?? 'still open'})`).not.toBeNull();
  expect(response?.statusCode, `${label}: status (body ${response?.body.slice(0, 200)})`).toBe(401);
  expect(JSON.parse(response?.body || 'null')?.code, `${label}: route body`).toBe('UNAUTHORIZED');
  expect(conn.responseCount(), `${label}: responses on the connection`).toBe(1);
};

/**
 * Criteria 6 and 7 (F3, F4): the client holds nothing. It is admitted for exactly its share, 40 MiB and 24 MiB held
 * open at once, and a 1 KiB declared request beside them is refused. A leak of any size refuses the 24 MiB hold; a
 * share counted short, or not at all, admits the 1 KiB request. The holds are ended before it returns, and the server
 * is given a second to release them.
 */
export const expectShareFree = async (
  label: string,
  pool: ReturnType<typeof connectionPool>,
  forwardedFor: string,
  cookie: string,
) => {
  const holds = [
    await openTrpcHold(pool, forwardedFor, cookie, LARGE_HOLD_BYTES),
    await openTrpcHold(pool, forwardedFor, cookie, SHARE_REMAINDER_BYTES),
  ];

  try {
    await expectHoldsAdmitted(`${label}: the whole share`, holds);

    const probe = await openProbe(pool, {
      path: TRPC_PATH,
      contentType: MULTIPART_CONTENT_TYPE,
      forwardedFor,
      bytes: KIB,
    });

    await expectBusy(`${label}: 1 KiB past the share`, probe);
  } finally {
    await Promise.all(holds.map(async (hold) => await hold.stop()));

    for (const hold of holds) {
      hold.conn.destroy();
    }

    await sleepMs(1000);
  }
};

/** Destroy everything a test opened and give the server a second to release what it held. */
export const releaseAll = async (pool: ReturnType<typeof connectionPool>, holds: Hold[]) => {
  await Promise.all(holds.splice(0).map(async (hold) => await hold.stop()));
  pool.destroyAll();
  await sleepMs(1000);
};
