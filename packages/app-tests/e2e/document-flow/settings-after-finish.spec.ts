/**
 * #182: the settings of a finished envelope cannot be edited.
 *
 * Written from campaign-2026-10-17/F182/spec.md before the fix, without
 * reading the writers (W1 updateEnvelope, W2 updateDocumentMeta). Envelopes are
 * seeded through Prisma (fixtures/signature-ink.ts); every request under test
 * goes to the running server through the route an owner or a recipient uses;
 * every assertion reads the database or the audit-log PDF the server renders.
 *
 * Finished: status COMPLETED, REJECTED or CANCELLED, or PENDING with a
 * recipient whose signingStatus is REJECTED.
 *
 * | Criterion | Tests                                                                          |
 * | --------- | ------------------------------------------------------------------------------ |
 * | C1        | W1 (API v2 /envelope/update, tRPC envelope.update) on each finished kind;      |
 * |           | timezone, globalAccessAuth, globalActionAuth, a mixed folder and meta request; |
 * |           | tRPC document.update with meta and with useLegacyFieldInsertion                |
 * | C2        | W2 (tRPC envelope.distribute) on each finished kind; API v2 /envelope/distribute,|
 * |           | tRPC document.distribute and API v1 send on a COMPLETED envelope               |
 * | C3        | folderId, visibility, externalId on finished envelopes still succeed           |
 * | C4        | meta equal to the stored values succeeds and changes nothing                   |
 * | C5        | DRAFT and PENDING: W1 and W2 edits are stored                                  |
 * | C6        | the edit races the seal (status to COMPLETED) and a recipient rejection;      |
 * |           | the decision is taken under the envelope lock                                  |
 * | C7        | the audit-log PDF header of a COMPLETED envelope survives a refused edit       |
 *
 * The final-sign race (C6) is run against the seal job rather than against
 * recipient.completeDocumentWithToken: the last completion leaves the envelope
 * PENDING and queues the seal, and the seal is what writes COMPLETED. An edit
 * that lands between the last completion and the seal is on an unfinished
 * envelope by the spec's definition, so racing the completion would not test
 * the criterion. The test delivers the seal job itself, as fixtures/reject-seal.ts
 * does, on an envelope whose signers are already SIGNED.
 *
 * W1 writes no DOCUMENT_META_UPDATED audit row for a meta edit today, so C5 and
 * C6 record that count for W1 rather than asserting it. W2 writes one, and C5
 * asserts it for envelope.distribute on a DRAFT.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, DocumentVisibility, FieldType, FolderType, SigningStatus } from '@prisma/client';

import { rawPdfText } from '../fixtures/audit-pages';
import { type Tx, waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  API_V2,
  JOB,
  keepRecord,
  type Outcome,
  pause,
  type Reply,
  rateLimited,
  runIterations,
  runJob,
} from '../fixtures/reject-seal';
import {
  errorOf,
  type G4Seeded,
  type RecipientSpec,
  rejectWithToken,
  seedG4Envelope,
  seedInserted,
  seedSessionCookie,
  seedSigned,
  trpcAsUser,
  v1Api,
  v2Api,
} from '../fixtures/signature-ink';
import { waitForEnvelopeStatus } from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

const RACE_ITERATIONS = 6;
const RACE_TIMEOUT = 10 * 60_000;

/** Per-round delays before the edit is sent, so some rounds see the finish first. */
const RACE_DELAYS_MS = [0, 50, 250, 1000, 2500, 5000];

const META_UPDATED = 'DOCUMENT_META_UPDATED';

// ---------------------------------------------------------------------------
// Replies, redacted: recipient tokens and signing URLs never reach a message or a record
// ---------------------------------------------------------------------------

const redact = (text: string) =>
  text
    .replace(/"(token|signingUrl|apiToken)"\s*:\s*"[^"]*"/g, '"$1":"[redacted]"')
    .replace(/\/sign\/[A-Za-z0-9_-]+/g, '/sign/[redacted]');

const shown = (reply: Reply) => `${reply.status} ${redact(reply.body).slice(0, 300)}`;

const brief = (reply: Reply) => ({
  status: reply.status,
  code: errorOf(reply).code,
  body: redact(reply.body).slice(0, 200),
});

const isOk = (reply: Reply) => reply.status >= 200 && reply.status < 300;

const is4xx = (reply: Reply) => reply.status >= 400 && reply.status < 500;

// ---------------------------------------------------------------------------
// Finished kinds and their seeds
// ---------------------------------------------------------------------------

type Kind = 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'PENDING_REJECTED';

const KINDS: Kind[] = ['COMPLETED', 'REJECTED', 'CANCELLED', 'PENDING_REJECTED'];

const CODE: Record<Kind, string> = {
  COMPLETED: 'ENVELOPE_COMPLETED',
  REJECTED: 'ENVELOPE_REJECTED',
  CANCELLED: 'ENVELOPE_CANCELLED',
  PENDING_REJECTED: 'ENVELOPE_REJECTED',
};

const LABEL: Record<Kind, string> = {
  COMPLETED: 'a COMPLETED envelope',
  REJECTED: 'a REJECTED envelope',
  CANCELLED: 'a CANCELLED envelope',
  PENDING_REJECTED: 'a PENDING envelope with a rejected recipient',
};

const sig = (inserted = false) => [{ key: 'sig', type: FieldType.SIGNATURE, inserted }];

/** Signers s1 (order 1) and s2 (order 2), each with one SIGNATURE field. */
const seedPair = async (status: DocumentStatus, s1: SigningStatus, s2: SigningStatus) =>
  await seedG4Envelope({
    internalVersion: 2,
    status,
    recipients: [
      { key: 's1', signingOrder: 1, signingStatus: s1, fields: sig(s1 === SigningStatus.SIGNED) },
      { key: 's2', signingOrder: 2, signingStatus: s2, fields: sig(s2 === SigningStatus.SIGNED) },
    ] satisfies RecipientSpec[],
  });

const markRejected = async (seeded: G4Seeded, key: string) =>
  await prisma.recipient.update({
    where: { id: seeded.r[key].id },
    data: { signingStatus: SigningStatus.REJECTED, rejectionReason: 'no' },
  });

const seedFinished = async (kind: Kind) => {
  const { SIGNED, NOT_SIGNED, REJECTED } = SigningStatus;

  if (kind === 'COMPLETED') {
    return await seedPair(DocumentStatus.COMPLETED, SIGNED, SIGNED);
  }

  if (kind === 'CANCELLED') {
    return await seedPair(DocumentStatus.CANCELLED, NOT_SIGNED, NOT_SIGNED);
  }

  const seeded = await seedPair(
    kind === 'REJECTED' ? DocumentStatus.REJECTED : DocumentStatus.PENDING,
    REJECTED,
    NOT_SIGNED,
  );

  await markRejected(seeded, 's1');

  return seeded;
};

/** PENDING, both signers SIGNED with their fields inserted, no seal yet: the envelope is not finished. */
const seedSignedNotSealed = async () => {
  const seeded = await seedPair(DocumentStatus.PENDING, SigningStatus.NOT_SIGNED, SigningStatus.NOT_SIGNED);

  for (const key of ['s1', 's2']) {
    await seedInserted(seeded, key, 'sig', { typed: `S ${key}` });
    await seedSigned(seeded, key);
  }

  return seeded;
};

const ownerAuth = async (seeded: G4Seeded) => ({
  cookie: await seedSessionCookie(seeded.owner.user.id),
  teamId: seeded.owner.team.id,
});

type Auth = Awaited<ReturnType<typeof ownerAuth>>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const metaOf = async (seeded: G4Seeded) =>
  await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } });

const envelopeOf = async (seeded: G4Seeded) =>
  await prisma.envelope.findUniqueOrThrow({
    where: { id: seeded.envelopeId },
    select: {
      status: true,
      authOptions: true,
      useLegacyFieldInsertion: true,
      updatedAt: true,
      folderId: true,
      visibility: true,
      externalId: true,
    },
  });

const auditCount = async (seeded: G4Seeded, type?: string) =>
  await prisma.documentAuditLog.count({ where: { envelopeId: seeded.envelopeId, ...(type ? { type } : {}) } });

/** Everything a refused edit must leave alone. */
const snapshot = async (seeded: G4Seeded) => ({
  meta: await metaOf(seeded),
  envelope: await envelopeOf(seeded),
  audits: await auditCount(seeded),
});

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

const isFinished = async (seeded: G4Seeded) => {
  const envelope = await envelopeOf(seeded);
  const rejected = await prisma.recipient.count({
    where: { envelopeId: seeded.envelopeId, signingStatus: SigningStatus.REJECTED },
  });

  return (
    envelope.status === DocumentStatus.COMPLETED ||
    envelope.status === DocumentStatus.REJECTED ||
    envelope.status === DocumentStatus.CANCELLED ||
    rejected > 0
  );
};

/** 400 with `code`, and nothing written. */
const expectRefused = async (reply: Reply, code: string, seeded: G4Seeded, before: Snapshot, what: string) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is a test defect, not a result`).not.toBe(429);
  expect(reply.status, `${what}: expected 400 ${code}, got ${shown(reply)}`).toBe(400);
  expect(errorOf(reply).code, `${what}: expected data.code ${code}, got ${shown(reply)}`).toBe(code);
  expect(await snapshot(seeded), `${what}: nothing is written`).toEqual(before);
};

/** Any 4xx, and nothing written. For requests a route may refuse for another reason first. */
const expectRefusedAny = async (reply: Reply, seeded: G4Seeded, before: Snapshot, what: string) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is a test defect, not a result`).not.toBe(429);
  expect(is4xx(reply), `${what}: expected a 4xx, got ${shown(reply)}`).toBe(true);
  expect(await snapshot(seeded), `${what}: nothing is written`).toEqual(before);
};

const expectAccepted = (reply: Reply, what: string) => {
  expect(isOk(reply), `${what}: expected 2xx, got ${shown(reply)}`).toBe(true);
};

// ---------------------------------------------------------------------------
// W1 and W2 routes
// ---------------------------------------------------------------------------

type Body = { data?: Record<string, unknown>; meta?: Record<string, unknown> };

type Route = {
  name: string;
  call: (request: APIRequestContext, seeded: G4Seeded, auth: Auth, body: Body, retry?: boolean) => Promise<Reply>;
};

const V2_UPDATE: Route = {
  name: 'API v2 /envelope/update',
  call: async (request, seeded, _auth, body, retry = true) =>
    await v2Api(request, seeded.owner.apiToken, '/envelope/update', { envelopeId: seeded.envelopeId, ...body }, retry),
};

const TRPC_ENVELOPE_UPDATE: Route = {
  name: 'tRPC envelope.update',
  call: async (request, seeded, auth, body, retry = true) =>
    await trpcAsUser(request, 'envelope.update', { envelopeId: seeded.envelopeId, ...body }, auth, retry),
};

const TRPC_DOCUMENT_UPDATE: Route = {
  name: 'tRPC document.update',
  call: async (request, seeded, auth, body, retry = true) =>
    await trpcAsUser(request, 'document.update', { documentId: seeded.documentId, ...body }, auth, retry),
};

const W1_ROUTES = [V2_UPDATE, TRPC_ENVELOPE_UPDATE];

const TRPC_ENVELOPE_DISTRIBUTE: Route = {
  name: 'tRPC envelope.distribute',
  call: async (request, seeded, auth, body, retry = true) =>
    await trpcAsUser(request, 'envelope.distribute', { envelopeId: seeded.envelopeId, meta: body.meta }, auth, retry),
};

const V2_DISTRIBUTE: Route = {
  name: 'API v2 /envelope/distribute',
  call: async (request, seeded, _auth, body, retry = true) =>
    await v2Api(
      request,
      seeded.owner.apiToken,
      '/envelope/distribute',
      { envelopeId: seeded.envelopeId, meta: body.meta },
      retry,
    ),
};

const TRPC_DOCUMENT_DISTRIBUTE: Route = {
  name: 'tRPC document.distribute',
  call: async (request, seeded, auth, body, retry = true) =>
    await trpcAsUser(request, 'document.distribute', { documentId: seeded.documentId, meta: body.meta }, auth, retry),
};

/** The seeded meta has drawSignatureEnabled true, as the problem report's request turns it off. */
const DRAW_OFF: Body = { meta: { drawSignatureEnabled: false } };

/** Distribute routes accept only the email-side meta keys. */
const SUBJECT_AND_TIMEZONE: Body = { meta: { subject: 'Changed after finish', timezone: 'Asia/Dubai' } };

// ---------------------------------------------------------------------------
// C1: W1 on a finished envelope, a request that changes settings
// ---------------------------------------------------------------------------

for (const route of W1_ROUTES) {
  for (const kind of KINDS) {
    test(`C1 ${route.name}: drawSignatureEnabled false on ${LABEL[kind]} is refused with ${CODE[kind]}`, async ({
      request,
    }) => {
      const seeded = await seedFinished(kind);
      const auth = await ownerAuth(seeded);
      const before = await snapshot(seeded);

      expect(before.meta.drawSignatureEnabled, 'premise: drawing is enabled').toBe(true);

      const reply = await route.call(request, seeded, auth, DRAW_OFF);

      await keepRecord('reply.json', { route: route.name, kind, reply: brief(reply) });
      await expectRefused(reply, CODE[kind], seeded, before, `${route.name} on ${kind}`);
    });
  }
}

const COMPLETED_CHANGES: Array<{ name: string; body: Body }> = [
  { name: 'timezone', body: { meta: { timezone: 'Asia/Dubai' } } },
  { name: 'subject and message', body: { meta: { subject: 'New subject', message: 'New message' } } },
  { name: 'signingOrder', body: { meta: { signingOrder: 'SEQUENTIAL' } } },
  { name: 'globalAccessAuth', body: { data: { globalAccessAuth: ['TWO_FACTOR_AUTH'] } } },
];

for (const change of COMPLETED_CHANGES) {
  test(`C1 API v2 /envelope/update: ${change.name} on a COMPLETED envelope is refused`, async ({ request }) => {
    const seeded = await seedFinished('COMPLETED');
    const before = await snapshot(seeded);
    const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), change.body);

    await keepRecord('reply.json', { change: change.name, reply: brief(reply) });
    await expectRefused(reply, CODE.COMPLETED, seeded, before, `${change.name} on COMPLETED`);
  });
}

test('C1 API v2 /envelope/update: globalActionAuth on a COMPLETED envelope is refused and nothing is written', async ({
  request,
}) => {
  // Action auth may be refused for a plan reason before the status check; any 4xx with nothing written passes.
  const seeded = await seedFinished('COMPLETED');
  const before = await snapshot(seeded);
  const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), {
    data: { globalActionAuth: ['ACCOUNT'] },
  });

  await keepRecord('reply.json', { reply: brief(reply), expectedCode: CODE.COMPLETED });
  await expectRefusedAny(reply, seeded, before, 'globalActionAuth on COMPLETED');
});

test('C1 API v2 /envelope/update: a folder move with a timezone change on a COMPLETED envelope is refused whole', async ({
  request,
}) => {
  const seeded = await seedFinished('COMPLETED');
  const folder = await createFolder(seeded);
  const before = await snapshot(seeded);
  const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), {
    data: { folderId: folder.id },
    meta: { timezone: 'Asia/Dubai' },
  });

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, CODE.COMPLETED, seeded, before, 'folder move with a timezone change');
});

test('C1 tRPC document.update: drawSignatureEnabled false on a COMPLETED envelope is refused', async ({ request }) => {
  const seeded = await seedFinished('COMPLETED');
  const before = await snapshot(seeded);
  const reply = await TRPC_DOCUMENT_UPDATE.call(request, seeded, await ownerAuth(seeded), DRAW_OFF);

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, CODE.COMPLETED, seeded, before, 'document.update meta on COMPLETED');
});

test('C1 tRPC document.update: useLegacyFieldInsertion true on a COMPLETED envelope is refused', async ({
  request,
}) => {
  const seeded = await seedFinished('COMPLETED');
  const before = await snapshot(seeded);

  expect(before.envelope.useLegacyFieldInsertion, 'premise: legacy insertion is off').toBe(false);

  const reply = await TRPC_DOCUMENT_UPDATE.call(request, seeded, await ownerAuth(seeded), {
    data: { useLegacyFieldInsertion: true },
  });

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, CODE.COMPLETED, seeded, before, 'document.update useLegacyFieldInsertion on COMPLETED');
});

// ---------------------------------------------------------------------------
// C2: W2 on a finished envelope, a request that changes settings
// ---------------------------------------------------------------------------

for (const kind of KINDS) {
  test(`C2 tRPC envelope.distribute: subject and timezone on ${LABEL[kind]} is refused with ${CODE[kind]}`, async ({
    request,
  }) => {
    const seeded = await seedFinished(kind);
    const auth = await ownerAuth(seeded);
    const before = await snapshot(seeded);
    const reply = await TRPC_ENVELOPE_DISTRIBUTE.call(request, seeded, auth, SUBJECT_AND_TIMEZONE);

    await keepRecord('reply.json', { kind, reply: brief(reply) });
    await expectRefused(reply, CODE[kind], seeded, before, `envelope.distribute on ${kind}`);
  });
}

for (const route of [V2_DISTRIBUTE, TRPC_DOCUMENT_DISTRIBUTE]) {
  test(`C2 ${route.name}: subject and timezone on a COMPLETED envelope is refused`, async ({ request }) => {
    const seeded = await seedFinished('COMPLETED');
    const before = await snapshot(seeded);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), SUBJECT_AND_TIMEZONE);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    await expectRefused(reply, CODE.COMPLETED, seeded, before, `${route.name} on COMPLETED`);
  });
}

test('C2 API v1 POST /documents/{id}/send: sendCompletionEmails on a COMPLETED envelope is refused', async ({
  request,
}) => {
  const seeded = await seedFinished('COMPLETED');
  const before = await snapshot(seeded);
  const reply = await v1Api(request, seeded.owner.apiToken, 'POST', `/documents/${seeded.documentId}/send`, {
    sendEmail: false,
    sendCompletionEmails: false,
  });

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefusedAny(reply, seeded, before, 'API v1 send on COMPLETED');
});

// ---------------------------------------------------------------------------
// C3: organisational edits on a finished envelope still succeed
// ---------------------------------------------------------------------------

const createFolder = async (seeded: G4Seeded) =>
  await prisma.folder.create({
    data: {
      name: `F182 ${seeded.envelopeId}`,
      userId: seeded.owner.user.id,
      teamId: seeded.owner.team.id,
      type: FolderType.DOCUMENT,
    },
  });

/** Organisational fields of the envelope, and that the settings stayed put. */
const expectOnlyOrganisational = async (seeded: G4Seeded, before: Snapshot, what: string) => {
  const after = await snapshot(seeded);

  expect(after.meta, `${what}: DocumentMeta is unchanged`).toEqual(before.meta);
  expect(after.envelope.authOptions, `${what}: authOptions are unchanged`).toEqual(before.envelope.authOptions);
  expect(after.envelope.useLegacyFieldInsertion, `${what}: useLegacyFieldInsertion is unchanged`).toBe(
    before.envelope.useLegacyFieldInsertion,
  );

  return after;
};

for (const kind of ['COMPLETED', 'PENDING_REJECTED'] as const) {
  for (const route of W1_ROUTES) {
    test(`C3 ${route.name}: a folder move on ${LABEL[kind]} succeeds`, async ({ request }) => {
      const seeded = await seedFinished(kind);
      const folder = await createFolder(seeded);
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), { data: { folderId: folder.id } });

      await keepRecord('reply.json', { route: route.name, kind, reply: brief(reply) });
      expectAccepted(reply, `${route.name} folder move on ${kind}`);

      const after = await expectOnlyOrganisational(seeded, before, 'folder move');

      expect(after.envelope.folderId, 'the folder is stored').toBe(folder.id);
    });
  }

  test(`C3 API v2 /envelope/update: a visibility change on ${LABEL[kind]} succeeds`, async ({ request }) => {
    const seeded = await seedFinished(kind);
    const before = await snapshot(seeded);

    expect(before.envelope.visibility, 'premise: visibility').toBe(DocumentVisibility.EVERYONE);

    const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), {
      data: { visibility: DocumentVisibility.ADMIN },
    });

    await keepRecord('reply.json', { kind, reply: brief(reply) });
    expectAccepted(reply, `visibility on ${kind}`);

    const after = await expectOnlyOrganisational(seeded, before, 'visibility change');

    expect(after.envelope.visibility, 'the visibility is stored').toBe(DocumentVisibility.ADMIN);
  });

  test(`C3 API v2 /envelope/update: an externalId change on ${LABEL[kind]} succeeds`, async ({ request }) => {
    const seeded = await seedFinished(kind);
    const before = await snapshot(seeded);
    const externalId = `ext-${seeded.envelopeId}`;
    const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), { data: { externalId } });

    await keepRecord('reply.json', { kind, reply: brief(reply) });
    expectAccepted(reply, `externalId on ${kind}`);

    const after = await expectOnlyOrganisational(seeded, before, 'externalId change');

    expect(after.envelope.externalId, 'the externalId is stored').toBe(externalId);
  });
}

for (const kind of ['REJECTED', 'CANCELLED'] as const) {
  test(`C3 API v2 /envelope/update: a folder move on ${LABEL[kind]} succeeds`, async ({ request }) => {
    const seeded = await seedFinished(kind);
    const folder = await createFolder(seeded);
    const before = await snapshot(seeded);
    const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), { data: { folderId: folder.id } });

    await keepRecord('reply.json', { kind, reply: brief(reply) });
    expectAccepted(reply, `folder move on ${kind}`);

    const after = await expectOnlyOrganisational(seeded, before, 'folder move');

    expect(after.envelope.folderId, 'the folder is stored').toBe(folder.id);
  });
}

// ---------------------------------------------------------------------------
// C4: meta equal to the stored values is not a change
// ---------------------------------------------------------------------------

/** The values seedG4Envelope and the DocumentMeta defaults store. */
const STORED_META = {
  drawSignatureEnabled: true,
  typedSignatureEnabled: true,
  uploadSignatureEnabled: true,
  timezone: 'Etc/UTC',
  language: 'en',
  signingOrder: 'PARALLEL',
  allowDictateNextSigner: false,
};

for (const route of [...W1_ROUTES, TRPC_DOCUMENT_UPDATE]) {
  for (const kind of ['COMPLETED', 'PENDING_REJECTED'] as const) {
    test(`C4 ${route.name}: meta equal to the stored values on ${LABEL[kind]} succeeds and changes nothing`, async ({
      request,
    }) => {
      const seeded = await seedFinished(kind);
      const before = await snapshot(seeded);

      for (const [key, value] of Object.entries(STORED_META)) {
        expect((before.meta as Record<string, unknown>)[key], `premise: stored ${key}`).toBe(value);
      }

      const reply = await route.call(request, seeded, await ownerAuth(seeded), { meta: STORED_META });

      await keepRecord('reply.json', { route: route.name, kind, reply: brief(reply) });
      expectAccepted(reply, `${route.name} unchanged meta on ${kind}`);
      expect(await metaOf(seeded), 'DocumentMeta is unchanged').toEqual(before.meta);
    });
  }
}

// ---------------------------------------------------------------------------
// C5: DRAFT and PENDING envelopes behave as before
// ---------------------------------------------------------------------------

const seedOpen = async (status: 'DRAFT' | 'PENDING') =>
  await seedPair(DocumentStatus[status], SigningStatus.NOT_SIGNED, SigningStatus.NOT_SIGNED);

for (const status of ['DRAFT', 'PENDING'] as const) {
  for (const route of [...W1_ROUTES, TRPC_DOCUMENT_UPDATE]) {
    test(`C5 ${route.name}: a meta edit on a ${status} envelope is stored`, async ({ request }) => {
      const seeded = await seedOpen(status);
      const metaAudits = await auditCount(seeded, META_UPDATED);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), {
        meta: { drawSignatureEnabled: false, timezone: 'Asia/Dubai' },
      });

      await keepRecord('reply.json', {
        route: route.name,
        status,
        reply: brief(reply),
        metaUpdatedAuditsAdded: (await auditCount(seeded, META_UPDATED)) - metaAudits,
      });
      expectAccepted(reply, `${route.name} on ${status}`);

      const meta = await metaOf(seeded);

      expect(meta.drawSignatureEnabled, 'drawSignatureEnabled is stored').toBe(false);
      expect(meta.timezone, 'timezone is stored').toBe('Asia/Dubai');
    });
  }

  test(`C5 API v2 /envelope/update: a globalAccessAuth edit on a ${status} envelope is stored`, async ({ request }) => {
    const seeded = await seedOpen(status);
    const reply = await V2_UPDATE.call(request, seeded, await ownerAuth(seeded), {
      data: { globalAccessAuth: ['TWO_FACTOR_AUTH'] },
    });

    await keepRecord('reply.json', { status, reply: brief(reply) });
    expectAccepted(reply, `globalAccessAuth on ${status}`);
    expect(JSON.stringify((await envelopeOf(seeded)).authOptions), 'the access auth is stored').toContain(
      'TWO_FACTOR_AUTH',
    );
  });
}

test('C5 tRPC envelope.distribute: meta on a DRAFT envelope is stored and audited', async ({ request }) => {
  const seeded = await seedOpen('DRAFT');
  const metaAudits = await auditCount(seeded, META_UPDATED);
  const reply = await TRPC_ENVELOPE_DISTRIBUTE.call(request, seeded, await ownerAuth(seeded), SUBJECT_AND_TIMEZONE);

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'envelope.distribute on DRAFT');

  const meta = await metaOf(seeded);

  expect(meta.subject, 'the subject is stored').toBe('Changed after finish');
  expect(meta.timezone, 'the timezone is stored').toBe('Asia/Dubai');
  expect(await auditCount(seeded, META_UPDATED), 'one DOCUMENT_META_UPDATED row is added').toBe(metaAudits + 1);
});

test('C5 tRPC envelope.distribute: meta on a PENDING envelope is not refused as finished', async ({ request }) => {
  // sendDocument may refuse a PENDING envelope on its own account; the criterion is only that W2 does not.
  const seeded = await seedOpen('PENDING');
  const metaAudits = await auditCount(seeded, META_UPDATED);
  const reply = await TRPC_ENVELOPE_DISTRIBUTE.call(request, seeded, await ownerAuth(seeded), SUBJECT_AND_TIMEZONE);
  const meta = await metaOf(seeded);

  await keepRecord('reply.json', {
    reply: brief(reply),
    subject: meta.subject,
    timezone: meta.timezone,
    metaUpdatedAuditsAdded: (await auditCount(seeded, META_UPDATED)) - metaAudits,
  });

  expect(reply.status, `no 5xx: ${shown(reply)}`).toBeLessThan(500);
  expect(reply.status, 'not rate-limited').not.toBe(429);
  expect(Object.values(CODE), `not refused as finished: ${shown(reply)}`).not.toContain(errorOf(reply).code);
  expect(meta.subject, 'the subject is stored').toBe('Changed after finish');
  expect(meta.timezone, 'the timezone is stored').toBe('Asia/Dubai');
  expect(await auditCount(seeded, META_UPDATED), 'one DOCUMENT_META_UPDATED row is added').toBe(metaAudits + 1);
});

// ---------------------------------------------------------------------------
// C6: the edit races the finish. Concurrent rounds assert what the end state
// can prove; the held-lock tests prove the decision is taken under the lock.
// ---------------------------------------------------------------------------

const RACE_EDIT: Body = { meta: { timezone: 'Asia/Dubai', drawSignatureEnabled: false } };

const editStored = (meta: Snapshot['meta']) => meta.timezone === 'Asia/Dubai' && meta.drawSignatureEnabled === false;

const sealJob = async (seeded: G4Seeded) => await runJob(JOB.SEAL, 'Seal Document', { documentId: seeded.documentId });

type Finish = {
  name: string;
  seed: () => Promise<G4Seeded>;
  finish: (request: APIRequestContext, seeded: G4Seeded) => Promise<Reply>;
  code: string;
  settle: (seeded: G4Seeded) => Promise<void>;
};

const FINISHES: Finish[] = [
  {
    name: 'the seal writing COMPLETED',
    seed: seedSignedNotSealed,
    finish: async (_request, seeded) => {
      const result = await sealJob(seeded);

      return { status: result.status, body: result.body, retryAfterMs: null };
    },
    code: CODE.COMPLETED,
    settle: async (seeded) => await waitForEnvelopeStatus(seeded, DocumentStatus.COMPLETED),
  },
  {
    name: 'a recipient rejection',
    seed: async () => await seedOpen('PENDING'),
    finish: async (request, seeded) => await rejectWithToken(request, seeded, seeded.r.s1.token, 'no', false),
    code: CODE.PENDING_REJECTED,
    settle: async (seeded) => {
      expect(
        (await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r.s1.id } })).signingStatus,
        's1 is REJECTED',
      ).toBe(SigningStatus.REJECTED);
    },
  },
];

for (const finish of FINISHES) {
  test(`C6 concurrent: an API v2 meta edit races ${finish.name}; never a stored edit on a finished envelope`, async ({
    request,
  }) => {
    test.setTimeout(RACE_TIMEOUT);

    let round = 0;

    await runIterations(
      `C6-${finish.name.replace(/[^a-z0-9]+/gi, '-')}`,
      async (): Promise<Outcome> => {
        const delayMs = RACE_DELAYS_MS[round++ % RACE_DELAYS_MS.length];
        const seeded = await finish.seed();
        const before = await snapshot(seeded);
        let finishedBeforeSend = false;

        const editChain = async () => {
          await pause(delayMs);
          finishedBeforeSend = await isFinished(seeded);

          return await V2_UPDATE.call(request, seeded, {} as Auth, RACE_EDIT, false);
        };

        const [finished, edited] = await Promise.all([finish.finish(request, seeded), editChain()]);
        const limited = rateLimited(seeded, { finished, edited });

        if (limited) {
          return limited;
        }

        await finish.settle(seeded);

        const meta = await metaOf(seeded);
        const stored = editStored(meta);
        const problems = [
          isOk(finished) ? null : `the finish failed: ${shown(finished)}`,
          edited.status >= 500 ? `the edit answered ${shown(edited)}` : null,
          isOk(edited) && !stored ? 'the edit answered 2xx but its change is not stored' : null,
          isOk(edited) && finishedBeforeSend
            ? 'the edit answered 2xx though the envelope was finished before it was sent'
            : null,
          is4xx(edited) && errorOf(edited).code !== finish.code
            ? `the edit was refused without ${finish.code}: ${shown(edited)}`
            : null,
          is4xx(edited) && JSON.stringify(meta) !== JSON.stringify(before.meta)
            ? 'the edit was refused but DocumentMeta changed'
            : null,
        ].filter((problem): problem is string => problem !== null);

        await pause(300);

        return {
          verdict: problems.length > 0 ? problems.join('; ') : null,
          record: {
            envelopeId: seeded.envelopeId,
            delayMs,
            finishedBeforeSend,
            finished: brief(finished),
            edited: brief(edited),
            stored,
            metaUpdatedAudits: await auditCount(seeded, META_UPDATED),
          },
        };
      },
      RACE_ITERATIONS,
    );
  });
}

const holdEnvelope = (envelopeId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR NO KEY UPDATE`;

/** Holds the envelope row, fires `call`, waits for it to queue, runs `meanwhile` in the holder, releases. */
const whileHeld = async (envelopeId: string, call: () => Promise<Reply>, meanwhile: (tx: Tx) => Promise<unknown>) => {
  let promise: Promise<Reply> | undefined;
  let released = false;
  let settledWhileHeld = false;

  const waiters = await withLock(holdEnvelope(envelopeId), async (pid, tx) => {
    promise = call().finally(() => {
      settledWhileHeld = !released;
    });

    const seen = await waitForWaiters(pid, 1);

    await meanwhile(tx);
    released = true;

    return seen;
  });

  if (!promise) {
    throw new Error('The edit was never fired');
  }

  return { reply: await promise, waiters, settledWhileHeld };
};

const HELD: Array<{
  name: string;
  seed: () => Promise<G4Seeded>;
  meanwhile: (seeded: G4Seeded) => (tx: Tx) => Promise<unknown>;
  code: string;
}> = [
  {
    name: 'the status becomes COMPLETED',
    seed: seedSignedNotSealed,
    meanwhile: (seeded) => async (tx) =>
      await tx.envelope.update({ where: { id: seeded.envelopeId }, data: { status: DocumentStatus.COMPLETED } }),
    code: CODE.COMPLETED,
  },
  {
    name: 's1 rejects',
    seed: async () => await seedOpen('PENDING'),
    meanwhile: (seeded) => async (tx) =>
      await tx.recipient.update({
        where: { id: seeded.r.s1.id },
        data: { signingStatus: SigningStatus.REJECTED, rejectionReason: 'no' },
      }),
    code: CODE.PENDING_REJECTED,
  },
];

for (const held of HELD) {
  test(`C6 under the lock: an API v2 meta edit waiting on the envelope while ${held.name} is refused`, async ({
    request,
  }) => {
    const seeded = await held.seed();
    const before = await snapshot(seeded);
    const result = await whileHeld(
      seeded.envelopeId,
      async () => await V2_UPDATE.call(request, seeded, {} as Auth, RACE_EDIT, false),
      held.meanwhile(seeded),
    );

    await keepRecord('held.json', {
      waiters: result.waiters,
      settledWhileHeld: result.settledWhileHeld,
      reply: brief(result.reply),
    });

    expect(result.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(result.settledWhileHeld, `the edit answered while the envelope row was held: ${shown(result.reply)}`).toBe(
      false,
    );
    expect(result.reply.status, `expected 400 ${held.code}, got ${shown(result.reply)}`).toBe(400);
    expect(errorOf(result.reply).code, `expected ${held.code}, got ${shown(result.reply)}`).toBe(held.code);

    const after = await snapshot(seeded);

    // The holder's own status write moves updatedAt in the COMPLETED case, so only the edit's targets are compared.
    expect(after.meta, 'DocumentMeta is unchanged').toEqual(before.meta);
    expect(after.envelope.authOptions, 'authOptions are unchanged').toEqual(before.envelope.authOptions);
    expect(after.audits, 'no audit row is added').toBe(before.audits);
  });
}

// ---------------------------------------------------------------------------
// Amendment 1, C8: useLegacyFieldInsertion is decided on the locked row.
// A sends the value it read (false) and waits on the envelope; meanwhile B
// turns legacy insertion on and the envelope finishes. A must be refused and
// B's value must stay.
// ---------------------------------------------------------------------------

const LEGACY_AS_READ: Body = { data: { useLegacyFieldInsertion: false } };

const LEGACY_HELD: Array<{
  name: string;
  seed: () => Promise<G4Seeded>;
  finish: Record<string, unknown>;
  rejectS1: boolean;
  code: string;
}> = [
  {
    name: 'completes',
    seed: seedSignedNotSealed,
    finish: { status: DocumentStatus.COMPLETED },
    rejectS1: false,
    code: CODE.COMPLETED,
  },
  {
    name: 'is cancelled',
    seed: async () => await seedOpen('PENDING'),
    finish: { status: DocumentStatus.CANCELLED },
    rejectS1: false,
    code: CODE.CANCELLED,
  },
  {
    name: 'has s1 reject',
    seed: async () => await seedOpen('PENDING'),
    finish: {},
    rejectS1: true,
    code: CODE.PENDING_REJECTED,
  },
];

for (const held of LEGACY_HELD) {
  test(`A1 C8 under the lock: document.update with the useLegacyFieldInsertion it read is refused when B changes it and the envelope ${held.name}`, async ({
    request,
  }) => {
    const seeded = await held.seed();
    const auth = await ownerAuth(seeded);
    const before = await snapshot(seeded);

    expect(before.envelope.useLegacyFieldInsertion, 'premise: A reads legacy insertion off').toBe(false);

    const result = await whileHeld(
      seeded.envelopeId,
      async () => await TRPC_DOCUMENT_UPDATE.call(request, seeded, auth, LEGACY_AS_READ, false),
      async (tx) => {
        await tx.envelope.update({
          where: { id: seeded.envelopeId },
          data: { useLegacyFieldInsertion: true, ...held.finish },
        });

        if (held.rejectS1) {
          await tx.recipient.update({
            where: { id: seeded.r.s1.id },
            data: { signingStatus: SigningStatus.REJECTED, rejectionReason: 'no' },
          });
        }
      },
    );
    const after = await snapshot(seeded);

    await keepRecord('a1-c8-held.json', {
      finish: held.name,
      waiters: result.waiters,
      settledWhileHeld: result.settledWhileHeld,
      reply: brief(result.reply),
      storedLegacy: after.envelope.useLegacyFieldInsertion,
    });

    expect(result.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(result.waiters, 'premise: A queued behind the held envelope row').toBeGreaterThanOrEqual(1);
    expect(result.settledWhileHeld, `A answered while the envelope row was held: ${shown(result.reply)}`).toBe(false);
    expect(result.reply.status, `A: expected 400 ${held.code}, got ${shown(result.reply)}`).toBe(400);
    expect(errorOf(result.reply).code, `A: expected ${held.code}, got ${shown(result.reply)}`).toBe(held.code);
    expect(after.envelope.useLegacyFieldInsertion, "the stored value stays B's").toBe(true);
    expect(after.meta, 'DocumentMeta is unchanged').toEqual(before.meta);
    expect(after.audits, 'no audit row is added').toBe(before.audits);
  });
}

test("A1 C8 concurrent: after B turns legacy insertion on, A sending the value it read races a rejection; never a 2xx that leaves B's value", async ({
  request,
}) => {
  test.setTimeout(RACE_TIMEOUT);

  let round = 0;

  await runIterations(
    'A1-C8-concurrent',
    async (): Promise<Outcome> => {
      const delayMs = RACE_DELAYS_MS[round++ % RACE_DELAYS_MS.length];
      const seeded = await seedOpen('PENDING');
      const auth = await ownerAuth(seeded);
      const b = await TRPC_DOCUMENT_UPDATE.call(
        request,
        seeded,
        auth,
        { data: { useLegacyFieldInsertion: true } },
        false,
      );
      let finishedBeforeSend = false;

      const editChain = async () => {
        await pause(delayMs);
        finishedBeforeSend = await isFinished(seeded);

        return await TRPC_DOCUMENT_UPDATE.call(request, seeded, auth, LEGACY_AS_READ, false);
      };

      const [rejected, edited] = await Promise.all([
        rejectWithToken(request, seeded, seeded.r.s1.token, 'no', false),
        editChain(),
      ]);
      const limited = rateLimited(seeded, { b, rejected, edited });

      if (limited) {
        return limited;
      }

      const stored = (await envelopeOf(seeded)).useLegacyFieldInsertion;
      const problems = [
        isOk(b) ? null : `B failed: ${shown(b)}`,
        isOk(rejected) ? null : `the rejection failed: ${shown(rejected)}`,
        edited.status >= 500 ? `A answered ${shown(edited)}` : null,
        isOk(edited) && stored !== false ? "A answered 2xx but B's value is still stored" : null,
        isOk(edited) && finishedBeforeSend
          ? 'A answered 2xx though the envelope was finished before it was sent'
          : null,
        is4xx(edited) && errorOf(edited).code !== CODE.PENDING_REJECTED
          ? `A was refused without ${CODE.PENDING_REJECTED}: ${shown(edited)}`
          : null,
        is4xx(edited) && stored !== true ? "A was refused but B's value is not stored" : null,
      ].filter((problem): problem is string => problem !== null);

      await pause(300);

      return {
        verdict: problems.length > 0 ? problems.join('; ') : null,
        record: {
          envelopeId: seeded.envelopeId,
          delayMs,
          finishedBeforeSend,
          b: brief(b),
          rejected: brief(rejected),
          edited: brief(edited),
          storedLegacy: stored,
        },
      };
    },
    RACE_ITERATIONS,
  );
});

// ---------------------------------------------------------------------------
// Amendment 1, C9: auth options are decided on the locked row. A sends
// globalAccessAuth [] having read none; B sets TWO_FACTOR_AUTH while A waits.
// ---------------------------------------------------------------------------

const accessAuthOf = (authOptions: unknown) =>
  (authOptions as { globalAccessAuth?: unknown } | null)?.globalAccessAuth ?? [];

const actionAuthOf = (authOptions: unknown) =>
  (authOptions as { globalActionAuth?: unknown } | null)?.globalActionAuth ?? [];

const ACCESS_NONE: Body = { data: { globalAccessAuth: [] } };

type AuthOptions = { globalAccessAuth: Array<'ACCOUNT' | 'TWO_FACTOR_AUTH'>; globalActionAuth: Array<'ACCOUNT'> };

/** Fires A under the held row and applies B's auth options (and `finish`) in the holder. */
const accessRace = async (
  request: APIRequestContext,
  seeded: G4Seeded,
  bAuthOptions: AuthOptions,
  finish: Record<string, unknown> = {},
) =>
  await whileHeld(
    seeded.envelopeId,
    async () => await V2_UPDATE.call(request, seeded, {} as Auth, ACCESS_NONE, false),
    async (tx) =>
      await tx.envelope.update({ where: { id: seeded.envelopeId }, data: { authOptions: bAuthOptions, ...finish } }),
  );

for (const status of ['DRAFT', 'PENDING'] as const) {
  test(`A1 C9 under the lock: on a ${status} envelope A's explicit globalAccessAuth [] is stored over B's TWO_FACTOR_AUTH`, async ({
    request,
  }) => {
    const seeded = await seedOpen(status);
    const before = await snapshot(seeded);

    expect(accessAuthOf(before.envelope.authOptions), 'premise: A reads no access auth').toEqual([]);

    const result = await accessRace(request, seeded, { globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] });
    const stored = (await envelopeOf(seeded)).authOptions;

    await keepRecord('a1-c9-held.json', {
      status,
      waiters: result.waiters,
      settledWhileHeld: result.settledWhileHeld,
      reply: brief(result.reply),
      storedAuthOptions: stored,
    });

    expect(result.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(result.waiters, 'premise: A queued behind the held envelope row').toBeGreaterThanOrEqual(1);
    expect(result.settledWhileHeld, `A answered while the envelope row was held: ${shown(result.reply)}`).toBe(false);
    expectAccepted(result.reply, `A on ${status}`);
    expect(accessAuthOf(stored), "A's explicit [] is stored, last writer wins").toEqual([]);
  });

  test(`A1 C9 under the lock: on a ${status} envelope the auth property A omits keeps the locked row's value`, async ({
    request,
  }) => {
    const seeded = await seedOpen(status);
    const before = await snapshot(seeded);

    expect(actionAuthOf(before.envelope.authOptions), 'premise: A reads no action auth').toEqual([]);

    const result = await accessRace(request, seeded, {
      globalAccessAuth: ['TWO_FACTOR_AUTH'],
      globalActionAuth: ['ACCOUNT'],
    });
    const stored = (await envelopeOf(seeded)).authOptions;

    await keepRecord('a1-c9-omitted.json', {
      status,
      waiters: result.waiters,
      settledWhileHeld: result.settledWhileHeld,
      reply: brief(result.reply),
      storedAuthOptions: stored,
    });

    expect(result.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(result.settledWhileHeld, `A answered while the envelope row was held: ${shown(result.reply)}`).toBe(false);
    expectAccepted(result.reply, `A on ${status}`);
    expect(accessAuthOf(stored), "A's explicit [] is stored").toEqual([]);
    expect(actionAuthOf(stored), "the omitted globalActionAuth keeps B's locked-row value").toEqual(['ACCOUNT']);
  });
}

test("A1 C9 under the lock: on an envelope that completes while A waits, A's globalAccessAuth [] is refused and B's value stays", async ({
  request,
}) => {
  const seeded = await seedSignedNotSealed();
  const before = await snapshot(seeded);

  expect(accessAuthOf(before.envelope.authOptions), 'premise: A reads no access auth').toEqual([]);

  const bAuthOptions: AuthOptions = { globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] };
  const result = await accessRace(request, seeded, bAuthOptions, { status: DocumentStatus.COMPLETED });
  const after = await snapshot(seeded);

  await keepRecord('a1-c9-finished.json', {
    waiters: result.waiters,
    settledWhileHeld: result.settledWhileHeld,
    reply: brief(result.reply),
    storedAuthOptions: after.envelope.authOptions,
  });

  expect(result.reply.status, 'a 429 is a test defect').not.toBe(429);
  expect(result.settledWhileHeld, `A answered while the envelope row was held: ${shown(result.reply)}`).toBe(false);
  expect(result.reply.status, `A: expected 400 ${CODE.COMPLETED}, got ${shown(result.reply)}`).toBe(400);
  expect(errorOf(result.reply).code, `A: expected ${CODE.COMPLETED}, got ${shown(result.reply)}`).toBe(CODE.COMPLETED);
  expect(after.envelope.authOptions, "B's auth options stay").toEqual(bAuthOptions);
  expect(after.meta, 'DocumentMeta is unchanged').toEqual(before.meta);
  expect(after.audits, 'no audit row is added').toBe(before.audits);
});

// ---------------------------------------------------------------------------
// C7: the audit-log PDF header of a COMPLETED envelope after a refused edit
// ---------------------------------------------------------------------------

const LAST_UPDATED = new Date('2026-01-02T12:00:00.000Z');

const downloadAuditLog = async (request: APIRequestContext, seeded: G4Seeded) => {
  const res = await request.get(`${API_V2}/envelope/${seeded.envelopeId}/audit-log/download`, {
    headers: { Authorization: `Bearer ${seeded.owner.apiToken}` },
  });
  const bytes = new Uint8Array(await res.body());

  expect(res.status(), 'the audit log downloads').toBe(200);
  expect(Buffer.from(bytes.subarray(0, 5)).toString(), 'the audit log is a PDF').toBe('%PDF-');

  return rawPdfText(bytes);
};

const joined = (text: string) => text.replace(/\s+/g, '');

test('C7 the audit-log PDF header of a COMPLETED envelope is unchanged after refused edits', async ({ request }) => {
  test.setTimeout(180_000);

  const seeded = await seedFinished('COMPLETED');

  await prisma.documentMeta.update({ where: { id: seeded.documentMetaId }, data: { timezone: 'Asia/Kolkata' } });
  await prisma.envelope.update({ where: { id: seeded.envelopeId }, data: { updatedAt: LAST_UPDATED } });

  const before = await snapshot(seeded);

  expect(before.meta.timezone, 'premise: stored timezone').toBe('Asia/Kolkata');
  expect(before.envelope.updatedAt, 'premise: stored updatedAt').toEqual(LAST_UPDATED);

  const textBefore = await downloadAuditLog(request, seeded);

  expect(joined(textBefore), 'premise: the header prints the stored timezone').toContain('Asia/Kolkata');

  const auth = await ownerAuth(seeded);
  const timezoneEdit = await V2_UPDATE.call(request, seeded, auth, { meta: { timezone: 'Europe/London' } });
  const drawEdit = await TRPC_ENVELOPE_UPDATE.call(request, seeded, auth, DRAW_OFF);

  const textAfter = await downloadAuditLog(request, seeded);
  const after = await snapshot(seeded);

  await keepRecord('c7.json', {
    timezoneEdit: brief(timezoneEdit),
    drawEdit: brief(drawEdit),
    timezoneBefore: before.meta.timezone,
    timezoneAfter: after.meta.timezone,
    updatedAtBefore: before.envelope.updatedAt,
    updatedAtAfter: after.envelope.updatedAt,
    textUnchanged: textAfter === textBefore,
  });
  await test.info().attach('audit-log-before.txt', { body: textBefore, contentType: 'text/plain' });
  await test.info().attach('audit-log-after.txt', { body: textAfter, contentType: 'text/plain' });

  expect(is4xx(timezoneEdit), `the timezone edit is refused: ${shown(timezoneEdit)}`).toBe(true);
  expect(is4xx(drawEdit), `the drawSignatureEnabled edit is refused: ${shown(drawEdit)}`).toBe(true);
  expect(after.meta.timezone, 'the stored timezone is unchanged').toBe('Asia/Kolkata');
  expect(after.envelope.updatedAt, 'Envelope.updatedAt is unchanged').toEqual(LAST_UPDATED);
  expect(joined(textAfter), 'the header does not print the refused timezone').not.toContain('Europe/London');
  expect(joined(textAfter), 'the header still prints the stored timezone').toContain('Asia/Kolkata');
  expect(textAfter, 'the audit-log PDF text is unchanged').toBe(textBefore);
});
