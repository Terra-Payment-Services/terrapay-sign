/**
 * Once a recipient has rejected, nobody else can sign, complete or reject.
 *
 * Written from the specification before any
 * fix, without reading the recipient write paths. Every request goes to the
 * running server through the route a recipient or the owner uses, and every
 * assertion reads the database: recipient status, fields, signature rows and
 * audit rows.
 *
 * "Rejected but not yet sealed" (C1 to C8) is seeded directly: signer A is
 * REJECTED with a reason and a DOCUMENT_RECIPIENT_REJECTED audit row, the
 * envelope is still PENDING and no seal job is queued. signedAt is set to now
 * so the seal sweep leaves the envelope alone for the length of the test.
 *
 * Each sequential test also runs the same request on a sibling envelope where
 * nobody has rejected, and expects it to succeed, so a refusal cannot come
 * from a malformed request.
 *
 * The interleaved tests (C9 to C12) fire two requests with Promise.all, ten
 * times on fresh envelopes, and attach every attempt's outcome as JSON
 * before asserting. An attempt in which the app's rate limiter answered 429
 * is recorded as rate-limited and rerun on a fresh envelope; it does not count
 * towards the ten. Each iteration also checks that every reply agrees with
 * the database (a request whose effect is absent answered 4xx, one whose
 * effect landed answered 2xx, nothing answered 5xx) and that the envelope was
 * still PENDING when both replies had returned, unless its seal job had
 * already started.
 *
 * Added after the first Codex review: C15 (an unsigned DATE field is not
 * auto-filled by a refused completion), C16 (the owner editing a field while a
 * signer signs neither fails nor deadlocks) and C17 (the loser of two racing
 * requests from one signer gets a 4xx, never a 5xx).
 *
 * Added after the second Codex review: C18 (an assistant's write to B's TEXT
 * field, through envelope.field.sign as the V2 signing page sends it, cannot
 * land after B's completion) and the C17 extension (B's sign or remove after
 * B's completion, and after the envelope has sealed COMPLETED, answers 4xx).
 *
 * Added after the third Codex review: C19 (the same guarantee as C18 for the
 * assistant on the V1 sign and remove routes) and C20 (B's V1 sign of one field
 * fired twice lands once; signing an inserted field answers 4xx).
 *
 * Runs in the `ui` Playwright project (C13 drives the signing page). Needs the
 * Inbucket mail catcher for C13.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import {
  addressFor,
  assertMailCatcherReachable,
  NO_MAIL_WINDOW_MS,
  readMailbox,
  uniqueLocalPart,
  waitForMail,
} from '../fixtures/send-path';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const SEAL_JOB = 'internal.seal-document';
const ITERATIONS = 10;

const REJECTED = 'DOCUMENT_RECIPIENT_REJECTED';
const FIELD_INSERTED = 'DOCUMENT_FIELD_INSERTED';
const FIELD_UNINSERTED = 'DOCUMENT_FIELD_UNINSERTED';
const FIELD_PREFILLED = 'DOCUMENT_FIELD_PREFILLED';
const RECIPIENT_COMPLETED = 'DOCUMENT_RECIPIENT_COMPLETED';
const DOCUMENT_COMPLETED = 'DOCUMENT_COMPLETED';

test.describe.configure({ mode: 'parallel' });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Reply = { status: number; body: string; retryAfterMs: number | null };

/**
 * The app's rate limiter answers 429 before the route runs. A 429 is never the
 * refusal a test expects, and a race in which either side got one is not a
 * valid iteration.
 */
const RATE_LIMITED = 429;
const MAX_RATE_LIMIT_RETRIES = 10;
const DEFAULT_RATE_LIMIT_WAIT_MS = 3_000;

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const toReply = async (res: APIResponse): Promise<Reply> => {
  const retryAfterSeconds = Number(res.headers()['retry-after']);
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds * 1000, 30_000) : null;

  return { status: res.status(), body: await res.text(), retryAfterMs };
};

const rateLimitWaitMs = (reply: Reply) => reply.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;

/**
 * Sends a request. With `retry`, a 429 is sent again after the advertised wait,
 * up to MAX_RATE_LIMIT_RETRIES times; the race calls pass `retry: false`, since
 * a resent request no longer races.
 */
const send = async (post: () => Promise<APIResponse>, what: string, retry: boolean) => {
  for (let attempt = 0; ; attempt++) {
    const reply = await toReply(await post());

    if (reply.status !== RATE_LIMITED || !retry) {
      return reply;
    }

    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      throw new Error(`${what}: still rate-limited (429) after ${MAX_RATE_LIMIT_RETRIES} retries`);
    }

    await pause(rateLimitWaitMs(reply));
  }
};

/** A tRPC mutation that returns the status and body rather than failing on a refusal. */
const trpcRaw = async (request: APIRequestContext, procedure: string, input: Record<string, unknown>, retry = true) =>
  await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ json: input }),
      }),
    procedure,
    retry,
  );

/** The owner's API v2 reject-on-behalf route. */
const rejectOnBehalf = async (
  request: APIRequestContext,
  apiToken: string,
  envelopeId: string,
  recipientId: number,
  reason: string,
) =>
  await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/recipient/${recipientId}/reject`, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        data: { envelopeId, recipientId, reason },
      }),
    'API v2 reject on behalf',
    true,
  );

/**
 * The owner's API v2 field update route, as the editor uses it. Sets a label on
 * a SIGNATURE field, which the route writes whatever the field's position.
 */
const ownerUpdateFieldLabel = async (
  request: APIRequestContext,
  apiToken: string,
  envelopeId: string,
  fieldId: number,
  label: string,
  retry = true,
) =>
  await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/v2-beta/envelope/field/update-many`, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        data: {
          envelopeId,
          data: [{ id: fieldId, type: FieldType.SIGNATURE, fieldMeta: { type: 'signature', label } }],
        },
      }),
    'API v2 field update',
    retry,
  );

const expectOk = (reply: Reply, what: string) => {
  expect(reply.status, `${what}: ${reply.body}`).toBeGreaterThanOrEqual(200);
  expect(reply.status, `${what}: ${reply.body}`).toBeLessThan(300);
};

const expectRefused = (reply: Reply, what: string) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is not a refusal: ${reply.body}`).not.toBe(RATE_LIMITED);
  expect(reply.status, `${what} should be refused with a 4xx: ${reply.body}`).toBeGreaterThanOrEqual(400);
  expect(reply.status, `${what} should be refused with a 4xx: ${reply.body}`).toBeLessThan(500);
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** fieldSecondaryId is what audit rows record as `data.fieldId`. */
type Signer = { id: number; token: string; email: string; name: string; fieldId: number; fieldSecondaryId: string };

type SeededField = { id: number; secondaryId: string };

type Seeded = {
  envelopeId: string;
  documentId: number;
  title: string;
  apiToken: string;
  a: Signer;
  b: Signer;
  /** B's DATE field, present when seeded with `bDate`. */
  bDate?: SeededField;
};

/** Marks a seeded envelope V1 or V2 (API v2 creates V2) and reads it back as the premise. */
const markVersion = async (envelopeId: string, internalVersion: 1 | 2) => {
  if (internalVersion === 1) {
    await prisma.envelope.update({ where: { id: envelopeId }, data: { internalVersion: 1 } });
  }

  const { internalVersion: stored } = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

  expect(stored, `premise: envelope ${envelopeId} is V${internalVersion}`).toBe(internalVersion);
};

const FIELD_BOXES = [
  { positionX: 10, positionY: 60, width: 30, height: 8 },
  { positionX: 10, positionY: 84, width: 30, height: 8 },
];

const DATE_BOX = { positionX: 50, positionY: 84, width: 30, height: 8 };

/**
 * A PENDING V2 envelope in parallel signing order, signers A and B, each with
 * one SIGNATURE field, invitations sent. With `bDate`, B also has a DATE field;
 * its fieldMeta is given explicitly, since V2 cannot handle a DATE field with a
 * null fieldMeta. With `internalVersion: 1` the same envelope is marked V1, for
 * the tests that use the V1 field routes, which refuse V2 envelopes since #142.
 */
const seedEnvelope = async (
  request: APIRequestContext,
  options: { emails?: { a: string; b: string }; bDate?: boolean; internalVersion?: 1 | 2 } = {},
): Promise<Seeded> => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `Reject race ${stamp}`;

  const people = [
    { email: options.emails?.a ?? `r78-a-${stamp}@test.documenso.com`, name: 'Signer A' },
    { email: options.emails?.b ?? `r78-b-${stamp}@test.documenso.com`, name: 'Signer B' },
  ];

  const { envelope, distributeResult, token } = await apiSeedPendingDocument(request, {
    title,
    meta: { signingOrder: 'PARALLEL' },
    recipients: people.map((person) => ({ email: person.email, name: person.name, role: 'SIGNER' as const })),
    fieldsPerRecipient: people.map((_, index) => [
      { type: FieldType.SIGNATURE, page: 1, ...FIELD_BOXES[index] },
      ...(index === 1 && options.bDate
        ? [{ type: FieldType.DATE, page: 1, ...DATE_BOX, fieldMeta: { type: 'date' } }]
        : []),
    ]),
  });

  const signerFor = async (email: string): Promise<Signer> => {
    const recipient = distributeResult.recipients.find((candidate) => candidate.email === email);

    if (!recipient) {
      throw new Error(`Recipient ${email} missing from the distribute response`);
    }

    const field = envelope.fields.find(
      (candidate) => candidate.recipientId === recipient.id && candidate.type === FieldType.SIGNATURE,
    );

    if (!field) {
      throw new Error(`No field for recipient ${email}`);
    }

    const { secondaryId } = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    return {
      id: recipient.id,
      token: recipient.token,
      email,
      name: recipient.name,
      fieldId: field.id,
      fieldSecondaryId: secondaryId,
    };
  };

  const [a, b] = await Promise.all(people.map(async (person) => await signerFor(person.email)));

  const dateField = envelope.fields.find(
    (candidate) => candidate.recipientId === b.id && candidate.type === FieldType.DATE,
  );

  if (options.bDate && !dateField) {
    throw new Error('No DATE field for B');
  }

  const bDate = dateField
    ? {
        id: dateField.id,
        secondaryId: (await prisma.field.findUniqueOrThrow({ where: { id: dateField.id } })).secondaryId,
      }
    : undefined;

  // Keep the seal sweep away: it looks only at envelopes whose recipients last acted long ago.
  await prisma.recipient.updateMany({ where: { envelopeId: envelope.id }, data: { signedAt: new Date() } });

  await markVersion(envelope.id, options.internalVersion ?? 2);

  return {
    envelopeId: envelope.id,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    title,
    apiToken: token,
    a,
    b,
    bDate,
  };
};

/** A has rejected: recipient row and audit row written, envelope still PENDING, no seal job. */
const seedRejectedNotSealed = async (seeded: Seeded, reason = 'A rejected before the seal') => {
  await prisma.recipient.update({
    where: { id: seeded.a.id },
    data: { signingStatus: SigningStatus.REJECTED, rejectionReason: reason, signedAt: new Date() },
  });

  await prisma.documentAuditLog.create({
    data: {
      envelopeId: seeded.envelopeId,
      type: REJECTED,
      name: seeded.a.name,
      email: seeded.a.email,
      data: {
        recipientEmail: seeded.a.email,
        recipientName: seeded.a.name,
        recipientId: seeded.a.id,
        recipientRole: 'SIGNER',
        reason,
      },
    },
  });

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

  expect(envelope.status, 'the rejected-but-unsealed seed leaves the envelope PENDING').toBe(DocumentStatus.PENDING);
  expect(await sealJobsFor(seeded.documentId), 'the seed queues no seal job').toHaveLength(0);
};

// ---------------------------------------------------------------------------
// Recipient actions
// ---------------------------------------------------------------------------

const signV1 = async (request: APIRequestContext, signer: Signer, retry = true) =>
  await trpcRaw(
    request,
    'field.signFieldWithToken',
    {
      token: signer.token,
      fieldId: signer.fieldId,
      value: signer.name,
      isBase64: false,
    },
    retry,
  );

const signV2 = async (request: APIRequestContext, signer: Signer, retry = true) =>
  await trpcRaw(
    request,
    'envelope.field.sign',
    {
      token: signer.token,
      fieldId: signer.fieldId,
      fieldValue: { type: FieldType.SIGNATURE, value: signer.name },
    },
    retry,
  );

const unsignV2 = async (request: APIRequestContext, signer: Signer) =>
  await trpcRaw(request, 'envelope.field.sign', {
    token: signer.token,
    fieldId: signer.fieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: null },
  });

const removeSigned = async (request: APIRequestContext, signer: Signer) =>
  await trpcRaw(request, 'field.removeSignedFieldWithToken', { token: signer.token, fieldId: signer.fieldId });

const complete = async (request: APIRequestContext, seeded: Seeded, signer: Signer, retry = true) =>
  await trpcRaw(
    request,
    'recipient.completeDocumentWithToken',
    {
      token: signer.token,
      documentId: seeded.documentId,
    },
    retry,
  );

const reject = async (request: APIRequestContext, seeded: Seeded, signer: Signer, reason: string, retry = true) =>
  await trpcRaw(
    request,
    'recipient.rejectDocumentWithToken',
    {
      token: signer.token,
      documentId: seeded.documentId,
      reason,
    },
    retry,
  );

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

const recipientRow = async (signer: Signer) => await prisma.recipient.findUniqueOrThrow({ where: { id: signer.id } });

const fieldRow = async (signer: Signer) =>
  await prisma.field.findUniqueOrThrow({ where: { id: signer.fieldId }, include: { signature: true } });

const auditRows = async (envelopeId: string, type: string) =>
  await prisma.documentAuditLog.findMany({ where: { envelopeId, type }, orderBy: { createdAt: 'asc' } });

const recipientIdOf = (row: { data: unknown }) => (row.data as { recipientId?: number } | null)?.recipientId;

const fieldIdOf = (row: { data: unknown }) => (row.data as { fieldId?: string } | null)?.fieldId;

const auditRowsFor = async (envelopeId: string, type: string, signer: Signer) =>
  (await auditRows(envelopeId, type)).filter((row) => recipientIdOf(row) === signer.id);

const fieldAuditRowsById = async (envelopeId: string, type: string, secondaryId: string) =>
  (await auditRows(envelopeId, type)).filter((row) => fieldIdOf(row) === secondaryId);

const fieldAuditRows = async (envelopeId: string, type: string, signer: Signer) =>
  await fieldAuditRowsById(envelopeId, type, signer.fieldSecondaryId);

const sealJobsFor = async (documentId: number) =>
  await prisma.backgroundJob.findMany({
    where: { jobId: SEAL_JOB, payload: { path: ['documentId'], equals: documentId } },
    orderBy: { submittedAt: 'asc' },
  });

const waitForStatus = async (envelopeId: string, status: DocumentStatus) => {
  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

    expect(current.status).toBe(status);
  }).toPass({ timeout: 60_000 });
};

/**
 * After a race: wait until the envelope has left PENDING and every seal job for
 * it has finished, so the rows read afterwards are final. Returns the status.
 */
const waitForSettled = async (seeded: Seeded) => {
  await expect
    .poll(
      async () => {
        const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });
        const jobs = await sealJobsFor(seeded.documentId);
        const jobsDone = jobs.every((job) => job.status === 'COMPLETED' || job.status === 'FAILED');

        return envelope.status !== DocumentStatus.PENDING && jobsDone;
      },
      { message: `envelope ${seeded.envelopeId} should leave PENDING and its seal jobs finish`, timeout: 60_000 },
    )
    .toBe(true);

  return (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } })).status;
};

const time = (row: { createdAt: Date } | undefined) => row?.createdAt.getTime();

const isSuccess = (reply: Reply) => reply.status >= 200 && reply.status < 300;

const isClientError = (reply: Reply) => reply.status >= 400 && reply.status < 500;

/**
 * Null when the reply agrees with the database: 2xx if its effect `landed`,
 * 4xx if it did not. A 5xx is always a failure.
 */
const replyVerdict = (reply: Reply, landed: boolean, what: string): string | null => {
  if (reply.status >= 500) {
    return `${what} answered ${reply.status}: ${reply.body.slice(0, 200)}`;
  }

  if (landed && !isSuccess(reply)) {
    return `${what} landed in the database but answered ${reply.status}`;
  }

  if (!landed && !isClientError(reply)) {
    return `${what} did not land but answered ${reply.status}, not a 4xx`;
  }

  return null;
};

/**
 * Read straight after both replies return. The requests themselves never move
 * the envelope out of PENDING; only the seal job does, so a status other than
 * PENDING is allowed only once a seal job for the envelope has started.
 */
const pendingAfterRace = async (seeded: Seeded) => {
  const { status } = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

  if (status === DocumentStatus.PENDING) {
    return { statusAfterRace: status, problem: null };
  }

  const jobs = await sealJobsFor(seeded.documentId);
  const sealStarted = jobs.some((job) => job.status === 'PROCESSING' || job.status === 'COMPLETED');

  return {
    statusAfterRace: status,
    problem: sealStarted ? null : `the envelope was ${status} straight after the race with no seal job started`,
  };
};

const verdictOf = (...problems: Array<string | null>) => {
  const found = problems.filter((problem): problem is string => problem !== null);

  return found.length > 0 ? found.join('; ') : null;
};

type Outcome = { verdict: string | null; record: Record<string, unknown>; rateLimitedWaitMs?: number };

/** The outcome of a race in which either request was rate-limited, or null if neither was. */
const rateLimited = (seeded: { envelopeId: string }, replies: Record<string, Reply>): Outcome | null => {
  const hits = Object.values(replies).filter((reply) => reply.status === RATE_LIMITED);

  if (hits.length === 0) {
    return null;
  }

  const statuses = Object.fromEntries(Object.entries(replies).map(([key, reply]) => [key, reply.status]));

  return {
    verdict: 'rate-limited',
    record: { envelopeId: seeded.envelopeId, ...statuses },
    rateLimitedWaitMs: Math.max(...hits.map(rateLimitWaitMs)),
  };
};

/**
 * Runs `iterate` until ITERATIONS valid iterations have run, attaching every
 * attempt's outcome, then asserts none failed. A rate-limited attempt is
 * recorded, waited out and rerun on a fresh seed, at most MAX_RATE_LIMIT_RETRIES times.
 */
const runIterations = async (name: string, iterate: () => Promise<Outcome>) => {
  const failures: string[] = [];
  let valid = 0;
  let attempt = 0;
  let rateLimitedAttempts = 0;

  while (valid < ITERATIONS) {
    attempt++;

    const { verdict, record, rateLimitedWaitMs } = await iterate();
    const isRateLimited = rateLimitedWaitMs !== undefined;

    await test.info().attach(`${name}-attempt-${attempt}.json`, {
      body: JSON.stringify(
        { attempt, iteration: isRateLimited ? null : valid + 1, verdict: verdict ?? 'ok', ...record },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    if (isRateLimited) {
      rateLimitedAttempts++;

      if (rateLimitedAttempts > MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `${name}: ${rateLimitedAttempts} attempts were rate-limited (cap ${MAX_RATE_LIMIT_RETRIES}) ` +
            `with ${valid} of ${ITERATIONS} valid iterations run; the run cannot judge the criterion`,
        );
      }

      await pause(rateLimitedWaitMs);
      continue;
    }

    valid++;

    if (verdict) {
      failures.push(`iteration ${valid} (attempt ${attempt}): ${verdict}`);
    }
  }

  expect(failures, `${name}: iterations that broke the criterion`).toEqual([]);
};

// ---------------------------------------------------------------------------
// Sequential, on "rejected but not yet sealed"
// ---------------------------------------------------------------------------

test('C1 B cannot sign its field through the V1 token sign route after A rejected', async ({ request }) => {
  const control = await seedEnvelope(request, { internalVersion: 1 });
  expectOk(await signV1(request, control.b), 'control: B signs through the V1 route with nobody rejected');
  expect((await fieldRow(control.b)).inserted).toBe(true);

  const seeded = await seedEnvelope(request, { internalVersion: 1 });
  await seedRejectedNotSealed(seeded);

  expectRefused(await signV1(request, seeded.b), 'B signing through the V1 route after A rejected');

  const field = await fieldRow(seeded.b);

  expect(field.inserted).toBe(false);
  expect(field.signature).toBeNull();
  expect(await fieldAuditRows(seeded.envelopeId, FIELD_INSERTED, seeded.b)).toHaveLength(0);
});

test('C2 B cannot insert or un-insert a field through the V2 envelope field route after A rejected', async ({
  request,
}) => {
  const control = await seedEnvelope(request);
  expectOk(await signV2(request, control.b), 'control: B inserts through the V2 route with nobody rejected');
  expectOk(await unsignV2(request, control.b), 'control: B un-inserts through the V2 route with nobody rejected');
  expect((await fieldRow(control.b)).inserted).toBe(false);

  // Insert.
  const forInsert = await seedEnvelope(request);
  await seedRejectedNotSealed(forInsert);

  expectRefused(await signV2(request, forInsert.b), 'B inserting through the V2 route after A rejected');

  const uninserted = await fieldRow(forInsert.b);

  expect(uninserted.inserted).toBe(false);
  expect(uninserted.signature).toBeNull();
  expect(await fieldAuditRows(forInsert.envelopeId, FIELD_INSERTED, forInsert.b)).toHaveLength(0);

  // Un-insert of a field B inserted before A rejected.
  const forUninsert = await seedEnvelope(request);
  expectOk(await signV2(request, forUninsert.b), 'B inserts before A rejects');
  await seedRejectedNotSealed(forUninsert);

  const before = await fieldRow(forUninsert.b);

  expect(before.inserted).toBe(true);
  expect(before.signature).not.toBeNull();

  expectRefused(await unsignV2(request, forUninsert.b), 'B un-inserting through the V2 route after A rejected');

  const after = await fieldRow(forUninsert.b);

  expect(after.inserted).toBe(true);
  expect(after.customText).toBe(before.customText);
  expect(after.signature?.id).toBe(before.signature?.id);
  expect(await fieldAuditRows(forUninsert.envelopeId, FIELD_UNINSERTED, forUninsert.b)).toHaveLength(0);
});

test('C3 B cannot remove its signed field after A rejected', async ({ request }) => {
  const control = await seedEnvelope(request, { internalVersion: 1 });
  expectOk(await signV1(request, control.b), 'control: B signs');
  expectOk(await removeSigned(request, control.b), 'control: B removes its signed field with nobody rejected');
  expect((await fieldRow(control.b)).inserted).toBe(false);

  const seeded = await seedEnvelope(request, { internalVersion: 1 });
  expectOk(await signV1(request, seeded.b), 'B signs before A rejects');
  await seedRejectedNotSealed(seeded);

  const before = await fieldRow(seeded.b);

  expect(before.inserted).toBe(true);

  expectRefused(await removeSigned(request, seeded.b), 'B removing its signed field after A rejected');

  const after = await fieldRow(seeded.b);

  expect(after.inserted).toBe(true);
  expect(after.customText).toBe(before.customText);
  expect(after.signature?.id).toBe(before.signature?.id);
  expect(after.signature).not.toBeNull();
});

test('C4 B cannot complete after A rejected', async ({ request }) => {
  const control = await seedEnvelope(request);
  expectOk(await signV2(request, control.b), 'control: B signs');
  expectOk(await complete(request, control, control.b), 'control: B completes with nobody rejected');
  expect((await recipientRow(control.b)).signingStatus).toBe(SigningStatus.SIGNED);

  const seeded = await seedEnvelope(request);
  expectOk(await signV2(request, seeded.b), 'B signs its field before A rejects');
  await seedRejectedNotSealed(seeded);

  expectRefused(await complete(request, seeded, seeded.b), 'B completing after A rejected');

  expect((await recipientRow(seeded.b)).signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(await auditRowsFor(seeded.envelopeId, RECIPIENT_COMPLETED, seeded.b)).toHaveLength(0);
});

test('C5 A, the rejecter, cannot insert a field after rejecting', async ({ request }) => {
  const control = await seedEnvelope(request);
  expectOk(await signV2(request, control.a), 'control: A inserts through the V2 route with nobody rejected');

  const seeded = await seedEnvelope(request);
  await seedRejectedNotSealed(seeded);

  expectRefused(await signV2(request, seeded.a), 'A inserting through the V2 route after rejecting');
  expectRefused(await signV1(request, seeded.a), 'A inserting through the V1 route after rejecting');

  const field = await fieldRow(seeded.a);

  expect(field.inserted).toBe(false);
  expect(field.signature).toBeNull();
  expect(await fieldAuditRows(seeded.envelopeId, FIELD_INSERTED, seeded.a)).toHaveLength(0);
});

test('C6 B cannot reject after A rejected', async ({ request }) => {
  const control = await seedEnvelope(request);
  expectOk(await reject(request, control, control.b, 'Control rejection'), 'control: B rejects with nobody rejected');

  const seeded = await seedEnvelope(request);
  await seedRejectedNotSealed(seeded);

  expectRefused(await reject(request, seeded, seeded.b, 'B also rejects'), 'B rejecting after A rejected');

  const b = await recipientRow(seeded.b);

  expect(b.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(b.rejectionReason).toBeNull();
  expect(await auditRows(seeded.envelopeId, REJECTED)).toHaveLength(1);
});

test('C7 A rejecting a second time is refused or does nothing', async ({ request }) => {
  const seeded = await seedEnvelope(request);
  await seedRejectedNotSealed(seeded, 'First reason');

  const reply = await reject(request, seeded, seeded.a, 'Second reason');

  expect(reply.status, `A rejecting again: refusal (4xx) or no-op (2xx), never 5xx: ${reply.body}`).toBeLessThan(500);

  const a = await recipientRow(seeded.a);

  expect(a.signingStatus).toBe(SigningStatus.REJECTED);
  expect(a.rejectionReason).toBe('First reason');
  expect(await auditRows(seeded.envelopeId, REJECTED)).toHaveLength(1);
});

test('C8 the owner cannot reject on behalf of B through API v2 after A rejected', async ({ request }) => {
  const control = await seedEnvelope(request);
  expectOk(
    await rejectOnBehalf(request, control.apiToken, control.envelopeId, control.b.id, 'Control'),
    'control: the owner rejects for B with nobody rejected',
  );
  expect((await recipientRow(control.b)).signingStatus).toBe(SigningStatus.REJECTED);

  const seeded = await seedEnvelope(request);
  await seedRejectedNotSealed(seeded);

  expectRefused(
    await rejectOnBehalf(request, seeded.apiToken, seeded.envelopeId, seeded.b.id, 'Owner rejects for B'),
    'the owner rejecting on behalf of B after A rejected',
  );

  const b = await recipientRow(seeded.b);

  expect(b.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(b.rejectionReason).toBeNull();
  expect(await auditRows(seeded.envelopeId, REJECTED)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Interleaved, fired together, ten fresh envelopes each
//
// Audit rows are ordered by createdAt, compared in milliseconds with <=, since
// two rows written in the same millisecond cannot be told apart.
// ---------------------------------------------------------------------------

test("C9 A's reject and B's field sign together: the sign lands only before the rejection", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C9', async () => {
    const seeded = await seedEnvelope(request);

    const [rejectReply, signReply] = await Promise.all([
      reject(request, seeded, seeded.a, 'A rejects during the race', false),
      signV2(request, seeded.b, false),
    ]);

    const limited = rateLimited(seeded, { rejectReply, signReply });

    if (limited) {
      return limited;
    }

    const { statusAfterRace, problem: pendingProblem } = await pendingAfterRace(seeded);
    const envelopeStatus = await waitForSettled(seeded);
    const a = await recipientRow(seeded.a);
    const field = await fieldRow(seeded.b);
    const rejection = await auditRowsFor(seeded.envelopeId, REJECTED, seeded.a);
    const inserts = await fieldAuditRows(seeded.envelopeId, FIELD_INSERTED, seeded.b);

    const record = {
      envelopeId: seeded.envelopeId,
      rejectReply: rejectReply.status,
      signReply: signReply.status,
      statusAfterRace,
      envelopeStatus,
      aStatus: a.signingStatus,
      bFieldInserted: field.inserted,
      bSignature: field.signature !== null,
      rejectionAt: rejection.map((row) => row.createdAt.toISOString()),
      insertAt: inserts.map((row) => row.createdAt.toISOString()),
    };

    let verdict: string | null = null;

    const rejectWon = !field.inserted && field.signature === null && inserts.length === 0;
    const signWon =
      field.inserted &&
      field.signature !== null &&
      inserts.length === 1 &&
      rejection.length === 1 &&
      (time(inserts[0]) ?? Infinity) <= (time(rejection[0]) ?? -Infinity);

    if (a.signingStatus !== SigningStatus.REJECTED) {
      verdict = `A is ${a.signingStatus}, expected REJECTED`;
    } else if (rejection.length !== 1) {
      verdict = `${rejection.length} rejection rows, expected 1`;
    } else if (!rejectWon && !signWon) {
      verdict = "B's field changed after the rejection was recorded";
    }

    return {
      verdict: verdictOf(
        verdict,
        replyVerdict(rejectReply, a.signingStatus === SigningStatus.REJECTED, "A's reject"),
        replyVerdict(signReply, field.inserted, "B's sign"),
        pendingProblem,
      ),
      record,
    };
  });
});

test("C10 A's reject and B's complete together: B completes only before the rejection", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C10', async () => {
    const seeded = await seedEnvelope(request);

    expectOk(await signV2(request, seeded.b), 'B signs its field before the race');

    const [rejectReply, completeReply] = await Promise.all([
      reject(request, seeded, seeded.a, 'A rejects during the race', false),
      complete(request, seeded, seeded.b, false),
    ]);

    const limited = rateLimited(seeded, { rejectReply, completeReply });

    if (limited) {
      return limited;
    }

    const { statusAfterRace, problem: pendingProblem } = await pendingAfterRace(seeded);
    const envelopeStatus = await waitForSettled(seeded);
    const a = await recipientRow(seeded.a);
    const b = await recipientRow(seeded.b);
    const rejection = await auditRowsFor(seeded.envelopeId, REJECTED, seeded.a);
    const completion = await auditRowsFor(seeded.envelopeId, RECIPIENT_COMPLETED, seeded.b);

    const record = {
      envelopeId: seeded.envelopeId,
      rejectReply: rejectReply.status,
      completeReply: completeReply.status,
      statusAfterRace,
      envelopeStatus,
      aStatus: a.signingStatus,
      bStatus: b.signingStatus,
      rejectionAt: rejection.map((row) => row.createdAt.toISOString()),
      completionAt: completion.map((row) => row.createdAt.toISOString()),
    };

    let verdict: string | null = null;

    const completeWon =
      b.signingStatus === SigningStatus.SIGNED &&
      completion.length === 1 &&
      rejection.length === 1 &&
      (time(completion[0]) ?? Infinity) <= (time(rejection[0]) ?? -Infinity);
    const rejectWon = b.signingStatus === SigningStatus.NOT_SIGNED && completion.length === 0;

    if (a.signingStatus !== SigningStatus.REJECTED) {
      verdict = `A is ${a.signingStatus}, expected REJECTED`;
    } else if (rejection.length !== 1) {
      verdict = `${rejection.length} rejection rows, expected 1`;
    } else if (!completeWon && !rejectWon) {
      verdict = `B is ${b.signingStatus} with ${completion.length} completion row(s), not ordered before the rejection`;
    }

    return {
      verdict: verdictOf(
        verdict,
        replyVerdict(rejectReply, a.signingStatus === SigningStatus.REJECTED, "A's reject"),
        replyVerdict(completeReply, b.signingStatus === SigningStatus.SIGNED, "B's complete"),
        pendingProblem,
      ),
      record,
    };
  });
});

test("C11 A's reject and A's complete together: A ends rejected or signed, never both", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C11', async () => {
    const seeded = await seedEnvelope(request);

    expectOk(await signV2(request, seeded.b), 'B signs before the race');
    expectOk(await complete(request, seeded, seeded.b), 'B completes before the race');
    expectOk(await signV2(request, seeded.a), 'A inserts its field before the race');

    const [rejectReply, completeReply] = await Promise.all([
      reject(request, seeded, seeded.a, 'A rejects during the race', false),
      complete(request, seeded, seeded.a, false),
    ]);

    const limited = rateLimited(seeded, { rejectReply, completeReply });

    if (limited) {
      return limited;
    }

    const { statusAfterRace, problem: pendingProblem } = await pendingAfterRace(seeded);
    const envelopeStatus = await waitForSettled(seeded);
    const a = await recipientRow(seeded.a);
    const rejection = await auditRowsFor(seeded.envelopeId, REJECTED, seeded.a);
    const completion = await auditRowsFor(seeded.envelopeId, RECIPIENT_COMPLETED, seeded.a);

    const record = {
      envelopeId: seeded.envelopeId,
      rejectReply: rejectReply.status,
      completeReply: completeReply.status,
      statusAfterRace,
      envelopeStatus,
      aStatus: a.signingStatus,
      rejectionRows: rejection.length,
      completionRows: completion.length,
    };

    let verdict: string | null = null;

    const rejectWon = a.signingStatus === SigningStatus.REJECTED && completion.length === 0 && rejection.length === 1;
    const completeWon = a.signingStatus === SigningStatus.SIGNED && rejection.length === 0 && completion.length === 1;

    if (!rejectWon && !completeWon) {
      verdict = `A is ${a.signingStatus} with ${rejection.length} rejection row(s) and ${completion.length} completion row(s)`;
    }

    return {
      verdict: verdictOf(
        verdict,
        replyVerdict(rejectReply, a.signingStatus === SigningStatus.REJECTED, "A's reject"),
        replyVerdict(completeReply, a.signingStatus === SigningStatus.SIGNED, "A's complete"),
        pendingProblem,
      ),
      record,
    };
  });
});

test("C12 A's reject and B's reject together: exactly one rejection lands", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C12', async () => {
    const seeded = await seedEnvelope(request);

    const [aReply, bReply] = await Promise.all([
      reject(request, seeded, seeded.a, 'A rejects during the race', false),
      reject(request, seeded, seeded.b, 'B rejects during the race', false),
    ]);

    const limited = rateLimited(seeded, { aReply, bReply });

    if (limited) {
      return limited;
    }

    const { statusAfterRace, problem: pendingProblem } = await pendingAfterRace(seeded);
    const envelopeStatus = await waitForSettled(seeded);
    const recipients = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId } });
    const rejectedCount = recipients.filter((row) => row.signingStatus === SigningStatus.REJECTED).length;
    const rejection = await auditRows(seeded.envelopeId, REJECTED);

    const record = {
      envelopeId: seeded.envelopeId,
      aReply: aReply.status,
      bReply: bReply.status,
      statusAfterRace,
      envelopeStatus,
      statuses: recipients.map((row) => ({ id: row.id, signingStatus: row.signingStatus })),
      rejectionRows: rejection.length,
    };

    let verdict: string | null = null;

    if (rejectedCount !== 1 || rejection.length !== 1) {
      verdict = `${rejectedCount} REJECTED recipient(s) and ${rejection.length} rejection row(s), expected 1 and 1`;
    }

    const isRejected = (signer: Signer) =>
      recipients.find((row) => row.id === signer.id)?.signingStatus === SigningStatus.REJECTED;

    return {
      verdict: verdictOf(
        verdict,
        replyVerdict(aReply, isRejected(seeded.a), "A's reject"),
        replyVerdict(bReply, isRejected(seeded.b), "B's reject"),
        pendingProblem,
      ),
      record,
    };
  });
});

// ---------------------------------------------------------------------------
// Added after the first Codex review
// ---------------------------------------------------------------------------

const dateFieldRow = async (seeded: Seeded) => {
  if (!seeded.bDate) {
    throw new Error('Seeded without a DATE field for B');
  }

  return await prisma.field.findUniqueOrThrow({ where: { id: seeded.bDate.id } });
};

const dateInsertRows = async (seeded: Seeded) => {
  if (!seeded.bDate) {
    throw new Error('Seeded without a DATE field for B');
  }

  return await fieldAuditRowsById(seeded.envelopeId, FIELD_INSERTED, seeded.bDate.secondaryId);
};

test("C15 a refused completion leaves B's DATE field unfilled", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  // Control: with nobody rejected, completing fills the DATE field.
  const control = await seedEnvelope(request, { bDate: true });
  expectOk(await signV2(request, control.b), 'control: B signs');
  expectOk(await complete(request, control, control.b), 'control: B completes with nobody rejected');
  expect((await dateFieldRow(control)).inserted, 'control: completing fills the DATE field').toBe(true);

  // Sequential, on "rejected but not yet sealed".
  const seeded = await seedEnvelope(request, { bDate: true });
  expectOk(await signV2(request, seeded.b), 'B signs its signature field before A rejects');
  await seedRejectedNotSealed(seeded);

  expectRefused(await complete(request, seeded, seeded.b), 'B completing after A rejected');

  const date = await dateFieldRow(seeded);

  expect((await recipientRow(seeded.b)).signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(date.inserted).toBe(false);
  expect(date.customText).toBe('');
  expect(await dateInsertRows(seeded)).toHaveLength(0);

  // Fired together with A's reject.
  await runIterations('C15', async () => {
    const raced = await seedEnvelope(request, { bDate: true });

    expectOk(await signV2(request, raced.b), 'B signs its signature field before the race');

    const [rejectReply, completeReply] = await Promise.all([
      reject(request, raced, raced.a, 'A rejects during the race', false),
      complete(request, raced, raced.b, false),
    ]);

    const limited = rateLimited(raced, { rejectReply, completeReply });

    if (limited) {
      return limited;
    }

    const { statusAfterRace, problem: pendingProblem } = await pendingAfterRace(raced);
    const envelopeStatus = await waitForSettled(raced);
    const a = await recipientRow(raced.a);
    const b = await recipientRow(raced.b);
    const racedDate = await dateFieldRow(raced);
    const racedDateInserts = await dateInsertRows(raced);

    const record = {
      envelopeId: raced.envelopeId,
      rejectReply: rejectReply.status,
      completeReply: completeReply.status,
      statusAfterRace,
      envelopeStatus,
      aStatus: a.signingStatus,
      bStatus: b.signingStatus,
      dateInserted: racedDate.inserted,
      dateValue: racedDate.customText,
      dateInsertRows: racedDateInserts.length,
    };

    const isCompleted = b.signingStatus === SigningStatus.SIGNED;
    const dateProblem =
      !isCompleted && (racedDate.inserted || racedDate.customText !== '' || racedDateInserts.length > 0)
        ? "B's completion was refused but its DATE field was filled"
        : null;

    return {
      verdict: verdictOf(
        dateProblem,
        replyVerdict(rejectReply, a.signingStatus === SigningStatus.REJECTED, "A's reject"),
        replyVerdict(completeReply, isCompleted, "B's complete"),
        pendingProblem,
      ),
      record,
    };
  });
});

/**
 * The runner also checks the server log for "deadlock detected" after this
 * test; the test itself can only see the replies and the database.
 */
test("C16 the owner editing A's field while B signs: both succeed, neither answers 5xx", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C16', async () => {
    const seeded = await seedEnvelope(request);
    const label = `Owner edit ${seeded.envelopeId}`;

    const [updateReply, signReply] = await Promise.all([
      ownerUpdateFieldLabel(request, seeded.apiToken, seeded.envelopeId, seeded.a.fieldId, label, false),
      signV2(request, seeded.b, false),
    ]);

    const limited = rateLimited(seeded, { updateReply, signReply });

    if (limited) {
      return limited;
    }

    const aField = await prisma.field.findUniqueOrThrow({ where: { id: seeded.a.fieldId } });
    const bField = await fieldRow(seeded.b);
    const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });
    const aLabel = (aField.fieldMeta as { label?: string } | null)?.label;

    const record = {
      envelopeId: seeded.envelopeId,
      updateReply: updateReply.status,
      signReply: signReply.status,
      envelopeStatus: envelope.status,
      aLabel,
      bFieldInserted: bField.inserted,
    };

    const problems = [
      isSuccess(updateReply)
        ? null
        : `the owner's update answered ${updateReply.status}: ${updateReply.body.slice(0, 200)}`,
      isSuccess(signReply) ? null : `B's sign answered ${signReply.status}: ${signReply.body.slice(0, 200)}`,
      aLabel === label ? null : "the owner's label is not on A's field",
      bField.inserted ? null : "B's field is not inserted",
      envelope.status === DocumentStatus.PENDING ? null : `the envelope is ${envelope.status}, expected PENDING`,
    ];

    return { verdict: verdictOf(...problems), record };
  });
});

test("C17 B's complete racing B's V1 sign: the loser answers 4xx, never 5xx", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C17-sign', async () => {
    const seeded = await seedEnvelope(request, { internalVersion: 1 });

    const [completeReply, signReply] = await Promise.all([
      complete(request, seeded, seeded.b, false),
      signV1(request, seeded.b, false),
    ]);

    const limited = rateLimited(seeded, { completeReply, signReply });

    if (limited) {
      return limited;
    }

    const b = await recipientRow(seeded.b);
    const field = await fieldRow(seeded.b);
    const isCompleted = b.signingStatus === SigningStatus.SIGNED;

    const record = {
      envelopeId: seeded.envelopeId,
      completeReply: completeReply.status,
      signReply: signReply.status,
      bStatus: b.signingStatus,
      bFieldInserted: field.inserted,
    };

    return {
      verdict: verdictOf(
        isCompleted && !field.inserted ? 'B is SIGNED with its field uninserted' : null,
        replyVerdict(completeReply, isCompleted, "B's complete"),
        replyVerdict(signReply, field.inserted, "B's sign"),
      ),
      record,
    };
  });
});

test("C17 B's complete racing B's remove-signed-field: the loser answers 4xx, never 5xx", async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C17-remove', async () => {
    const seeded = await seedEnvelope(request, { internalVersion: 1 });

    expectOk(await signV1(request, seeded.b), 'B signs before the race');

    const [completeReply, removeReply] = await Promise.all([
      complete(request, seeded, seeded.b, false),
      trpcRaw(request, 'field.removeSignedFieldWithToken', { token: seeded.b.token, fieldId: seeded.b.fieldId }, false),
    ]);

    const limited = rateLimited(seeded, { completeReply, removeReply });

    if (limited) {
      return limited;
    }

    const b = await recipientRow(seeded.b);
    const field = await fieldRow(seeded.b);
    const isCompleted = b.signingStatus === SigningStatus.SIGNED;

    const record = {
      envelopeId: seeded.envelopeId,
      completeReply: completeReply.status,
      removeReply: removeReply.status,
      bStatus: b.signingStatus,
      bFieldInserted: field.inserted,
    };

    return {
      verdict: verdictOf(
        isCompleted && !field.inserted ? 'B is SIGNED with its field removed' : null,
        replyVerdict(completeReply, isCompleted, "B's complete"),
        replyVerdict(removeReply, !field.inserted, "B's remove"),
      ),
      record,
    };
  });
});

// ---------------------------------------------------------------------------
// Added after the second Codex review
// ---------------------------------------------------------------------------

/** The sign and remove calls of each version's routes: V1 field routes on a V1 envelope, envelope.field.sign on V2. */
const ROUTES = {
  1: { sign: signV1, remove: removeSigned },
  2: { sign: signV2, remove: unsignV2 },
} as const;

for (const version of [1, 2] as const) {
  test(`C17 after B has completed, and after the seal, B signing or removing answers 4xx (V${version} envelope, V${version} routes)`, async ({
    request,
  }) => {
    const { sign, remove } = ROUTES[version];

    test.setTimeout(180_000);

    const expectFieldUnchanged = async (seeded: Seeded, before: Awaited<ReturnType<typeof fieldRow>>, when: string) => {
      const after = await fieldRow(seeded.b);

      expect(after.inserted, `${when}: B's field stays inserted`).toBe(true);
      expect(after.customText, `${when}: B's field value is unchanged`).toBe(before.customText);
      expect(after.signature?.id, `${when}: B's signature row is unchanged`).toBe(before.signature?.id);
      expect(
        await fieldAuditRows(seeded.envelopeId, FIELD_INSERTED, seeded.b),
        `${when}: no new insert row`,
      ).toHaveLength(1);
      expect(
        await fieldAuditRows(seeded.envelopeId, FIELD_UNINSERTED, seeded.b),
        `${when}: no uninsert row`,
      ).toHaveLength(0);
    };

    // B has completed and the envelope is still PENDING, since A has not.
    const pending = await seedEnvelope(request, { internalVersion: version });

    expectOk(await sign(request, pending.b), 'B signs');
    expectOk(await complete(request, pending, pending.b), 'B completes');
    expect((await recipientRow(pending.b)).signingStatus).toBe(SigningStatus.SIGNED);

    const pendingBefore = await fieldRow(pending.b);

    expectRefused(await sign(request, pending.b), 'B signing after its own completion');
    expectRefused(await remove(request, pending.b), 'B removing a signed field after its own completion');
    await expectFieldUnchanged(pending, pendingBefore, 'after B completed');
    expect((await prisma.envelope.findUniqueOrThrow({ where: { id: pending.envelopeId } })).status).toBe(
      DocumentStatus.PENDING,
    );

    // Both have completed and the envelope has sealed COMPLETED.
    const sealed = await seedEnvelope(request, { internalVersion: version });

    expectOk(await sign(request, sealed.a), 'A signs');
    expectOk(await complete(request, sealed, sealed.a), 'A completes');
    expectOk(await sign(request, sealed.b), 'B signs');
    expectOk(await complete(request, sealed, sealed.b), 'B completes');
    await waitForStatus(sealed.envelopeId, DocumentStatus.COMPLETED);

    const sealedBefore = await fieldRow(sealed.b);

    expectRefused(await sign(request, sealed.b), 'B signing after the envelope sealed COMPLETED');
    expectRefused(await remove(request, sealed.b), 'B removing a signed field after the envelope sealed COMPLETED');
    await expectFieldUnchanged(sealed, sealedBefore, 'after the seal');
  });
}

const B_TEXT_VALUE = 'Written by B';
const ASSISTANT_TEXT_VALUE = 'Written by the assistant';

type AssistantSeeded = {
  envelopeId: string;
  documentId: number;
  assistant: { id: number; token: string };
  b: Signer;
  bText: SeededField;
};

/**
 * A PENDING V2 envelope with an ASSISTANT (signing order 1) and signer B
 * (signing order 2), B holding a SIGNATURE field and a required TEXT field.
 * Created SEQUENTIAL, as an assistant envelope is, then seeded directly into
 * the state the signing order would otherwise forbid: the order is flipped to
 * PARALLEL so B can complete while the assistant is still NOT_SIGNED and able
 * to act, and B's two fields are written as inserted (B's text and a typed
 * signature) without going through the routes.
 *
 * With `textInserted: false` the TEXT field is optional and left uninserted, so
 * B can still complete and the V1 sign route, which refuses an inserted field,
 * has something to insert.
 */
const seedAssistantEnvelope = async (
  request: APIRequestContext,
  options: { textInserted?: boolean; internalVersion?: 1 | 2 } = {},
): Promise<AssistantSeeded> => {
  const textInserted = options.textInserted ?? true;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    title: `Assistant race ${stamp}`,
    meta: { signingOrder: 'SEQUENTIAL' },
    recipients: [
      { email: `r78-asst-${stamp}@test.documenso.com`, name: 'Assistant', role: 'ASSISTANT', signingOrder: 1 },
      { email: `r78-b-${stamp}@test.documenso.com`, name: 'Signer B', role: 'SIGNER', signingOrder: 2 },
    ],
    fieldsPerRecipient: [
      [],
      [
        { type: FieldType.SIGNATURE, page: 1, ...FIELD_BOXES[0] },
        { type: FieldType.TEXT, page: 1, ...FIELD_BOXES[1], fieldMeta: { type: 'text', required: textInserted } },
      ],
    ],
  });

  const assistant = distributeResult.recipients.find((candidate) => candidate.role === 'ASSISTANT');
  const signer = distributeResult.recipients.find((candidate) => candidate.role === 'SIGNER');

  if (!assistant || !signer) {
    throw new Error('Expected an ASSISTANT and a SIGNER in the distribute response');
  }

  const rows = await prisma.recipient.findMany({ where: { envelopeId: envelope.id } });
  const assistantOrder = rows.find((row) => row.id === assistant.id)?.signingOrder;
  const signerOrder = rows.find((row) => row.id === signer.id)?.signingOrder;

  // The assistant may write only fields of recipients at or after its own signing order.
  if (assistantOrder == null || signerOrder == null || signerOrder < assistantOrder) {
    throw new Error(`Seeded signing orders ${assistantOrder} and ${signerOrder} do not let the assistant act for B`);
  }

  const fields = await prisma.field.findMany({ where: { envelopeId: envelope.id, recipientId: signer.id } });
  const signatureField = fields.find((field) => field.type === FieldType.SIGNATURE);
  const textField = fields.find((field) => field.type === FieldType.TEXT);

  if (!signatureField || !textField) {
    throw new Error("B's SIGNATURE and TEXT fields not found");
  }

  const { documentMetaId, secondaryId } = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

  await prisma.documentMeta.update({ where: { id: documentMetaId }, data: { signingOrder: 'PARALLEL' } });

  await prisma.field.update({ where: { id: signatureField.id }, data: { inserted: true, customText: '' } });
  await prisma.signature.create({
    data: { fieldId: signatureField.id, recipientId: signer.id, typedSignature: signer.name },
  });

  if (textInserted) {
    await prisma.field.update({ where: { id: textField.id }, data: { inserted: true, customText: B_TEXT_VALUE } });
  }

  // Keep the seal sweep away, as seedEnvelope does.
  await prisma.recipient.updateMany({ where: { envelopeId: envelope.id }, data: { signedAt: new Date() } });

  await markVersion(envelope.id, options.internalVersion ?? 2);

  return {
    envelopeId: envelope.id,
    documentId: mapSecondaryIdToDocumentId(secondaryId),
    assistant: { id: assistant.id, token: assistant.token },
    b: {
      id: signer.id,
      token: signer.token,
      email: signer.email,
      name: signer.name,
      fieldId: signatureField.id,
      fieldSecondaryId: signatureField.secondaryId,
    },
    bText: { id: textField.id, secondaryId: textField.secondaryId },
  };
};

/** The assistant writing B's TEXT field through envelope.field.sign, as the V2 signing page does; null removes it. */
const assistantWriteText = async (
  request: APIRequestContext,
  seeded: AssistantSeeded,
  value: string | null,
  retry = true,
) =>
  await trpcRaw(
    request,
    'envelope.field.sign',
    { token: seeded.assistant.token, fieldId: seeded.bText.id, fieldValue: { type: FieldType.TEXT, value } },
    retry,
  );

const completeB = async (request: APIRequestContext, seeded: AssistantSeeded, retry = true) =>
  await trpcRaw(
    request,
    'recipient.completeDocumentWithToken',
    { token: seeded.b.token, documentId: seeded.documentId },
    retry,
  );

const textFieldRow = async (seeded: AssistantSeeded) =>
  await prisma.field.findUniqueOrThrow({ where: { id: seeded.bText.id } });

/**
 * C18. The spec's "B's TEXT field is inserted with B's value, unchanged after
 * B's completion row" is read as: no assistant write lands after the completion.
 * The V2 route, like V1, refuses an insert on an inserted field (#131; the
 * signing page removes a value before writing a new one), so the insert cases
 * seed B's TEXT field optional and uninserted, as C19 does, and a refused insert
 * leaves it so.
 * An assistant insert that is serialised before B's completion legitimately
 * leaves the assistant's value, so when B is SIGNED the field must be inserted,
 * holding either B's value (the write was refused) or the assistant's value
 * with its PREFILLED row no later than the completion row. The assistant's
 * removal writes no audit row, so it is detected by the field being uninserted;
 * a removal before the completion makes the completion fail on the required
 * field, so B SIGNED with an uninserted field, or with a 2xx removal, breaks it.
 */
test("C18 the assistant's write to B's TEXT field cannot land after B's completion", async ({ request }) => {
  test.setTimeout(30 * 60_000);

  // Controls, so a refusal in the race cannot come from a seed the routes reject.
  const insertControl = await seedAssistantEnvelope(request, { textInserted: false });
  expectOk(
    await assistantWriteText(request, insertControl, ASSISTANT_TEXT_VALUE),
    "control: the assistant writes B's TEXT field",
  );
  expect((await textFieldRow(insertControl)).customText).toBe(ASSISTANT_TEXT_VALUE);
  expect(
    await fieldAuditRowsById(insertControl.envelopeId, FIELD_PREFILLED, insertControl.bText.secondaryId),
  ).toHaveLength(1);

  const removeControl = await seedAssistantEnvelope(request);
  expectOk(await assistantWriteText(request, removeControl, null), "control: the assistant removes B's TEXT value");
  expect((await textFieldRow(removeControl)).inserted).toBe(false);

  const completeControl = await seedAssistantEnvelope(request);
  expectOk(await completeB(request, completeControl), 'control: B completes on the seeded fields');
  expect((await recipientRow(completeControl.b)).signingStatus).toBe(SigningStatus.SIGNED);
  expect((await prisma.envelope.findUniqueOrThrow({ where: { id: completeControl.envelopeId } })).status).toBe(
    DocumentStatus.PENDING,
  );

  const race = (variant: 'insert' | 'remove') => async (): Promise<Outcome> => {
    const seeded = await seedAssistantEnvelope(request, { textInserted: variant === 'remove' });
    const value = variant === 'insert' ? ASSISTANT_TEXT_VALUE : null;

    const [writeReply, completeReply] = await Promise.all([
      assistantWriteText(request, seeded, value, false),
      completeB(request, seeded, false),
    ]);

    const limited = rateLimited(seeded, { writeReply, completeReply });

    if (limited) {
      return limited;
    }

    const b = await recipientRow(seeded.b);
    const text = await textFieldRow(seeded);
    const completion = await auditRowsFor(seeded.envelopeId, RECIPIENT_COMPLETED, seeded.b);
    const prefills = await fieldAuditRowsById(seeded.envelopeId, FIELD_PREFILLED, seeded.bText.secondaryId);
    const isCompleted = b.signingStatus === SigningStatus.SIGNED;

    const record = {
      envelopeId: seeded.envelopeId,
      variant,
      writeReply: writeReply.status,
      completeReply: completeReply.status,
      bStatus: b.signingStatus,
      textInserted: text.inserted,
      textValue: text.customText,
      completionAt: completion.map((row) => row.createdAt.toISOString()),
      prefillAt: prefills.map((row) => row.createdAt.toISOString()),
    };

    const problems: Array<string | null> = [];

    if (isCompleted) {
      const completedAt = time(completion[0]) ?? -Infinity;

      const isSeededState =
        variant === 'insert'
          ? !text.inserted && text.customText === ''
          : text.inserted && text.customText === B_TEXT_VALUE;
      const isEarlierInsert = variant === 'insert' && text.inserted && text.customText === ASSISTANT_TEXT_VALUE;

      problems.push(completion.length === 1 ? null : `B is SIGNED with ${completion.length} completion row(s)`);
      problems.push(
        isSeededState || isEarlierInsert
          ? null
          : `B is SIGNED with its TEXT field inserted=${text.inserted} holding "${text.customText}"`,
      );
      problems.push(
        prefills.every((row) => (time(row) ?? Infinity) <= completedAt)
          ? null
          : "the assistant's write was recorded after B's completion",
      );
      problems.push(
        text.customText === ASSISTANT_TEXT_VALUE && prefills.length === 0
          ? "B's TEXT field holds the assistant's value with no PREFILLED row"
          : null,
      );
    } else {
      problems.push(completion.length === 0 ? null : `B is ${b.signingStatus} with a completion row`);
    }

    const landed = variant === 'insert' ? text.customText === ASSISTANT_TEXT_VALUE : !text.inserted;

    return {
      verdict: verdictOf(
        ...problems,
        replyVerdict(writeReply, landed, `the assistant's ${variant}`),
        replyVerdict(completeReply, isCompleted, "B's complete"),
      ),
      record,
    };
  };

  await runIterations('C18-insert', race('insert'));
  await runIterations('C18-remove', race('remove'));
});

// ---------------------------------------------------------------------------
// Added after the third Codex review
// ---------------------------------------------------------------------------

const assistantSignV1 = async (request: APIRequestContext, seeded: AssistantSeeded, retry = true) =>
  await trpcRaw(
    request,
    'field.signFieldWithToken',
    { token: seeded.assistant.token, fieldId: seeded.bText.id, value: ASSISTANT_TEXT_VALUE, isBase64: false },
    retry,
  );

const assistantRemoveV1 = async (request: APIRequestContext, seeded: AssistantSeeded, retry = true) =>
  await trpcRaw(
    request,
    'field.removeSignedFieldWithToken',
    { token: seeded.assistant.token, fieldId: seeded.bText.id },
    retry,
  );

const textAuditRows = async (seeded: AssistantSeeded) => ({
  prefills: await fieldAuditRowsById(seeded.envelopeId, FIELD_PREFILLED, seeded.bText.secondaryId),
  inserts: await fieldAuditRowsById(seeded.envelopeId, FIELD_INSERTED, seeded.bText.secondaryId),
  uninserts: await fieldAuditRowsById(seeded.envelopeId, FIELD_UNINSERTED, seeded.bText.secondaryId),
});

/**
 * C19. The V1 sign route refuses an inserted field outright, so the insert
 * cases seed B's TEXT field optional and uninserted (B can still complete) and
 * the removal cases seed it required and inserted with B's value. The race is
 * judged as C18 is: once B is SIGNED, no assistant write may be recorded after
 * the completion row, and the field holds either its seeded state or, for an
 * insert serialised before the completion, the assistant's value.
 */
test("C19 the assistant on the V1 routes cannot write B's TEXT field after B completed", async ({ request }) => {
  test.setTimeout(30 * 60_000);

  // Control: with B not yet completed, the assistant inserts and removes through V1.
  const control = await seedAssistantEnvelope(request, { textInserted: false, internalVersion: 1 });
  expectOk(await assistantSignV1(request, control), "control: the assistant inserts B's TEXT field through V1");
  expect((await textFieldRow(control)).customText).toBe(ASSISTANT_TEXT_VALUE);
  expect((await textAuditRows(control)).prefills).toHaveLength(1);
  expectOk(await assistantRemoveV1(request, control), "control: the assistant removes B's TEXT value through V1");
  expect((await textFieldRow(control)).inserted).toBe(false);

  // Sequential: B completes first.
  const forInsert = await seedAssistantEnvelope(request, { textInserted: false, internalVersion: 1 });
  expectOk(await completeB(request, forInsert), 'B completes with its optional TEXT field empty');
  expectRefused(await assistantSignV1(request, forInsert), "the assistant's V1 insert after B completed");

  const insertAfter = await textFieldRow(forInsert);

  expect(insertAfter.inserted).toBe(false);
  expect(insertAfter.customText).toBe('');
  expect((await textAuditRows(forInsert)).prefills).toHaveLength(0);

  const forRemove = await seedAssistantEnvelope(request, { internalVersion: 1 });
  expectOk(await completeB(request, forRemove), 'B completes');
  expectRefused(await assistantRemoveV1(request, forRemove), "the assistant's V1 removal after B completed");

  const removeAfter = await textFieldRow(forRemove);

  expect(removeAfter.inserted).toBe(true);
  expect(removeAfter.customText).toBe(B_TEXT_VALUE);
  expect((await textAuditRows(forRemove)).uninserts).toHaveLength(0);

  for (const forSealCheck of [forInsert, forRemove]) {
    expect((await prisma.envelope.findUniqueOrThrow({ where: { id: forSealCheck.envelopeId } })).status).toBe(
      DocumentStatus.PENDING,
    );
  }

  // Fired together with B's complete.
  const race = (variant: 'insert' | 'remove') => async (): Promise<Outcome> => {
    const seeded = await seedAssistantEnvelope(request, { textInserted: variant === 'remove', internalVersion: 1 });

    const [writeReply, completeReply] = await Promise.all([
      variant === 'insert' ? assistantSignV1(request, seeded, false) : assistantRemoveV1(request, seeded, false),
      completeB(request, seeded, false),
    ]);

    const limited = rateLimited(seeded, { writeReply, completeReply });

    if (limited) {
      return limited;
    }

    const b = await recipientRow(seeded.b);
    const text = await textFieldRow(seeded);
    const completion = await auditRowsFor(seeded.envelopeId, RECIPIENT_COMPLETED, seeded.b);
    const { prefills, inserts, uninserts } = await textAuditRows(seeded);
    const isCompleted = b.signingStatus === SigningStatus.SIGNED;
    const assistantRows = [...prefills, ...inserts, ...uninserts];

    const record = {
      envelopeId: seeded.envelopeId,
      variant,
      writeReply: writeReply.status,
      completeReply: completeReply.status,
      bStatus: b.signingStatus,
      textInserted: text.inserted,
      textValue: text.customText,
      completionAt: completion.map((row) => row.createdAt.toISOString()),
      textAuditAt: assistantRows.map((row) => `${row.type} ${row.createdAt.toISOString()}`),
    };

    const problems: Array<string | null> = [];

    if (isCompleted) {
      const completedAt = time(completion[0]) ?? -Infinity;
      const isSeededState =
        variant === 'insert'
          ? !text.inserted && text.customText === ''
          : text.inserted && text.customText === B_TEXT_VALUE;
      const isEarlierInsert =
        variant === 'insert' && text.inserted && text.customText === ASSISTANT_TEXT_VALUE && prefills.length === 1;

      problems.push(completion.length === 1 ? null : `B is SIGNED with ${completion.length} completion row(s)`);
      problems.push(
        isSeededState || isEarlierInsert
          ? null
          : `B is SIGNED with its TEXT field inserted=${text.inserted} holding "${text.customText}"`,
      );
      problems.push(
        assistantRows.every((row) => (time(row) ?? Infinity) <= completedAt)
          ? null
          : "an assistant write on B's TEXT field was recorded after B's completion",
      );
      problems.push(
        variant === 'remove' && uninserts.length > 0 ? "B is SIGNED and B's TEXT field has an uninsert row" : null,
      );
    } else {
      problems.push(completion.length === 0 ? null : `B is ${b.signingStatus} with a completion row`);
    }

    const landed = variant === 'insert' ? text.inserted && text.customText === ASSISTANT_TEXT_VALUE : !text.inserted;

    return {
      verdict: verdictOf(
        ...problems,
        replyVerdict(writeReply, landed, `the assistant's V1 ${variant}`),
        replyVerdict(completeReply, isCompleted, "B's complete"),
      ),
      record,
    };
  };

  await runIterations('C19-insert', race('insert'));
  await runIterations('C19-remove', race('remove'));
});

const signV1With = async (request: APIRequestContext, signer: Signer, value: string, retry = true) =>
  await trpcRaw(
    request,
    'field.signFieldWithToken',
    { token: signer.token, fieldId: signer.fieldId, value, isBase64: false },
    retry,
  );

test("C20 B's V1 sign of one field fired twice lands once, and signing an inserted field answers 4xx", async ({
  request,
}) => {
  test.setTimeout(15 * 60_000);

  // Sequential: signing an already inserted field.
  const seeded = await seedEnvelope(request, { internalVersion: 1 });

  expectOk(await signV1With(request, seeded.b, 'First signature'), 'B signs');

  const before = await fieldRow(seeded.b);

  expectRefused(await signV1With(request, seeded.b, 'Second signature'), 'B signing its already inserted field');

  const after = await fieldRow(seeded.b);

  expect(after.inserted).toBe(true);
  expect(after.signature?.id).toBe(before.signature?.id);
  expect(after.signature?.typedSignature).toBe('First signature');
  expect(await fieldAuditRows(seeded.envelopeId, FIELD_INSERTED, seeded.b)).toHaveLength(1);

  // Fired twice at once.
  await runIterations('C20', async () => {
    const raced = await seedEnvelope(request, { internalVersion: 1 });
    const values = { first: 'Signature one', second: 'Signature two' };

    const [firstReply, secondReply] = await Promise.all([
      signV1With(request, raced.b, values.first, false),
      signV1With(request, raced.b, values.second, false),
    ]);

    const limited = rateLimited(raced, { firstReply, secondReply });

    if (limited) {
      return limited;
    }

    const field = await fieldRow(raced.b);
    const inserts = await fieldAuditRows(raced.envelopeId, FIELD_INSERTED, raced.b);
    const held = field.signature?.typedSignature ?? null;

    const record = {
      envelopeId: raced.envelopeId,
      firstReply: firstReply.status,
      secondReply: secondReply.status,
      fieldInserted: field.inserted,
      held,
      insertRows: inserts.length,
    };

    const successes = [firstReply, secondReply].filter(isSuccess).length;

    return {
      verdict: verdictOf(
        successes === 1 ? null : `${successes} of the two signs succeeded, expected exactly 1`,
        field.inserted ? null : "B's field is not inserted",
        inserts.length === 1 ? null : `${inserts.length} insert rows, expected 1`,
        replyVerdict(firstReply, held === values.first, 'the first sign'),
        replyVerdict(secondReply, held === values.second, 'the second sign'),
      ),
      record,
    };
  });
});

// ---------------------------------------------------------------------------
// The seal still works
// ---------------------------------------------------------------------------

test('C13 a rejection on the signing page seals the envelope REJECTED and mails each signer once', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  await assertMailCatcherReachable(request);

  const aBox = uniqueLocalPart('r78-a');
  const bBox = uniqueLocalPart('r78-b');
  const seeded = await seedEnvelope(request, { emails: { a: addressFor(aBox), b: addressFor(bBox) } });

  // The invitations, so later counts start from a known number.
  await waitForMail(request, aBox, 1);
  await waitForMail(request, bBox, 1);

  await page.goto(`${WEBAPP_BASE_URL}/sign/${seeded.a.token}`);

  const trigger = page.getByRole('button', { name: 'Reject Document' }).first();

  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const dialog = page.getByRole('dialog');

  await dialog.getByPlaceholder('Please provide a reason for rejecting this document').fill('The terms are wrong');
  await dialog.getByRole('button', { name: 'Reject Document' }).click();
  await page.waitForURL(`**/sign/${seeded.a.token}/rejected`, { timeout: 30_000 });

  await waitForStatus(seeded.envelopeId, DocumentStatus.REJECTED);

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

  expect(envelope.completedAt).not.toBeNull();

  const completed = await auditRows(seeded.envelopeId, DOCUMENT_COMPLETED);

  expect(completed).toHaveLength(1);
  expect((completed[0].data as { isRejected?: boolean }).isRejected).toBe(true);

  const isRejectionConfirmed = (subject: string) =>
    subject.includes(seeded.title) && subject.includes('Rejection Confirmed');
  // The English catalogue renders the template's "Cancelled" as "Canceled"; accept either.
  const isCancelled = (subject: string) => subject.includes(seeded.title) && /Cancell?ed/.test(subject);

  await waitForMail(request, aBox, 2);
  await waitForMail(request, bBox, 2);

  // Hold, so a duplicate sent late would be seen.
  await new Promise((resolve) => setTimeout(resolve, NO_MAIL_WINDOW_MS));

  const aMail = (await readMailbox(request, aBox)).map((message) => message.subject);
  const bMail = (await readMailbox(request, bBox)).map((message) => message.subject);

  await test.info().attach('mailboxes.json', {
    body: JSON.stringify({ a: aMail, b: bMail }, null, 2),
    contentType: 'application/json',
  });

  expect(aMail.filter(isRejectionConfirmed), 'the rejecter gets the rejection email once').toHaveLength(1);
  expect(bMail.filter(isCancelled), 'B gets the cancellation email once').toHaveLength(1);
  expect(aMail, 'A: the invitation and the rejection email, nothing else').toHaveLength(2);
  expect(bMail, 'B: the invitation and the cancellation email, nothing else').toHaveLength(2);
});

for (const version of [1, 2] as const) {
  test(`C14 without a rejection, A and B both sign and complete and the envelope seals COMPLETED (V${version} envelope, V${version} route)`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const seeded = await seedEnvelope(request, { internalVersion: version });
    const sign = ROUTES[version].sign;

    // Both sign through the route of the envelope's version, the same calls the refusals above use. Before #142 one
    // V2 envelope carried A on the V1 route and B on the V2 route; the V1 routes now refuse V2 envelopes.
    expectOk(await sign(request, seeded.a), `A signs through the V${version} route`);
    expectOk(await complete(request, seeded, seeded.a), 'A completes');
    expectOk(await sign(request, seeded.b), `B signs through the V${version} route`);
    expectOk(await complete(request, seeded, seeded.b), 'B completes');

    await waitForStatus(seeded.envelopeId, DocumentStatus.COMPLETED);

    expect((await recipientRow(seeded.a)).signingStatus).toBe(SigningStatus.SIGNED);
    expect((await recipientRow(seeded.b)).signingStatus).toBe(SigningStatus.SIGNED);

    const completed = await auditRows(seeded.envelopeId, DOCUMENT_COMPLETED);

    expect(completed).toHaveLength(1);
    expect((completed[0].data as { isRejected?: boolean }).isRejected).toBeUndefined();
    expect(await auditRows(seeded.envelopeId, REJECTED)).toHaveLength(0);
  });
}
