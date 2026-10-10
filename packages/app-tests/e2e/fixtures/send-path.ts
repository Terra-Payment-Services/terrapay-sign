/**
 * Fixtures for the V1 send-path specs: the mail catcher, the
 * signing-reminder job, the routes that notify a V1 document's recipients, and
 * a reader for the refusal those routes answer with.
 *
 * Emails are observed in the Inbucket mail catcher the server sends to, through
 * its web API (`GET /api/v1/mailbox/<name>`). Inbucket names a mailbox after the
 * local part of the address, so every recipient gets a unique local part.
 * The web API is reached at E2E_INBUCKET_URL, defaulting to the port the
 * development compose file publishes (9000).
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { sign } from '@documenso/lib/server-only/crypto/sign';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type APIResponse, expect } from '@playwright/test';

export const INBUCKET_URL = (process.env.E2E_INBUCKET_URL || 'http://127.0.0.1:9000').replace(/\/$/, '');

const WEBAPP_URL = NEXT_PUBLIC_WEBAPP_URL();

export const V1_URL = `${WEBAPP_URL}/api/v1`;
export const V2_URL = `${WEBAPP_URL}/api/v2-beta`;

/**
 * How long a negative mail assertion waits. Signing-request emails go out
 * through a background job; the positive controls in these specs see them
 * arrive within about a second, so ten seconds of silence means none was sent.
 */
export const NO_MAIL_WINDOW_MS = 10_000;

export const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export const uniqueLocalPart = (label: string) =>
  `spt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const addressFor = (localPart: string) => `${localPart}@test.documenso.com`;

export type InbucketMessage = { id: string; subject: string; to: string[] };

/** Fails the run, rather than every assertion, when the catcher is not reachable. */
export const assertMailCatcherReachable = async (request: APIRequestContext) => {
  const res = await request.get(`${INBUCKET_URL}/api/v1/mailbox/spt-reachability-probe`).catch(() => null);

  expect(
    res?.ok(),
    `the Inbucket web API must be reachable at ${INBUCKET_URL} (set E2E_INBUCKET_URL); these specs observe email there`,
  ).toBe(true);
};

export const readMailbox = async (request: APIRequestContext, localPart: string) => {
  const res = await request.get(`${INBUCKET_URL}/api/v1/mailbox/${localPart}`);

  expect(res.ok(), `reading mailbox ${localPart}: ${res.status()}`).toBe(true);

  return (await res.json()) as InbucketMessage[];
};

/** Waits until the mailbox holds at least `count` messages and returns them. */
export const waitForMail = async (request: APIRequestContext, localPart: string, count: number) => {
  await expect
    .poll(async () => (await readMailbox(request, localPart)).length, {
      message: `${localPart} should receive ${count} email(s)`,
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(count);

  return await readMailbox(request, localPart);
};

/** Holds for the no-mail window, then asserts the mailbox still holds exactly `count` messages. */
export const expectNoNewMail = async (
  request: APIRequestContext,
  localPart: string,
  count: number,
  context: string,
) => {
  await new Promise((resolve) => setTimeout(resolve, NO_MAIL_WINDOW_MS));

  const messages = await readMailbox(request, localPart);

  expect(
    messages.map((m) => m.subject),
    `${context}: no email reaches ${localPart} (had ${count} before the call)`,
  ).toHaveLength(count);
};

export type Refusal = { status: number; code: string | undefined; message: string; text: string };

/**
 * The status and error code a route answered with. API v1 declares only
 * `message` in its error body, so the code is read from `code` or `data.code`;
 * the v2 OpenAPI layer puts the application code in `data.code`.
 */
export const readRefusal = async (res: APIResponse): Promise<Refusal> => {
  const text = await res.text();
  let body: Record<string, unknown> = {};

  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: status and text are still reported.
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  const dataCode = typeof data.code === 'string' ? data.code : undefined;
  const topCode = typeof body.code === 'string' && body.code !== 'INTERNAL_SERVER_ERROR' ? body.code : undefined;

  return { status: res.status(), code: dataCode ?? topCode, message: String(body.message ?? ''), text };
};

/**
 * Criterion 1: refused with the same 400 and code as the DRAFT send of the same
 * PDF through the same API. Where the DRAFT answer carries no code, the message
 * stands in for it.
 */
export const expectSameRefusalAsDraft = (actual: Refusal, draft: Refusal, context: string) => {
  expect(draft.status, `premise: the DRAFT send of this PDF is refused with 400: ${draft.text}`).toBe(400);

  expect(actual.status, `${context}: refused with the DRAFT path's 400, got ${actual.status}: ${actual.text}`).toBe(
    400,
  );

  if (draft.code) {
    expect(actual.code, `${context}: the DRAFT path's code: ${actual.text}`).toBe(draft.code);
  } else {
    expect(actual.message, `${context}: the DRAFT path's refusal: ${actual.text}`).toBe(draft.message);
  }
};

export const v1Send = async (request: APIRequestContext, token: string, documentId: number) =>
  await request.post(`${V1_URL}/documents/${documentId}/send`, {
    headers: jsonHeaders(token),
    data: { sendEmail: true },
  });

export const v1Resend = async (request: APIRequestContext, token: string, documentId: number, recipientIds: number[]) =>
  await request.post(`${V1_URL}/documents/${documentId}/resend`, {
    headers: jsonHeaders(token),
    data: { recipients: recipientIds },
  });

/** The tRPC `document.distribute` procedure through its OpenAPI route. */
export const v2Distribute = async (request: APIRequestContext, token: string, documentId: number) =>
  await request.post(`${V2_URL}/document/distribute`, { headers: jsonHeaders(token), data: { documentId } });

/** The tRPC `document.redistribute` procedure (resend) through its OpenAPI route. */
export const v2Redistribute = async (
  request: APIRequestContext,
  token: string,
  documentId: number,
  recipientIds: number[],
) =>
  await request.post(`${V2_URL}/document/redistribute`, {
    headers: jsonHeaders(token),
    data: { documentId, recipients: recipientIds },
  });

const REMINDER_JOB = 'internal.process-signing-reminder';

/**
 * Runs the signing reminder for one recipient through the app's job endpoint,
 * exactly as the reminder sweep dispatches it: a PENDING BackgroundJob row,
 * then a signed POST to /api/jobs/<job>/<id>. The sweep itself runs on a
 * 15-minute cron, too slow for a test, and only selects recipients whose
 * nextReminderAt has passed, so that is set first. The endpoint answers after
 * the handler has run.
 */
export const runSigningReminder = async (request: APIRequestContext, recipientId: number) => {
  await prisma.recipient.update({
    where: { id: recipientId },
    data: { nextReminderAt: new Date(Date.now() - 60_000) },
  });

  const job = await prisma.backgroundJob.create({
    data: { jobId: REMINDER_JOB, name: 'Process Signing Reminder', version: '1.0.0', payload: { recipientId } },
  });

  const options = { name: REMINDER_JOB, payload: { recipientId } };

  return await request.post(`${WEBAPP_URL}/api/jobs/${REMINDER_JOB}/${job.id}`, {
    headers: { 'Content-Type': 'application/json', 'X-Job-Id': job.id, 'X-Job-Signature': sign(options) },
    data: JSON.stringify(options),
  });
};
