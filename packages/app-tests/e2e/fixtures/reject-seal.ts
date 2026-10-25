/**
 * Shared helpers for the G1 specs: the frozen
 * rejecter, the silent cancelled envelope, the next signer who is never a
 * rejecter, and one V2 insert per field.
 *
 * The request, retry and iteration helpers follow an earlier spec
 * (document-flow/reject-blocks-other-recipients.spec.ts) so the two read alike.
 * Every request goes to the running server through the route a recipient, the
 * owner or an administrator uses; every assertion reads the database, the
 * webhook receiver or the mail catcher.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { sign as signJobRequest } from '@documenso/lib/server-only/crypto/sign';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, type APIResponse, expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus, WebhookTriggerEvents } from '@prisma/client';

import { apiSeedPendingDocument } from './api-seeds';
import { apiSignin } from './authentication';

export const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
export const API_V2 = `${WEBAPP_BASE_URL}/api/v2-beta`;
export const API_V1 = `${WEBAPP_BASE_URL}/api/v1`;

export const ITERATIONS = 10;

export const JOB = {
  SEAL: 'internal.seal-document',
  COMPLETED_EMAILS: 'send.document.completed.emails',
  CANCELLED_EMAILS: 'send.document.cancelled.emails',
  SIGNING_EMAIL: 'send.signing.requested.email',
  REMOVED_EMAIL: 'send.recipient.removed.email',
  ARCHIVE: 'internal.archive-envelope',
} as const;

export const AUDIT = {
  REJECTED: 'DOCUMENT_RECIPIENT_REJECTED',
  RECIPIENT_COMPLETED: 'DOCUMENT_RECIPIENT_COMPLETED',
  DOCUMENT_COMPLETED: 'DOCUMENT_COMPLETED',
  DOCUMENT_CANCELLED: 'DOCUMENT_CANCELLED',
  RECIPIENT_UPDATED: 'RECIPIENT_UPDATED',
  RECIPIENT_DELETED: 'RECIPIENT_DELETED',
  FIELD_INSERTED: 'DOCUMENT_FIELD_INSERTED',
  FIELD_UNINSERTED: 'DOCUMENT_FIELD_UNINSERTED',
  FIELD_PREFILLED: 'DOCUMENT_FIELD_PREFILLED',
  EMAIL_SENT: 'EMAIL_SENT',
} as const;

export const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/** How long a "nothing else happens" assertion waits for a late job, webhook or email. */
export const QUIET_WINDOW_MS = 6_000;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type Reply = { status: number; body: string; retryAfterMs: number | null };

export const RATE_LIMITED = 429;
const MAX_RATE_LIMIT_RETRIES = 10;
const DEFAULT_RATE_LIMIT_WAIT_MS = 3_000;

const toReply = async (res: APIResponse): Promise<Reply> => {
  const retryAfterSeconds = Number(res.headers()['retry-after']);
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds * 1000, 30_000) : null;

  return { status: res.status(), body: await res.text(), retryAfterMs };
};

export const rateLimitWaitMs = (reply: Reply) => reply.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;

/** Sends a request; with `retry`, a 429 is resent after the advertised wait. Race calls pass `retry: false`. */
export const send = async (post: () => Promise<APIResponse>, what: string, retry: boolean) => {
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

/** A tRPC mutation; `teamId` adds the x-team-id header a session call needs. */
export const trpcRaw = async (
  request: APIRequestContext,
  procedure: string,
  input: Record<string, unknown>,
  options: { retry?: boolean; teamId?: number } = {},
) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (options.teamId !== undefined) {
    headers['x-team-id'] = String(options.teamId);
  }

  return await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
        headers,
        data: JSON.stringify({ json: input }),
      }),
    procedure,
    options.retry ?? true,
  );
};

/** An API v2 POST with the owner's bearer token. */
export const v2Post = async (
  request: APIRequestContext,
  apiToken: string,
  path: string,
  data: Record<string, unknown>,
  retry = true,
) =>
  await send(
    async () =>
      await request.post(`${API_V2}${path}`, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        data,
      }),
    `API v2 ${path}`,
    retry,
  );

export const isSuccess = (reply: Reply) => reply.status >= 200 && reply.status < 300;

export const isClientError = (reply: Reply) => reply.status >= 400 && reply.status < 500;

export const expectOk = (reply: Reply, what: string) => {
  expect(reply.status, `${what}: ${reply.body.slice(0, 400)}`).toBeGreaterThanOrEqual(200);
  expect(reply.status, `${what}: ${reply.body.slice(0, 400)}`).toBeLessThan(300);
};

export const expectRefused = (reply: Reply, what: string) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is not a refusal: ${reply.body}`).not.toBe(RATE_LIMITED);
  expect(reply.status, `${what} should be refused with a 4xx: ${reply.body.slice(0, 400)}`).toBeGreaterThanOrEqual(400);
  expect(reply.status, `${what} should be refused with a 4xx: ${reply.body.slice(0, 400)}`).toBeLessThan(500);
};

// ---------------------------------------------------------------------------
// Webhook receiver
// ---------------------------------------------------------------------------

type Delivery = { envelopeId: string | undefined; event: string };

/**
 * A local HTTP server standing in for the team's integration endpoint.
 * Deliveries are counted per envelope, read from the payload's envelopeId.
 * Needs NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS=127.0.0.1 on the server.
 */
export const startReceiver = async () => {
  const deliveries: Delivery[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          event: string;
          payload?: { envelopeId?: string };
        };

        deliveries.push({ envelopeId: body.payload?.envelopeId, event: body.event });
      } catch {
        // A body that is not JSON is not a delivery the tests look for.
      }

      res.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    count: (envelopeId: string, event: string) =>
      deliveries.filter((delivery) => delivery.envelopeId === envelopeId && delivery.event === event).length,
    eventsFor: (envelopeId: string) =>
      deliveries.filter((delivery) => delivery.envelopeId === envelopeId).map((delivery) => delivery.event),
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export type Receiver = Awaited<ReturnType<typeof startReceiver>>;

export const registerWebhook = async (receiver: Receiver, userId: number, teamId: number) =>
  await prisma.webhook.create({
    data: {
      webhookUrl: receiver.url,
      eventTriggers: [
        WebhookTriggerEvents.DOCUMENT_COMPLETED,
        WebhookTriggerEvents.DOCUMENT_REJECTED,
        WebhookTriggerEvents.DOCUMENT_CANCELLED,
      ],
      secret: 'g1-e2e',
      enabled: true,
      userId,
      teamId,
    },
  });

/** An owner: a user, their team and an API token, with the team's webhook on `receiver` when given. */
export type Owner = Awaited<ReturnType<typeof createOwner>>;

export const createOwner = async (receiver?: Receiver) => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'g1', expiresIn: null });

  if (receiver) {
    await registerWebhook(receiver, user.id, team.id);
  }

  return { user, team, token };
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** fieldSecondaryId is what audit rows record as `data.fieldId`. */
export type Signer = {
  id: number;
  token: string;
  email: string;
  name: string;
  fieldId: number;
  fieldSecondaryId: string;
};

export type ExtraField = { id: number; secondaryId: string; type: FieldType };

export type Seeded = {
  envelopeId: string;
  documentId: number;
  title: string;
  apiToken: string;
  userId: number;
  userEmail: string;
  teamId: number;
  teamUrl: string;
  itemIds: string[];
  a: Signer;
  b: Signer;
  /** A CC recipient, when seeded with `cc`. */
  cc?: { id: number; email: string; name: string };
  /** B's extra fields, when seeded with `bFields`. */
  bExtra: ExtraField[];
};

export type SeedOptions = {
  /** SEQUENTIAL puts B first (order 1) and A second (order 2). */
  signingOrder?: 'PARALLEL' | 'SEQUENTIAL';
  allowDictateNextSigner?: boolean;
  emails?: { a?: string; b?: string };
  cc?: boolean;
  /** Extra fields for B, beyond its SIGNATURE field. */
  bFields?: Array<{ type: FieldType; fieldMeta?: Record<string, unknown>; box?: Box }>;
  /** The owner to seed under; a fresh one by default, with its webhook on `receiver` when given. */
  owner?: Owner;
  receiver?: Receiver;
};

type Box = { positionX: number; positionY: number; width: number; height: number };

const BOX_A = { positionX: 10, positionY: 60, width: 30, height: 8 };
const BOX_B = { positionX: 10, positionY: 84, width: 30, height: 8 };

/**
 * A PENDING V2 envelope with signers A and B (and a CC when asked), each signer
 * holding one SIGNATURE field, invitations sent through API v2. signedAt is set
 * outside the seal sweep's window so the sweep never picks the envelope up.
 */
export const seedEnvelope = async (request: APIRequestContext, options: SeedOptions = {}): Promise<Seeded> => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `G1 ${stamp}`;
  const isSequential = options.signingOrder === 'SEQUENTIAL';

  const people = [
    { key: 'a', email: options.emails?.a ?? `g1-a-${stamp}@test.documenso.com`, name: 'Signer A' },
    { key: 'b', email: options.emails?.b ?? `g1-b-${stamp}@test.documenso.com`, name: 'Signer B' },
  ];

  const recipients = [
    {
      email: people[0].email,
      name: people[0].name,
      role: 'SIGNER' as const,
      ...(isSequential ? { signingOrder: 2 } : {}),
    },
    {
      email: people[1].email,
      name: people[1].name,
      role: 'SIGNER' as const,
      ...(isSequential ? { signingOrder: 1 } : {}),
    },
    ...(options.cc
      ? [
          {
            email: `g1-cc-${stamp}@test.documenso.com`,
            name: 'Copy C',
            role: 'CC' as const,
            ...(isSequential ? { signingOrder: 3 } : {}),
          },
        ]
      : []),
  ];

  const { user, team, token } = options.owner ?? (await createOwner(options.receiver));

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    context: { user, team, token },
    title,
    meta: {
      signingOrder: isSequential ? 'SEQUENTIAL' : 'PARALLEL',
      ...(options.allowDictateNextSigner !== undefined
        ? { allowDictateNextSigner: options.allowDictateNextSigner }
        : {}),
    },
    recipients,
    fieldsPerRecipient: [
      [{ type: FieldType.SIGNATURE, page: 1, ...BOX_A }],
      [
        { type: FieldType.SIGNATURE, page: 1, ...BOX_B },
        ...(options.bFields ?? []).map((field, index) => ({
          type: field.type,
          page: 1,
          ...(field.box ?? { positionX: 50, positionY: 10 + index * 12, width: 30, height: 10 }),
          ...(field.fieldMeta ? { fieldMeta: field.fieldMeta } : {}),
        })),
      ],
      ...(options.cc ? [[]] : []),
    ],
  });

  const fields = await prisma.field.findMany({ where: { envelopeId: envelope.id } });
  const rows = await prisma.recipient.findMany({ where: { envelopeId: envelope.id } });

  const signerFor = (email: string): Signer => {
    const recipient = rows.find((row) => row.email === email);
    const sent = distributeResult.recipients.find((candidate) => candidate.email === email);

    if (!recipient || !sent) {
      throw new Error(`Recipient ${email} missing from the envelope`);
    }

    const field = fields.find((row) => row.recipientId === recipient.id && row.type === FieldType.SIGNATURE);

    if (!field) {
      throw new Error(`No SIGNATURE field for ${email}`);
    }

    return {
      id: recipient.id,
      token: recipient.token,
      email,
      name: recipient.name,
      fieldId: field.id,
      fieldSecondaryId: field.secondaryId,
    };
  };

  const a = signerFor(people[0].email);
  const b = signerFor(people[1].email);
  const ccRow = rows.find((row) => row.role === 'CC');

  // Keep the seal sweep away: see outsideSweepWindow.
  await prisma.recipient.updateMany({ where: { envelopeId: envelope.id }, data: { signedAt: outsideSweepWindow() } });

  const items = await prisma.envelopeItem.findMany({ where: { envelopeId: envelope.id }, orderBy: { order: 'asc' } });

  return {
    envelopeId: envelope.id,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    title,
    apiToken: token,
    userId: user.id,
    userEmail: user.email,
    teamId: team.id,
    teamUrl: team.url,
    itemIds: items.map((item) => item.id),
    a,
    b,
    cc: ccRow ? { id: ccRow.id, email: ccRow.email, name: ccRow.name } : undefined,
    bExtra: fields
      .filter((row) => row.recipientId === b.id && row.id !== b.fieldId)
      .map((row) => ({ id: row.id, secondaryId: row.secondaryId, type: row.type })),
  };
};

export const REJECTION_REASON = 'A rejected before the seal';

/**
 * signedAt for seeded recipients: seven hours back, outside the seal sweep's six-hour window, so a
 * rejected or fully signed envelope a test leaves unsealed is never resealed and mailed later (#177).
 */
export const outsideSweepWindow = () => new Date(Date.now() - 7 * 60 * 60 * 1000);

/** "Rejected but not yet sealed": A REJECTED with a reason and an audit row, envelope PENDING, no seal job. */
export const seedRejectedNotSealed = async (seeded: Seeded, reason = REJECTION_REASON) => {
  await prisma.recipient.update({
    where: { id: seeded.a.id },
    data: { signingStatus: SigningStatus.REJECTED, rejectionReason: reason, signedAt: outsideSweepWindow() },
  });

  await prisma.documentAuditLog.create({
    data: {
      envelopeId: seeded.envelopeId,
      type: AUDIT.REJECTED,
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
  expect(await jobsFor(JOB.SEAL, 'documentId', seeded.documentId), 'the seed queues no seal job').toHaveLength(0);
};

/** "Signed but not yet sealed": A and B SIGNED, their SIGNATURE fields inserted with a typed signature, envelope PENDING. */
export const seedSignedNotSealed = async (seeded: Seeded) => {
  for (const signer of [seeded.a, seeded.b]) {
    await prisma.field.update({ where: { id: signer.fieldId }, data: { inserted: true, customText: '' } });
    await prisma.signature.create({
      data: { fieldId: signer.fieldId, recipientId: signer.id, typedSignature: signer.name },
    });
    await prisma.recipient.update({
      where: { id: signer.id },
      data: { signingStatus: SigningStatus.SIGNED, signedAt: outsideSweepWindow() },
    });
  }

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

  expect(envelope.status, 'the signed-but-unsealed seed leaves the envelope PENDING').toBe(DocumentStatus.PENDING);
  expect(await jobsFor(JOB.SEAL, 'documentId', seeded.documentId), 'the seed queues no seal job').toHaveLength(0);
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Signs `email` in on the page's request context without loading a page, so
 * the sign-in spends none of the tRPC rate limit. Returns that context.
 */
export const sessionFor = async (page: Page, email: string) => {
  const { request } = page.context();
  const csrf = await request.get(`${WEBAPP_BASE_URL}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken?: string };

  expect(csrfToken, 'a CSRF token for sign-in').toBeTruthy();

  const res = await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/authorize`, {
    data: { email, password: 'password', csrfToken },
  });

  expect(res.ok(), `sign-in as ${email}: ${res.status()} ${await res.text()}`).toBe(true);

  return request;
};

export const adminSession = async (page: Page) => {
  const { user: admin } = await seedUser({ isAdmin: true });

  return await sessionFor(page, admin.email);
};

/** Opens a page with the owner signed in, for the browser assertions. */
export const ownerBrowserSignin = async (page: Page, seeded: Seeded, redirectPath: string) => {
  await apiSignin({ page, email: seeded.userEmail, redirectPath });
};

// ---------------------------------------------------------------------------
// Recipient actions
// ---------------------------------------------------------------------------

export const signV2 = async (request: APIRequestContext, signer: Signer, value?: string, retry = true) =>
  await trpcRaw(
    request,
    'envelope.field.sign',
    {
      token: signer.token,
      fieldId: signer.fieldId,
      fieldValue: { type: FieldType.SIGNATURE, value: value ?? signer.name },
    },
    { retry },
  );

export const signFieldV2 = async (
  request: APIRequestContext,
  token: string,
  fieldId: number,
  fieldValue: Record<string, unknown>,
  retry = true,
) => await trpcRaw(request, 'envelope.field.sign', { token, fieldId, fieldValue }, { retry });

export const complete = async (
  request: APIRequestContext,
  seeded: Seeded,
  signer: Signer,
  options: { nextSigner?: { email: string; name: string }; retry?: boolean } = {},
) =>
  await trpcRaw(
    request,
    'recipient.completeDocumentWithToken',
    {
      token: signer.token,
      documentId: seeded.documentId,
      ...(options.nextSigner ? { nextSigner: options.nextSigner } : {}),
    },
    { retry: options.retry ?? true },
  );

export const reject = async (
  request: APIRequestContext,
  seeded: Seeded,
  signer: Signer,
  reason: string,
  retry = true,
) =>
  await trpcRaw(
    request,
    'recipient.rejectDocumentWithToken',
    { token: signer.token, documentId: seeded.documentId, reason },
    { retry },
  );

export const rejectOnBehalf = async (
  request: APIRequestContext,
  seeded: Seeded,
  recipientId: number,
  reason: string,
  retry = true,
) =>
  await send(
    async () =>
      await request.post(`${API_V2}/envelope/recipient/${recipientId}/reject`, {
        headers: { Authorization: `Bearer ${seeded.apiToken}`, 'Content-Type': 'application/json' },
        data: { envelopeId: seeded.envelopeId, recipientId, reason },
      }),
    'API v2 reject on behalf',
    retry,
  );

export const cancelEnvelope = async (request: APIRequestContext, seeded: Seeded, retry = true) =>
  await v2Post(
    request,
    seeded.apiToken,
    '/envelope/cancel',
    { envelopeId: seeded.envelopeId, reason: 'G1 cancel' },
    retry,
  );

// ---------------------------------------------------------------------------
// Running jobs through the server's own endpoint
// ---------------------------------------------------------------------------

/**
 * Delivers a job to the server as its queue does: a pending BackgroundJob row,
 * then a signed POST to the job endpoint. The local provider runs the job
 * before it answers.
 */
/** Creates the BackgroundJob row the job endpoint runs, without delivering it. */
export const createJobRow = async (jobId: string, name: string, payload: Record<string, unknown>) =>
  await prisma.backgroundJob.create({ data: { jobId, name, version: '1.0.0', payload } });

/** Delivers an existing BackgroundJob row to the server's job endpoint and waits for its answer. */
export const deliverJob = async (jobId: string, jobRowId: string, payload: Record<string, unknown>) => {
  const options = { name: jobId, payload };

  const res = await fetch(`${WEBAPP_BASE_URL}/api/jobs/${jobId}/${jobRowId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-job-id': jobRowId,
      'x-job-signature': signJobRequest(options),
    },
    body: JSON.stringify(options),
  });

  return { jobRowId, status: res.status, body: await res.text() };
};

export const runJob = async (jobId: string, name: string, payload: Record<string, unknown>) =>
  await deliverJob(jobId, (await createJobRow(jobId, name, payload)).id, payload);

export const runSealJob = async (seeded: Seeded, payload: { isResealing?: boolean } = {}) =>
  await runJob(JOB.SEAL, 'Seal Document', { documentId: seeded.documentId, ...payload });

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

export const recipientRow = async (id: number) => await prisma.recipient.findUnique({ where: { id } });

export const envelopeRow = async (seeded: Seeded) =>
  await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

export const fieldRow = async (fieldId: number) =>
  await prisma.field.findUnique({ where: { id: fieldId }, include: { signature: true } });

export const auditRows = async (envelopeId: string, type: string) =>
  await prisma.documentAuditLog.findMany({ where: { envelopeId, type }, orderBy: { createdAt: 'asc' } });

export const dataOf = (row: { data: unknown }) => (row.data ?? {}) as Record<string, unknown>;

export const auditRowsForRecipient = async (envelopeId: string, type: string, recipientId: number) =>
  (await auditRows(envelopeId, type)).filter((row) => dataOf(row).recipientId === recipientId);

export const fieldAuditRows = async (envelopeId: string, type: string, secondaryId: string) =>
  (await auditRows(envelopeId, type)).filter((row) => dataOf(row).fieldId === secondaryId);

export const emailRows = async (envelopeId: string, emailType: string, recipientId?: number) =>
  (await auditRows(envelopeId, AUDIT.EMAIL_SENT)).filter(
    (row) =>
      dataOf(row).emailType === emailType && (recipientId === undefined || dataOf(row).recipientId === recipientId),
  );

export const jobsFor = async (jobId: string, key: string, value: string | number) =>
  await prisma.backgroundJob.findMany({
    where: { jobId, payload: { path: [key], equals: value } },
    orderBy: { submittedAt: 'asc' },
  });

export const itemDataIds = async (seeded: Seeded) =>
  (await prisma.envelopeItem.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { order: 'asc' } })).map(
    (item) => item.documentDataId,
  );

/** DocumentData rows of this owner (or with no owner) written since `since` that no envelope item references. */
export const unreferencedDataSince = async (seeded: Seeded, since: Date) =>
  (
    await prisma.documentData.findMany({
      where: {
        envelopeItem: null,
        createdAt: { gte: since },
        OR: [{ userId: seeded.userId }, { teamId: seeded.teamId }, { userId: null, teamId: null }],
      },
      select: { id: true },
    })
  )
    .map((row) => row.id)
    .sort();

/** Every DocumentData row of this owner (or with no owner) written since `since`, referenced or not. */
export const dataRowsSince = async (seeded: Seeded, since: Date) =>
  (
    await prisma.documentData.findMany({
      where: {
        createdAt: { gte: since },
        OR: [{ userId: seeded.userId }, { teamId: seeded.teamId }, { userId: null, teamId: null }],
      },
      select: { id: true },
    })
  )
    .map((row) => row.id)
    .sort();

/** Waits until no seal job of the envelope is pending or running. */
export const waitForSealJobsIdle = async (seeded: Seeded) => {
  await expect
    .poll(
      async () =>
        (await jobsFor(JOB.SEAL, 'documentId', seeded.documentId)).every(
          (job) => job.status === 'COMPLETED' || job.status === 'FAILED',
        ),
      { message: `seal jobs of ${seeded.envelopeId} should finish`, timeout: 90_000 },
    )
    .toBe(true);
};

export const waitForStatus = async (seeded: Seeded, status: DocumentStatus, timeout = 60_000) => {
  await expect
    .poll(async () => (await envelopeRow(seeded)).status, {
      message: `envelope ${seeded.envelopeId} should reach ${status}`,
      timeout,
    })
    .toBe(status);
};

export const time = (row: { createdAt: Date } | undefined) => row?.createdAt.getTime();

/**
 * Keeps a JSON record with the run: written into the test's output directory,
 * which the run keeps as evidence, and attached to the report.
 */
export const keepRecord = async (name: string, body: unknown) => {
  const text = JSON.stringify(body, null, 2);

  fs.writeFileSync(test.info().outputPath(name), text);
  await test.info().attach(name, { body: text, contentType: 'application/json' });
};

// ---------------------------------------------------------------------------
// Iterations
// ---------------------------------------------------------------------------

/** Null when the reply agrees with the database: 2xx if its effect `landed`, 4xx if not. A 5xx always fails. */
export const replyVerdict = (reply: Reply, landed: boolean, what: string): string | null => {
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

export const verdictOf = (...problems: Array<string | null>) => {
  const found = problems.filter((problem): problem is string => problem !== null);

  return found.length > 0 ? found.join('; ') : null;
};

export type Outcome = { verdict: string | null; record: Record<string, unknown>; rateLimitedWaitMs?: number };

/** The outcome of a race in which either request was rate-limited, or null if neither was. */
export const rateLimited = (seeded: { envelopeId: string }, replies: Record<string, Reply>): Outcome | null => {
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
 * recorded, waited out and rerun on a fresh seed.
 */
export const runIterations = async (name: string, iterate: () => Promise<Outcome>, iterations = ITERATIONS) => {
  const failures: string[] = [];
  let valid = 0;
  let attempt = 0;
  let rateLimitedAttempts = 0;

  while (valid < iterations) {
    attempt++;

    const { verdict, record: record_, rateLimitedWaitMs } = await iterate();
    const isRateLimited = rateLimitedWaitMs !== undefined;

    await keepRecord(`${name}-attempt-${attempt}.json`, {
      attempt,
      iteration: isRateLimited ? null : valid + 1,
      verdict: verdict ?? 'ok',
      ...record_,
    });

    if (isRateLimited) {
      rateLimitedAttempts++;

      if (rateLimitedAttempts > MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `${name}: ${rateLimitedAttempts} attempts were rate-limited with ${valid} valid iterations run`,
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
