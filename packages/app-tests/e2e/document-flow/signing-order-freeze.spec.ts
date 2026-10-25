/**
 * #157: the signing order is frozen once a recipient has acted, nobody goes
 * ahead of the settled prefix, and the owner writers decide under the envelope
 * lock.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/F157/spec.md before
 * the fix, without reading the writers (W1 updateEnvelope, W2
 * updateDocumentMeta, W3 createEnvelopeRecipients, W4 updateEnvelopeRecipients,
 * W5 setDocumentRecipients) or lockEnvelopeForOwnerEdit. Envelopes are seeded
 * through Prisma (fixtures/signature-ink.ts); every request under test goes to
 * the running server through the route an owner or a recipient uses; every
 * assertion reads the database.
 *
 * | Criterion | Tests                                                                      |
 * | --------- | -------------------------------------------------------------------------- |
 * | C1        | W1 (API v2 /envelope/update, tRPC envelope.update, tRPC document.update)    |
 * |           | refuse a type switch after a sign, a field insert or a rejection; controls  |
 * |           | W2 (API v1 send, tRPC document.distribute, API v2 /envelope/distribute)     |
 * | C2        | W3 (API v1 POST recipients, API v2 create-many, tRPC createDocumentRecipients)|
 * |           | W4 (API v1 PATCH recipient, API v2 update-many)                             |
 * |           | W5 (tRPC recipient.setDocumentRecipients, tRPC envelope.recipient.set)      |
 * | C3        | the decision is taken under the lock: state changes while the writer waits |
 * | C4        | (a) sign vs type switch, (b) sign vs add ahead; concurrent and step by step |
 * | A3 C2b-d  | role changes, one entry per recipient, effective values (SuperJSON undefined) |
 * | A3 C6     | the V2 editor keeps stored positions: groups, gaps, no order, an added row   |
 * | A4 C6a-b   | the editor adds after an unordered active signer, promotes a CC after 3; C2b |
 *
 * C3 holds the Envelope row FOR NO KEY UPDATE on a separate connection. That
 * mode blocks any row lock a writer takes on the envelope (FOR UPDATE, FOR NO
 * KEY UPDATE, FOR SHARE) but not the KEY SHARE lock a child-row insert takes
 * for its foreign key, so a writer that takes no lock is not held up by it.
 *
 * W2's callers carry no signingOrder in their input schemas (zod strips the
 * key), so W2 cannot request a switch from any route today. Its tests send the
 * key anyway and assert the stored order is untouched and the reply agrees with
 * the route's behaviour on a PENDING document nobody has acted on.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DocumentSigningOrder, DocumentStatus, FieldType, type RecipientRole, SigningStatus } from '@prisma/client';

import { clickAddSignerButton } from '../fixtures/envelope-editor';

import { type Tx, waitForWaiters, withLock } from '../fixtures/lock-barrier';
import { keepRecord, type Outcome, pause, type Reply, rateLimited, runIterations, send } from '../fixtures/reject-seal';
import {
  completeWithToken,
  errorOf,
  type G4Seeded,
  type RecipientSpec,
  SESSION_COOKIE,
  seedFixtureG,
  seedFixtureS,
  seedG4Envelope,
  seedInserted,
  seedSession,
  seedSessionCookie,
  seedSigned,
  signSignature,
  trpcAsUser,
  v1Api,
  v2Api,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';
import { signAndComplete } from '../fixtures/signature-ink-order';

test.describe.configure({ mode: 'default' });

const FROZEN = 'The signing order cannot be changed after a recipient has signed or filled a field.';
const SETTINGS_FROZEN = 'Document settings cannot be changed once the document is completed, rejected or cancelled.';
const AHEAD = 'A recipient cannot be placed at or ahead of the signer whose turn it is.';
const ONCE = 'A recipient can appear only once in a request.';
const OUT_OF_TURN = 'RECIPIENT_OUT_OF_TURN';
const RACE_ITERATIONS = 5;
const RACE_TIMEOUT = 10 * 60_000;

const { PARALLEL, SEQUENTIAL } = DocumentSigningOrder;

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

const carries = (reply: Reply, message: string) =>
  errorOf(reply).message.includes(message) || reply.body.includes(message);

const isRefusedWith = (reply: Reply, message: string) => is4xx(reply) && carries(reply, message);

const isOutOfTurn = (reply: Reply) => reply.status === 400 && errorOf(reply).code === OUT_OF_TURN;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const storedOrder = async (seeded: G4Seeded) =>
  (await prisma.documentMeta.findUniqueOrThrow({ where: { id: seeded.documentMetaId } })).signingOrder;

/** Everything a refused write must leave alone. */
const snapshot = async (seeded: G4Seeded) => ({
  signingOrder: await storedOrder(seeded),
  recipients: await prisma.recipient.findMany({
    where: { envelopeId: seeded.envelopeId },
    select: { id: true, email: true, role: true, signingOrder: true, signingStatus: true },
    orderBy: { id: 'asc' },
  }),
  recipientAudits: await prisma.documentAuditLog.count({
    where: {
      envelopeId: seeded.envelopeId,
      type: { in: ['RECIPIENT_CREATED', 'RECIPIENT_UPDATED', 'RECIPIENT_DELETED'] },
    },
  }),
});

const recipientCount = async (seeded: G4Seeded) =>
  await prisma.recipient.count({ where: { envelopeId: seeded.envelopeId } });

const fieldInserted = async (fieldId: number) =>
  (await prisma.field.findUniqueOrThrow({ where: { id: fieldId } })).inserted;

const statusOf = async (seeded: G4Seeded, key: string) =>
  (await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r[key].id } })).signingStatus;

/** A refusal carrying `message` (when given), with nothing written. */
const expectRefused = async (
  reply: Reply,
  message: string | string[] | null,
  seeded: G4Seeded,
  before: Awaited<ReturnType<typeof snapshot>>,
  what: string,
) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is a test defect, not a result`).not.toBe(429);
  expect(
    message === null ? is4xx(reply) : [message].flat().some((one) => isRefusedWith(reply, one)),
    `${what}: expected a 4xx${message === null ? '' : ` with "${[message].flat().join('" or "')}"`}, got ${shown(reply)}`,
  ).toBe(true);
  expect(await snapshot(seeded), `${what}: nothing is written`).toEqual(before);
};

const expectAccepted = (reply: Reply, what: string) => {
  expect(isOk(reply), `${what}: expected 2xx, got ${shown(reply)}`).toBe(true);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Acted = 'signed' | 'field' | 'rejected' | 'nobody';

const sigAndText = () => [
  { key: 'sig', type: FieldType.SIGNATURE },
  { key: 'text', type: FieldType.TEXT },
];

/** Signers s1 (order 1) and s2 (order 2), each with a SIGNATURE and a TEXT field. */
const seedPair = async (signingOrder: DocumentSigningOrder, status: DocumentStatus = DocumentStatus.PENDING) =>
  await seedG4Envelope({
    internalVersion: 2,
    status,
    signingOrder,
    recipients: [
      { key: 's1', signingOrder: 1, fields: sigAndText() },
      { key: 's2', signingOrder: 2, fields: sigAndText() },
    ] satisfies RecipientSpec[],
  });

/** Makes s1 have acted as `acted` says. */
const actS1 = async (seeded: G4Seeded, acted: Acted) => {
  if (acted === 'signed') {
    await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
    await seedSigned(seeded, 's1');
  }

  if (acted === 'field') {
    await seedInserted(seeded, 's1', 'text', { text: 'filled' });
  }

  if (acted === 'rejected') {
    await prisma.recipient.update({
      where: { id: seeded.r.s1.id },
      data: { signingStatus: SigningStatus.REJECTED, rejectionReason: 'no' },
    });
  }
};

/** Fixture S (s1..s3 at 1..3, cc at 4), SEQUENTIAL, with s1 SIGNED: active step 2, settled prefix s1 and s2. */
const seedS1Signed = async (signingOrder: DocumentSigningOrder = SEQUENTIAL) => {
  const seeded = await seedFixtureS(2, { signingOrder });

  await actS1(seeded, 'signed');

  return seeded;
};

const ownerAuth = async (seeded: G4Seeded) => ({
  cookie: await seedSessionCookie(seeded.owner.user.id),
  teamId: seeded.owner.team.id,
});

type Auth = Awaited<ReturnType<typeof ownerAuth>>;

// ---------------------------------------------------------------------------
// W1 and W2: the routes that write DocumentMeta.signingOrder
// ---------------------------------------------------------------------------

type MetaRoute = {
  name: string;
  call: (
    request: APIRequestContext,
    seeded: G4Seeded,
    auth: Auth,
    signingOrder: DocumentSigningOrder | undefined,
    retry?: boolean,
  ) => Promise<Reply>;
};

const metaOf = (signingOrder: DocumentSigningOrder | undefined) => (signingOrder === undefined ? {} : { signingOrder });

const W1_ROUTES: MetaRoute[] = [
  {
    name: 'API v2 /envelope/update',
    call: async (request, seeded, _auth, signingOrder, retry = true) =>
      await v2Api(
        request,
        seeded.owner.apiToken,
        '/envelope/update',
        { envelopeId: seeded.envelopeId, meta: metaOf(signingOrder) },
        retry,
      ),
  },
  {
    name: 'tRPC envelope.update',
    call: async (request, seeded, auth, signingOrder, retry = true) =>
      await trpcAsUser(
        request,
        'envelope.update',
        { envelopeId: seeded.envelopeId, meta: metaOf(signingOrder) },
        auth,
        retry,
      ),
  },
  {
    name: 'tRPC document.update',
    call: async (request, seeded, auth, signingOrder, retry = true) =>
      await trpcAsUser(
        request,
        'document.update',
        { documentId: seeded.documentId, meta: metaOf(signingOrder) },
        auth,
        retry,
      ),
  },
];

const W2_ROUTES: MetaRoute[] = [
  {
    name: 'API v1 POST /documents/{id}/send',
    call: async (request, seeded, _auth, signingOrder, retry = true) =>
      await v1Api(
        request,
        seeded.owner.apiToken,
        'POST',
        `/documents/${seeded.documentId}/send`,
        { sendEmail: false, ...(signingOrder === undefined ? {} : { meta: { signingOrder }, signingOrder }) },
        retry,
      ),
  },
  {
    name: 'tRPC document.distribute',
    call: async (request, seeded, auth, signingOrder, retry = true) =>
      await trpcAsUser(
        request,
        'document.distribute',
        { documentId: seeded.documentId, meta: metaOf(signingOrder) },
        auth,
        retry,
      ),
  },
  {
    name: 'API v2 /envelope/distribute',
    call: async (request, seeded, _auth, signingOrder, retry = true) =>
      await v2Api(
        request,
        seeded.owner.apiToken,
        '/envelope/distribute',
        { envelopeId: seeded.envelopeId, meta: metaOf(signingOrder) },
        retry,
      ),
  },
];

const other = (order: DocumentSigningOrder) => (order === PARALLEL ? SEQUENTIAL : PARALLEL);

// ---------------------------------------------------------------------------
// C1: W1
// ---------------------------------------------------------------------------

for (const route of W1_ROUTES) {
  for (const from of [PARALLEL, SEQUENTIAL]) {
    const to = other(from);

    for (const acted of ['signed', 'field'] as const) {
      test(`C1 ${route.name}: ${from} to ${to} is refused on a PENDING document after s1 ${acted === 'signed' ? 'signed' : 'filled a field'}`, async ({
        request,
      }) => {
        const seeded = await seedPair(from);

        await actS1(seeded, acted);

        const auth = await ownerAuth(seeded);
        const before = await snapshot(seeded);

        expect(before.signingOrder, 'premise: stored order').toBe(from);

        const reply = await route.call(request, seeded, auth, to);

        await keepRecord('reply.json', { route: route.name, from, to, acted, reply: brief(reply) });
        await expectRefused(reply, FROZEN, seeded, before, `${route.name} ${from} to ${to}`);
      });
    }
  }

  test(`C1 ${route.name}: the same value as stored succeeds on a PENDING document after s1 signed`, async ({
    request,
  }) => {
    const seeded = await seedPair(SEQUENTIAL);

    await actS1(seeded, 'signed');

    const reply = await route.call(request, seeded, await ownerAuth(seeded), SEQUENTIAL);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} SEQUENTIAL on SEQUENTIAL`);
    expect(await storedOrder(seeded), 'the stored order is unchanged').toBe(SEQUENTIAL);
  });

  test(`C1 ${route.name}: a DRAFT document can switch PARALLEL to SEQUENTIAL`, async ({ request }) => {
    const seeded = await seedPair(PARALLEL, DocumentStatus.DRAFT);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), SEQUENTIAL);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} on a DRAFT`);
    expect(await storedOrder(seeded), 'the switch is stored').toBe(SEQUENTIAL);
  });

  test(`C1 ${route.name}: a PENDING document nobody has acted on can switch SEQUENTIAL to PARALLEL`, async ({
    request,
  }) => {
    const seeded = await seedPair(SEQUENTIAL);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), PARALLEL);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} on a PENDING document nobody acted on`);
    expect(await storedOrder(seeded), 'the switch is stored').toBe(PARALLEL);
  });
}

test('C1 API v2 /envelope/update: PARALLEL to SEQUENTIAL is refused after s1 rejected', async ({ request }) => {
  const seeded = await seedPair(PARALLEL);

  await actS1(seeded, 'rejected');

  const before = await snapshot(seeded);
  const reply = await W1_ROUTES[0].call(request, seeded, await ownerAuth(seeded), SEQUENTIAL);

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, [FROZEN, SETTINGS_FROZEN], seeded, before, 'switch after a rejection');
});

test('C1 API v2 /envelope/update: a CC recipient does not count as acted', async ({ request }) => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    signingOrder: PARALLEL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: sigAndText() },
      { key: 'cc', role: 'CC', signingOrder: 2, fields: [], signingStatus: SigningStatus.SIGNED },
    ],
  });
  const reply = await W1_ROUTES[0].call(request, seeded, await ownerAuth(seeded), SEQUENTIAL);

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'switch with only a CC marked SIGNED');
  expect(await storedOrder(seeded), 'the switch is stored').toBe(SEQUENTIAL);
});

// ---------------------------------------------------------------------------
// C1: W2. No caller accepts signingOrder; the stored order must survive, and
// the route must treat an acted document as it treats an untouched one.
// ---------------------------------------------------------------------------

for (const route of W2_ROUTES) {
  test(`C1 ${route.name}: a PENDING document after s1 signed keeps its signing order`, async ({ request }) => {
    const probe = await seedPair(PARALLEL);
    const probeReply = await route.call(request, probe, await ownerAuth(probe), undefined);

    const seeded = await seedPair(PARALLEL);

    await actS1(seeded, 'signed');

    const auth = await ownerAuth(seeded);
    const plain = await route.call(request, seeded, auth, undefined);
    const smuggled = await route.call(request, seeded, auth, SEQUENTIAL);

    await keepRecord('replies.json', {
      route: route.name,
      untouchedPendingDocument: brief(probeReply),
      actedNoOrderInRequest: brief(plain),
      actedWithSequentialInRequest: brief(smuggled),
      refusesPendingOutright: is4xx(probeReply),
    });

    expect(
      probeReply.status,
      `premise: ${route.name} on an untouched PENDING document: ${shown(probeReply)}`,
    ).toBeLessThan(500);
    expect(probeReply.status, 'premise: not rate-limited').not.toBe(429);

    for (const reply of [plain, smuggled]) {
      expect(reply.status, `${route.name}: no 5xx: ${shown(reply)}`).toBeLessThan(500);
    }

    expect(await storedOrder(seeded), `${route.name}: the stored order is still PARALLEL`).toBe(PARALLEL);

    if (is4xx(probeReply)) {
      // The route refuses a PENDING document outright, so it cannot change the order of one.
      expect(
        is4xx(plain) && is4xx(smuggled),
        `${route.name}: refuses the acted document too: ${shown(plain)} / ${shown(smuggled)}`,
      ).toBe(true);

      return;
    }

    expectAccepted(plain, `${route.name} with no order in the request is not a change`);
    expect(
      isOk(smuggled) || isRefusedWith(smuggled, FROZEN),
      `${route.name} with SEQUENTIAL in the request: ignored or refused with the C1 message, got ${shown(smuggled)}`,
    ).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// C2: W3, W4, W5 on fixture S with s1 SIGNED (active step 2; prefix s1, s2)
// ---------------------------------------------------------------------------

type NewRecipient = { email: string; name: string; role: 'SIGNER'; signingOrder?: number };

const newRecipient = (seeded: G4Seeded, signingOrder: number | undefined): NewRecipient => ({
  email: `${seeded.r.s1.mailbox}-new@test.documenso.com`,
  name: 'New signer',
  role: 'SIGNER',
  ...(signingOrder === undefined ? {} : { signingOrder }),
});

type AddRoute = {
  name: string;
  call: (
    request: APIRequestContext,
    seeded: G4Seeded,
    auth: Auth,
    recipient: NewRecipient,
    retry?: boolean,
  ) => Promise<Reply>;
};

const W3_ROUTES: AddRoute[] = [
  {
    name: 'API v1 POST /documents/{id}/recipients',
    call: async (request, seeded, _auth, recipient, retry = true) =>
      await v1Api(
        request,
        seeded.owner.apiToken,
        'POST',
        `/documents/${seeded.documentId}/recipients`,
        recipient,
        retry,
      ),
  },
  {
    name: 'API v2 /envelope/recipient/create-many',
    call: async (request, seeded, _auth, recipient, retry = true) =>
      await v2Api(
        request,
        seeded.owner.apiToken,
        '/envelope/recipient/create-many',
        { envelopeId: seeded.envelopeId, data: [recipient] },
        retry,
      ),
  },
  {
    name: 'tRPC recipient.createDocumentRecipients',
    call: async (request, seeded, auth, recipient, retry = true) =>
      await trpcAsUser(
        request,
        'recipient.createDocumentRecipients',
        { documentId: seeded.documentId, recipients: [recipient] },
        auth,
        retry,
      ),
  },
];

type MoveRoute = {
  name: string;
  call: (request: APIRequestContext, seeded: G4Seeded, auth: Auth, key: string, signingOrder: number) => Promise<Reply>;
};

const W4_ROUTES: MoveRoute[] = [
  {
    name: 'API v1 PATCH /documents/{id}/recipients/{recipientId}',
    call: async (request, seeded, _auth, key, signingOrder) =>
      await v1Api(
        request,
        seeded.owner.apiToken,
        'PATCH',
        `/documents/${seeded.documentId}/recipients/${seeded.r[key].id}`,
        {
          name: seeded.r[key].name,
          email: seeded.r[key].email,
          role: seeded.r[key].role,
          signingOrder,
        },
      ),
  },
  {
    name: 'API v2 /envelope/recipient/update-many',
    call: async (request, seeded, _auth, key, signingOrder) =>
      await v2Api(request, seeded.owner.apiToken, '/envelope/recipient/update-many', {
        envelopeId: seeded.envelopeId,
        data: [{ id: seeded.r[key].id, signingOrder }],
      }),
  },
];

const S_ORDERS: Record<string, number> = { s1: 1, s2: 2, s3: 3, cc: 4 };

type SetRoute = {
  name: string;
  call: (
    request: APIRequestContext,
    seeded: G4Seeded,
    auth: Auth,
    orders: Record<string, number>,
    extra?: NewRecipient,
  ) => Promise<Reply>;
};

const fullList = (seeded: G4Seeded, orders: Record<string, number>, extra?: NewRecipient) => [
  ...['s1', 's2', 's3', 'cc'].map((key) => ({
    id: seeded.r[key].id,
    email: seeded.r[key].email,
    name: seeded.r[key].name,
    role: seeded.r[key].role,
    signingOrder: orders[key],
  })),
  ...(extra ? [extra] : []),
];

const W5_ROUTES: SetRoute[] = [
  {
    name: 'tRPC recipient.setDocumentRecipients',
    call: async (request, seeded, auth, orders, extra) =>
      await trpcAsUser(
        request,
        'recipient.setDocumentRecipients',
        { documentId: seeded.documentId, recipients: fullList(seeded, orders, extra) },
        auth,
      ),
  },
  {
    name: 'tRPC envelope.recipient.set',
    call: async (request, seeded, auth, orders, extra) =>
      await trpcAsUser(
        request,
        'envelope.recipient.set',
        { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', recipients: fullList(seeded, orders, extra) },
        auth,
      ),
  },
];

/** The current signer s2 can still sign and complete. */
const expectS2CanSign = async (request: APIRequestContext, seeded: G4Seeded) => {
  await signAndComplete(request, seeded, 's2');
};

// W3 --------------------------------------------------------------------------

for (const route of W3_ROUTES) {
  for (const order of [1, 2]) {
    test(`C2 ${route.name}: a new recipient at order ${order} (${order === 2 ? 'at' : 'ahead of'} the active step 2) is refused`, async ({
      request,
    }) => {
      const seeded = await seedS1Signed();
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, order));

      await keepRecord('reply.json', { route: route.name, order, reply: brief(reply) });
      await expectRefused(reply, AHEAD, seeded, before, `${route.name} new at ${order}`);
    });
  }

  for (const order of [3, undefined]) {
    test(`C2 ${route.name}: a new recipient ${order === undefined ? 'with no order' : `at order ${order}`} is added and s2 can still sign`, async ({
      request,
    }) => {
      const seeded = await seedS1Signed();
      const count = await recipientCount(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, order));

      await keepRecord('reply.json', { route: route.name, order: order ?? null, reply: brief(reply) });
      expectAccepted(reply, `${route.name} new ${order ?? 'unordered'}`);
      expect(await recipientCount(seeded), 'the recipient is added').toBe(count + 1);
      await expectS2CanSign(request, seeded);
    });
  }
}

test('C2 API v2 create-many: nobody acted (active step 1), a new recipient at order 1 is refused', async ({
  request,
}) => {
  const seeded = await seedFixtureS(2);
  const before = await snapshot(seeded);
  const reply = await W3_ROUTES[1].call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 1));

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, AHEAD, seeded, before, 'new at 1 with nobody acted');
});

test('C2 API v2 create-many: nobody acted (active step 1), a new recipient at order 2 is added', async ({
  request,
}) => {
  const seeded = await seedFixtureS(2);
  const count = await recipientCount(seeded);
  const reply = await W3_ROUTES[1].call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 2));

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'new at 2 with nobody acted');
  expect(await recipientCount(seeded), 'the recipient is added').toBe(count + 1);
});

test('C2 API v2 create-many: a PARALLEL PENDING document with s1 signed takes a new recipient at order 1', async ({
  request,
}) => {
  const seeded = await seedS1Signed(PARALLEL);
  const count = await recipientCount(seeded);
  const reply = await W3_ROUTES[1].call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 1));

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'new at 1 on a PARALLEL document');
  expect(await recipientCount(seeded), 'the recipient is added').toBe(count + 1);
});

test('C2 API v2 create-many: a DRAFT SEQUENTIAL document takes a new recipient at order 1', async ({ request }) => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    status: DocumentStatus.DRAFT,
    signingOrder: SEQUENTIAL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: sigAndText() },
      { key: 's2', signingOrder: 2, fields: sigAndText() },
    ],
  });
  const count = await recipientCount(seeded);
  const reply = await W3_ROUTES[1].call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 1));

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'new at 1 on a DRAFT');
  expect(await recipientCount(seeded), 'the recipient is added').toBe(count + 1);
});

// W4 --------------------------------------------------------------------------

/** Moves that C2 refuses. `message` is null where s1 (already SIGNED) is moved: another refusal may come first. */
const REFUSED_MOVES: Array<{ key: string; to: number; why: string; message: string | null }> = [
  { key: 's3', to: 1, why: 'outside the prefix, ahead of the active step', message: AHEAD },
  { key: 's3', to: 2, why: 'outside the prefix, at the active step', message: AHEAD },
  { key: 's2', to: 3, why: 'the current signer, in the prefix', message: AHEAD },
  { key: 's1', to: 2, why: 'a signed recipient, in the prefix', message: null },
];

const ALLOWED_MOVES: Array<{ key: string; to: number; why: string }> = [
  { key: 's3', to: 5, why: 'after the active step' },
  { key: 's3', to: 3, why: 'the same value' },
];

for (const route of W4_ROUTES) {
  for (const move of REFUSED_MOVES) {
    test(`C2 ${route.name}: moving ${move.key} to ${move.to} (${move.why}) is refused`, async ({ request }) => {
      const seeded = await seedS1Signed();
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), move.key, move.to);

      await keepRecord('reply.json', { route: route.name, move, reply: brief(reply) });
      await expectRefused(reply, move.message, seeded, before, `${route.name} ${move.key} to ${move.to}`);
    });
  }

  for (const move of ALLOWED_MOVES) {
    test(`C2 ${route.name}: moving ${move.key} to ${move.to} (${move.why}) succeeds and s2 can still sign`, async ({
      request,
    }) => {
      const seeded = await seedS1Signed();
      const reply = await route.call(request, seeded, await ownerAuth(seeded), move.key, move.to);

      await keepRecord('reply.json', { route: route.name, move, reply: brief(reply) });
      expectAccepted(reply, `${route.name} ${move.key} to ${move.to}`);
      expect(
        (await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.r[move.key].id } })).signingOrder,
        'the order is stored',
      ).toBe(move.to);
      await expectS2CanSign(request, seeded);
    });
  }
}

test('C2a API v2 /envelope/recipient/update-many: naming s3 twice, once after and once ahead of the active step, is refused', async ({
  request,
}) => {
  const seeded = await seedS1Signed();
  const before = await snapshot(seeded);
  const reply = await v2Api(request, seeded.owner.apiToken, '/envelope/recipient/update-many', {
    envelopeId: seeded.envelopeId,
    data: [
      { id: seeded.r.s3.id, signingOrder: 5 },
      { id: seeded.r.s3.id, signingOrder: 1 },
    ],
  });

  await keepRecord('reply.json', { reply: brief(reply) });
  // Amendment 3 C2c: a request naming one recipient twice is refused outright.
  await expectRefused(reply, ONCE, seeded, before, 'update-many naming s3 twice');
});

// W5 --------------------------------------------------------------------------

for (const route of W5_ROUTES) {
  for (const move of REFUSED_MOVES) {
    test(`C2 ${route.name}: a set moving ${move.key} to ${move.to} (${move.why}) is refused`, async ({ request }) => {
      const seeded = await seedS1Signed();
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), { ...S_ORDERS, [move.key]: move.to });

      await keepRecord('reply.json', { route: route.name, move, reply: brief(reply) });
      await expectRefused(reply, move.message, seeded, before, `${route.name} ${move.key} to ${move.to}`);
    });
  }

  test(`C2 ${route.name}: a set swapping s2 and s3 is refused`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const before = await snapshot(seeded);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), { ...S_ORDERS, s2: 3, s3: 2 });

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    await expectRefused(reply, AHEAD, seeded, before, `${route.name} swap s2 and s3`);
  });

  test(`C2 ${route.name}: a set adding a new recipient at order 1 is refused`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const before = await snapshot(seeded);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), S_ORDERS, newRecipient(seeded, 1));

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    await expectRefused(reply, AHEAD, seeded, before, `${route.name} add at 1`);
  });

  test(`C2 ${route.name}: a set with every order unchanged succeeds`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const reply = await route.call(request, seeded, await ownerAuth(seeded), S_ORDERS);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} unchanged`);
  });

  test(`C2 ${route.name}: a set moving s3 to 5 and adding a recipient at 6 succeeds and s2 can still sign`, async ({
    request,
  }) => {
    const seeded = await seedS1Signed();
    const count = await recipientCount(seeded);
    const reply = await route.call(
      request,
      seeded,
      await ownerAuth(seeded),
      { ...S_ORDERS, s3: 5 },
      newRecipient(seeded, 6),
    );

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} s3 to 5, new at 6`);
    expect(await recipientCount(seeded), 'the recipient is added').toBe(count + 1);
    await expectS2CanSign(request, seeded);
  });
}

// ---------------------------------------------------------------------------
// C3: the decision is taken under the lock. The test holds the Envelope row,
// fires the writer, changes the state the decision depends on inside the
// holding transaction, and releases. A writer that checked before taking the
// lock acts on the stale state.
// ---------------------------------------------------------------------------

const holdEnvelope = (envelopeId: string) => async (tx: Tx) =>
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelopeId} FOR NO KEY UPDATE`;

type Held = { reply: Reply; waiters: number; settledWhileHeld: boolean };

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
    throw new Error('The writer was never fired');
  }

  return { reply: await promise, waiters, settledWhileHeld } satisfies Held;
};

const insertInTx = (seeded: G4Seeded, key: string, fieldKey: string) => async (tx: Tx) =>
  await tx.field.update({
    where: { id: seeded.r[key].fields[fieldKey].id },
    data: { inserted: true, customText: 'x' },
  });

const signInTx = (seeded: G4Seeded, key: string) => async (tx: Tx) => {
  await tx.field.update({ where: { id: seeded.r[key].fields.sig.id }, data: { inserted: true } });
  await tx.signature.create({
    data: { fieldId: seeded.r[key].fields.sig.id, recipientId: seeded.r[key].id, typedSignature: 'S' },
  });
  await tx.recipient.update({
    where: { id: seeded.r[key].id },
    data: { signingStatus: SigningStatus.SIGNED, signedAt: new Date() },
  });
};

for (const route of W1_ROUTES.filter((candidate) => candidate.name !== 'tRPC envelope.update')) {
  test(`C3 ${route.name}: a switch waiting on the lock while s1 fills a field is refused`, async ({ request }) => {
    const seeded = await seedPair(PARALLEL);
    const auth = await ownerAuth(seeded);
    const held = await whileHeld(
      seeded.envelopeId,
      async () => await route.call(request, seeded, auth, SEQUENTIAL, false),
      insertInTx(seeded, 's1', 'text'),
    );

    await keepRecord('held.json', {
      route: route.name,
      waiters: held.waiters,
      settledWhileHeld: held.settledWhileHeld,
      reply: brief(held.reply),
    });

    expect(held.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(held.settledWhileHeld, `${route.name} answered while the envelope row was held: ${shown(held.reply)}`).toBe(
      false,
    );
    expect(
      isRefusedWith(held.reply, FROZEN),
      `${route.name}: refused with the C1 message, got ${shown(held.reply)}`,
    ).toBe(true);
    expect(await storedOrder(seeded), 'the stored order is still PARALLEL').toBe(PARALLEL);
  });
}

for (const route of W3_ROUTES.slice(0, 2)) {
  test(`C3 ${route.name}: an add at order 2 waiting on the lock while s1 signs is refused`, async ({ request }) => {
    const seeded = await seedFixtureS(2);
    const auth = await ownerAuth(seeded);
    const count = await recipientCount(seeded);
    const held = await whileHeld(
      seeded.envelopeId,
      async () => await route.call(request, seeded, auth, newRecipient(seeded, 2), false),
      signInTx(seeded, 's1'),
    );

    await keepRecord('held.json', {
      route: route.name,
      waiters: held.waiters,
      settledWhileHeld: held.settledWhileHeld,
      reply: brief(held.reply),
    });

    expect(held.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(held.settledWhileHeld, `${route.name} answered while the envelope row was held: ${shown(held.reply)}`).toBe(
      false,
    );
    expect(
      isRefusedWith(held.reply, AHEAD),
      `${route.name}: refused with the C2 message, got ${shown(held.reply)}`,
    ).toBe(true);
    expect(await recipientCount(seeded), 'no recipient is added').toBe(count);
  });
}

for (const route of W2_ROUTES) {
  test(`C3 ${route.name}: waits on the envelope lock on a PENDING document`, async ({ request }) => {
    const seeded = await seedPair(PARALLEL);

    await actS1(seeded, 'signed');

    const auth = await ownerAuth(seeded);
    const held = await whileHeld(
      seeded.envelopeId,
      async () => await route.call(request, seeded, auth, undefined, false),
      async () => {},
    );

    await keepRecord('held.json', {
      route: route.name,
      waiters: held.waiters,
      settledWhileHeld: held.settledWhileHeld,
      reply: brief(held.reply),
    });

    expect(held.reply.status, 'a 429 is a test defect').not.toBe(429);

    if (is4xx(held.reply)) {
      // Refused a PENDING document outright; nothing was written, so there was nothing to lock for.
      expect(await storedOrder(seeded), 'the stored order is still PARALLEL').toBe(PARALLEL);

      return;
    }

    expect(held.settledWhileHeld, `${route.name} answered while the envelope row was held: ${shown(held.reply)}`).toBe(
      false,
    );
  });
}

// ---------------------------------------------------------------------------
// C4 (a): s2 signs (field insert, then complete) on a PARALLEL document while
// the owner switches to SEQUENTIAL through W1. Under SEQUENTIAL s2 is out of
// turn (s1 at order 1 has not signed), so the two serial outcomes are told apart.
// ---------------------------------------------------------------------------

const switchToSequential = async (request: APIRequestContext, seeded: G4Seeded, retry = false) =>
  await W1_ROUTES[0].call(request, seeded, {} as Auth, SEQUENTIAL, retry);

const s2Sign = async (request: APIRequestContext, seeded: G4Seeded, retry = false) =>
  await signSignature(request, seeded, seeded.r.s2.token, seeded.r.s2.fields.sig.id, 'S Two', {
    isBase64: false,
    retry,
  });

const s2Complete = async (request: APIRequestContext, seeded: G4Seeded, retry = false) =>
  await completeWithToken(request, seeded, seeded.r.s2.token, { retry });

test('C4a control: on a SEQUENTIAL document nobody has acted on, s2 signing is out of turn', async ({ request }) => {
  const seeded = await seedPair(SEQUENTIAL);
  const reply = await s2Sign(request, seeded, true);

  await keepRecord('reply.json', { reply: brief(reply) });
  expect(isOutOfTurn(reply), `premise for C4a: s2 is out of turn, got ${shown(reply)}`).toBe(true);
});

test('C4a step by step: s2 inserts, the owner switches, s2 completes', async ({ request }) => {
  const seeded = await seedPair(PARALLEL);

  expectAccepted(await s2Sign(request, seeded, true), 'premise: s2 inserts on a PARALLEL document');

  const switched = await switchToSequential(request, seeded, true);

  await keepRecord('reply.json', { switched: brief(switched) });
  expect(isRefusedWith(switched, FROZEN), `the switch after s2's insert is refused, got ${shown(switched)}`).toBe(true);
  expect(await storedOrder(seeded), 'the stored order is still PARALLEL').toBe(PARALLEL);
  expectAccepted(await s2Complete(request, seeded, true), 's2 completes under PARALLEL');
  expect(await statusOf(seeded, 's2'), 's2 is SIGNED').toBe(SigningStatus.SIGNED);
});

test('C4a step by step: the owner switches, then s2 tries to sign', async ({ request }) => {
  const seeded = await seedPair(PARALLEL);

  expectAccepted(await switchToSequential(request, seeded, true), 'the switch with nobody acted lands');
  expect(await storedOrder(seeded), 'SEQUENTIAL is stored').toBe(SEQUENTIAL);

  const signed = await s2Sign(request, seeded, true);

  await keepRecord('reply.json', { signed: brief(signed) });
  expect(isOutOfTurn(signed), `s2 now signs under SEQUENTIAL and is out of turn, got ${shown(signed)}`).toBe(true);
  expect(await fieldInserted(seeded.r.s2.fields.sig.id), "s2's field is not inserted").toBe(false);
});

test('C4a concurrent: s2 signs while the owner switches to SEQUENTIAL; never a switch after an insert', async ({
  request,
}) => {
  test.setTimeout(RACE_TIMEOUT);

  await runIterations(
    'C4a',
    async (): Promise<Outcome> => {
      const seeded = await seedPair(PARALLEL);
      let completed: Reply | null = null;

      const signChain = async () => {
        const signed = await s2Sign(request, seeded);

        if (isOk(signed)) {
          completed = await s2Complete(request, seeded);
        }

        return signed;
      };

      const [signed, switched] = await Promise.all([signChain(), switchToSequential(request, seeded)]);
      const completeReply = completed as Reply | null;
      const limited = rateLimited(seeded, { signed, switched, ...(completeReply ? { completed: completeReply } : {}) });

      if (limited) {
        return limited;
      }

      const order = await storedOrder(seeded);
      const inserted = await fieldInserted(seeded.r.s2.fields.sig.id);
      const record = {
        envelopeId: seeded.envelopeId,
        signed: brief(signed),
        switched: brief(switched),
        completed: completeReply ? brief(completeReply) : null,
        storedOrder: order,
        inserted,
      };

      const signFirst =
        isOk(signed) &&
        isRefusedWith(switched, FROZEN) &&
        order === PARALLEL &&
        completeReply !== null &&
        isOk(completeReply);
      const switchFirst = isOk(switched) && order === SEQUENTIAL && isOutOfTurn(signed) && !inserted;

      await pause(300);

      return {
        verdict:
          signFirst || switchFirst
            ? null
            : `neither serial outcome: sign ${signed.status}, switch ${switched.status}, order ${order}, inserted ${inserted}`,
        record,
      };
    },
    RACE_ITERATIONS,
  );
});

// ---------------------------------------------------------------------------
// C4 (b): s2 (the current signer, s1 SIGNED) signs while the owner adds a
// recipient at order 1, ahead of s2, through W3. Every interleaving: the add is
// refused, nothing of it is written, s2 signs and completes.
// ---------------------------------------------------------------------------

for (const route of W3_ROUTES.slice(0, 2)) {
  test(`C4b step by step (${route.name}): the owner adds at order 1, then s2 signs and completes`, async ({
    request,
  }) => {
    const seeded = await seedS1Signed();
    const before = await snapshot(seeded);
    const added = await route.call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 1));

    await keepRecord('reply.json', { added: brief(added) });
    await expectRefused(added, AHEAD, seeded, before, 'the add ahead of s2');
    await signAndComplete(request, seeded, 's2');
  });

  test(`C4b step by step (${route.name}): s2 inserts, the owner adds at order 1, s2 completes`, async ({ request }) => {
    const seeded = await seedS1Signed();

    expectAccepted(await s2Sign(request, seeded, true), "premise: s2's insert in turn");

    const before = await snapshot(seeded);
    const added = await route.call(request, seeded, await ownerAuth(seeded), newRecipient(seeded, 1));

    await keepRecord('reply.json', { added: brief(added) });
    await expectRefused(added, AHEAD, seeded, before, 'the add ahead of s2 after its insert');

    const completed = await s2Complete(request, seeded, true);

    expectAccepted(completed, 's2 completes');
    expect(await statusOf(seeded, 's2'), 's2 is SIGNED').toBe(SigningStatus.SIGNED);
  });

  test(`C4b concurrent (${route.name}): s2 signs while the owner adds at order 1; the turn is never withdrawn`, async ({
    request,
  }) => {
    test.setTimeout(RACE_TIMEOUT);

    await runIterations(
      `C4b-${route.name.replace(/[^a-z0-9]+/gi, '-')}`,
      async (): Promise<Outcome> => {
        const seeded = await seedS1Signed();
        const auth = await ownerAuth(seeded);
        const count = await recipientCount(seeded);
        let completed: Reply | null = null;

        const signChain = async () => {
          const signed = await s2Sign(request, seeded);

          if (isOk(signed)) {
            completed = await s2Complete(request, seeded);
          }

          return signed;
        };

        const [signed, added] = await Promise.all([
          signChain(),
          route.call(request, seeded, auth, newRecipient(seeded, 1), false),
        ]);
        const completeReply = completed as Reply | null;
        const limited = rateLimited(seeded, { signed, added, ...(completeReply ? { completed: completeReply } : {}) });

        if (limited) {
          return limited;
        }

        const after = await recipientCount(seeded);
        const s2Status = await statusOf(seeded, 's2');
        const problems = [
          isRefusedWith(added, AHEAD) ? null : `the add was not refused with the C2 message: ${shown(added)}`,
          after === count ? null : `the add was written: ${after - count} new recipient(s)`,
          isOk(signed) ? null : `s2's insert was refused: ${shown(signed)}`,
          completeReply !== null && isOk(completeReply) ? null : 's2 did not complete',
          s2Status === SigningStatus.SIGNED ? null : `s2 ended ${s2Status}`,
        ].filter((problem): problem is string => problem !== null);

        await pause(300);

        return {
          verdict: problems.length > 0 ? problems.join('; ') : null,
          record: {
            envelopeId: seeded.envelopeId,
            signed: brief(signed),
            added: brief(added),
            completed: completeReply ? brief(completeReply) : null,
            s2Status,
            recipientsAdded: after - count,
          },
        };
      },
      RACE_ITERATIONS,
    );
  });
}

// ---------------------------------------------------------------------------
// Amendment 3 (Codex r1). Fixture S with s1 SIGNED: active step 2, settled
// prefix s1 and s2. An entry names a recipient by key; a role or an order is
// sent only when the entry carries the key, so "omitted" means absent.
// ---------------------------------------------------------------------------

type Entry = { key: string; role?: RecipientRole; signingOrder?: number; name?: string };

const entryFields = (seeded: G4Seeded, entry: Entry) => ({
  id: seeded.r[entry.key].id,
  ...(entry.role === undefined ? {} : { role: entry.role }),
  ...('signingOrder' in entry ? { signingOrder: entry.signingOrder } : {}),
  ...(entry.name === undefined ? {} : { name: entry.name }),
});

/** A tRPC mutation in SuperJSON form: each path in `undefinedPaths` is null in `json` and marked undefined in `meta.values`. */
const trpcSuperJson = async (
  request: APIRequestContext,
  procedure: string,
  input: Record<string, unknown>,
  undefinedPaths: string[],
  auth: Auth,
  retry = true,
) =>
  await send(
    async () =>
      await request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${auth.cookie}`,
          'x-team-id': String(auth.teamId),
        },
        data: JSON.stringify({
          json: input,
          meta: { values: Object.fromEntries(undefinedPaths.map((key) => [key, ['undefined']])) },
        }),
      }),
    procedure,
    retry,
  );

type EntryRoute = {
  name: string;
  /** False where the route takes one recipient per request. */
  many: boolean;
  call: (request: APIRequestContext, seeded: G4Seeded, auth: Auth, entries: Entry[], retry?: boolean) => Promise<Reply>;
};

const W4_ENTRY_ROUTES: EntryRoute[] = [
  {
    name: 'API v1 PATCH /documents/{id}/recipients/{recipientId}',
    many: false,
    call: async (request, seeded, _auth, [entry], retry = true) => {
      const { id: _id, ...fields } = entryFields(seeded, entry);

      return await v1Api(
        request,
        seeded.owner.apiToken,
        'PATCH',
        `/documents/${seeded.documentId}/recipients/${seeded.r[entry.key].id}`,
        { name: seeded.r[entry.key].name, email: seeded.r[entry.key].email, role: seeded.r[entry.key].role, ...fields },
        retry,
      );
    },
  },
  {
    name: 'API v2 /envelope/recipient/update-many',
    many: true,
    call: async (request, seeded, _auth, entries, retry = true) =>
      await v2Api(
        request,
        seeded.owner.apiToken,
        '/envelope/recipient/update-many',
        { envelopeId: seeded.envelopeId, data: entries.map((entry) => entryFields(seeded, entry)) },
        retry,
      ),
  },
  {
    name: 'tRPC envelope.recipient.updateMany',
    many: true,
    call: async (request, seeded, auth, entries, retry = true) =>
      await trpcAsUser(
        request,
        'envelope.recipient.updateMany',
        { envelopeId: seeded.envelopeId, data: entries.map((entry) => entryFields(seeded, entry)) },
        auth,
        retry,
      ),
  },
];

/**
 * The full list for a W5 set. Recipients no entry names go as stored; a named
 * recipient goes once per entry naming it, with its stored email and name, the
 * entry's role (else the stored one) and the entry's order only when given.
 */
const setList = (seeded: G4Seeded, entries: Entry[]) =>
  ['s1', 's2', 's3', 'cc'].flatMap((key) => {
    const stored = seeded.r[key];
    const named = entries.filter((entry) => entry.key === key);

    if (named.length === 0) {
      return [
        { id: stored.id, email: stored.email, name: stored.name, role: stored.role, signingOrder: S_ORDERS[key] },
      ];
    }

    return named.map((entry) => ({
      id: stored.id,
      email: stored.email,
      name: entry.name ?? stored.name,
      role: entry.role ?? stored.role,
      ...('signingOrder' in entry ? { signingOrder: entry.signingOrder } : {}),
    }));
  });

const setInput = (route: string, seeded: G4Seeded, recipients: unknown[]) =>
  route === 'tRPC recipient.setDocumentRecipients'
    ? { documentId: seeded.documentId, recipients }
    : { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', recipients };

const W5_ENTRY_ROUTES: EntryRoute[] = W5_ROUTES.map((route) => ({
  name: route.name,
  many: true,
  call: async (request, seeded, auth, entries, retry = true) =>
    await trpcAsUser(
      request,
      route.name.replace('tRPC ', ''),
      setInput(route.name, seeded, setList(seeded, entries)),
      auth,
      retry,
    ),
}));

const recipientRow = async (seeded: G4Seeded, key: string) =>
  await prisma.recipient.findUniqueOrThrow({
    where: { id: seeded.r[key].id },
    select: { name: true, role: true, signingOrder: true, signingStatus: true },
  });

// C2b -------------------------------------------------------------------------

const C2B_REFUSED: Array<{ entry: Entry; why: string }> = [
  { entry: { key: 's2', role: 'CC', signingOrder: 4 }, why: 's2 (the current signer) to CC at 4' },
  { entry: { key: 's2', role: 'CC' }, why: 's2 (the current signer) to CC with no order' },
  { entry: { key: 'cc', role: 'SIGNER', signingOrder: 2 }, why: 'the stored CC to SIGNER at the active step 2' },
];

for (const route of [...W4_ENTRY_ROUTES, ...W5_ENTRY_ROUTES]) {
  for (const { entry, why } of C2B_REFUSED) {
    test(`A3 C2b ${route.name}: ${why} is refused and s2 can still sign`, async ({ request }) => {
      const seeded = await seedS1Signed();
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), [entry]);

      await keepRecord('reply.json', { route: route.name, entry, reply: brief(reply) });
      await expectRefused(reply, AHEAD, seeded, before, `${route.name} ${why}`);
      expect(await recipientRow(seeded, 's2'), 's2 stays SIGNER at 2').toMatchObject({
        role: 'SIGNER',
        signingOrder: 2,
      });
      await expectS2CanSign(request, seeded);
    });
  }

  test(`A3 C2b ${route.name}: the stored CC to SIGNER at 5 (after the active step) succeeds`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const reply = await route.call(request, seeded, await ownerAuth(seeded), [
      { key: 'cc', role: 'SIGNER', signingOrder: 5 },
    ]);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} cc to SIGNER at 5`);
    expect(await recipientRow(seeded, 'cc'), 'cc is a SIGNER at 5').toMatchObject({ role: 'SIGNER', signingOrder: 5 });
    await expectS2CanSign(request, seeded);
  });
}

// C2c -------------------------------------------------------------------------

const C2C_DUPLICATES: Array<{ entries: Entry[]; why: string }> = [
  {
    entries: [
      { key: 's3', signingOrder: 5 },
      { key: 's3', signingOrder: 5 },
    ],
    why: 's3 twice, both at 5',
  },
  {
    entries: [
      { key: 's3', role: 'CC', signingOrder: 1 },
      { key: 's3', role: 'SIGNER' },
    ],
    why: 's3 as CC at 1, then as SIGNER with no order',
  },
];

for (const route of [...W4_ENTRY_ROUTES, ...W5_ENTRY_ROUTES].filter((candidate) => candidate.many)) {
  for (const { entries, why } of C2C_DUPLICATES) {
    test(`A3 C2c ${route.name}: a request naming ${why} is refused`, async ({ request }) => {
      const seeded = await seedS1Signed();
      const before = await snapshot(seeded);
      const reply = await route.call(request, seeded, await ownerAuth(seeded), entries);

      await keepRecord('reply.json', { route: route.name, entries, reply: brief(reply) });
      await expectRefused(reply, ONCE, seeded, before, `${route.name} ${why}`);
      expect(await recipientRow(seeded, 's3'), 's3 stays SIGNER at 3').toMatchObject({
        role: 'SIGNER',
        signingOrder: 3,
      });
    });
  }
}

// C2d -------------------------------------------------------------------------

for (const route of W4_ENTRY_ROUTES) {
  test(`A3 C2d ${route.name}: s3 to CC at 1 is refused`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const before = await snapshot(seeded);
    const reply = await route.call(request, seeded, await ownerAuth(seeded), [
      { key: 's3', role: 'CC', signingOrder: 1 },
    ]);

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    await expectRefused(reply, AHEAD, seeded, before, `${route.name} s3 to CC at 1`);
  });
}

test('A3 C2d tRPC envelope.recipient.updateMany (SuperJSON): s3 with signingOrder undefined and a new name keeps order 3', async ({
  request,
}) => {
  const seeded = await seedS1Signed();
  const reply = await trpcSuperJson(
    request,
    'envelope.recipient.updateMany',
    { envelopeId: seeded.envelopeId, data: [{ id: seeded.r.s3.id, signingOrder: null, name: 'x' }] },
    ['data.0.signingOrder'],
    await ownerAuth(seeded),
  );

  await keepRecord('reply.json', { reply: brief(reply) });
  expectAccepted(reply, 'updateMany with signingOrder undefined');
  expect(await recipientRow(seeded, 's3'), 's3 is renamed and stays SIGNER at 3').toMatchObject({
    name: 'x',
    role: 'SIGNER',
    signingOrder: 3,
  });
  await expectS2CanSign(request, seeded);
});

for (const route of W5_ROUTES) {
  const procedure = route.name.replace('tRPC ', '');

  test(`A3 C2d ${route.name} (SuperJSON): s3 with signingOrder undefined keeps order 3`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const recipients = setList(seeded, []).map((recipient) =>
      recipient.id === seeded.r.s3.id ? { ...recipient, signingOrder: null } : recipient,
    );
    const reply = await trpcSuperJson(
      request,
      procedure,
      setInput(route.name, seeded, recipients),
      ['recipients.2.signingOrder'],
      await ownerAuth(seeded),
    );

    await keepRecord('reply.json', { route: route.name, reply: brief(reply) });
    expectAccepted(reply, `${route.name} with s3's signingOrder undefined`);
    expect(await recipientRow(seeded, 's3'), 's3 stays SIGNER at 3').toMatchObject({ role: 'SIGNER', signingOrder: 3 });
  });

  test(`A3 C2d ${route.name}: an omitted order falls back to the row read under the lock`, async ({ request }) => {
    const seeded = await seedS1Signed();
    const auth = await ownerAuth(seeded);
    const held = await whileHeld(
      seeded.envelopeId,
      async () =>
        await trpcAsUser(
          request,
          procedure,
          setInput(route.name, seeded, setList(seeded, [{ key: 's3', role: 'SIGNER' }])),
          auth,
          false,
        ),
      async (tx) => await tx.recipient.update({ where: { id: seeded.r.s3.id }, data: { signingOrder: 5 } }),
    );

    await keepRecord('held.json', {
      route: route.name,
      waiters: held.waiters,
      settledWhileHeld: held.settledWhileHeld,
      reply: brief(held.reply),
    });

    expect(held.reply.status, 'a 429 is a test defect').not.toBe(429);
    expect(held.settledWhileHeld, `${route.name} answered while the envelope row was held: ${shown(held.reply)}`).toBe(
      false,
    );
    expectAccepted(held.reply, `${route.name} with s3's order omitted`);
    expect(
      (await recipientRow(seeded, 's3')).signingOrder,
      's3 keeps the order written while the set waited (5), not the one read before the lock (3)',
    ).toBe(5);
  });
}

// C6: the V2 editor ------------------------------------------------------------

type EditorSave = {
  recipients: Array<{ id?: number; email: string; name: string; signingOrder: number | null }>;
  status: number;
  body: string;
};

/** Records every envelope.recipient.set the editor sends, with the effective order of each entry (undefined as null). */
const recordEditorSaves = (page: Page) => {
  const saves: EditorSave[] = [];

  page.on('response', async (response) => {
    const req = response.request();
    const url = new URL(req.url());

    if (req.method() !== 'POST' || !url.pathname.startsWith('/api/trpc/')) {
      return;
    }

    const index = url.pathname.replace('/api/trpc/', '').split(',').indexOf('envelope.recipient.set');

    if (index < 0) {
      return;
    }

    const posted = JSON.parse(req.postData() ?? 'null');
    const call = url.searchParams.has('batch') ? posted[String(index)] : posted;
    const recipients = (call?.json?.recipients ?? []) as EditorSave['recipients'];
    const text = await response.text().catch(() => '');

    saves.push({
      recipients: recipients.map((recipient) => ({ ...recipient, signingOrder: recipient.signingOrder ?? null })),
      status: response.status(),
      body: redact(text).slice(0, 300),
    });
  });

  return saves;
};

const openEditor = async (page: Page, seeded: G4Seeded) => {
  await seedSession(page.context(), seeded.owner.user.id);
  await page.goto(
    `${WEBAPP_BASE_URL}/t/${seeded.owner.team.url}/documents/${seeded.envelopeId}/edit?step=uploadAndRecipients`,
  );
  await expect(page.locator('[data-testid="signer-email-input"]').first()).toBeVisible({ timeout: 30_000 });
};

const rowFor = async (page: Page, email: string) => {
  const inputs = page.locator('[data-testid="signer-email-input"]');
  const count = await inputs.count();

  for (let index = 0; index < count; index++) {
    if ((await inputs.nth(index).inputValue()) === email) {
      return inputs.nth(index).locator('xpath=ancestor::fieldset[1]');
    }
  }

  throw new Error(`No recipient row with email ${email}`);
};

const storedOrders = async (seeded: G4Seeded) =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(seeded.r).map(async (key) => [key, (await recipientRow(seeded, key)).signingOrder] as const),
    ),
  );

/** Waits for a save matching `matches` to answer, then checks every save sent the stored order of every existing recipient. */
const expectSavesKeepOrders = async (
  saves: EditorSave[],
  seeded: G4Seeded,
  before: Record<string, number | null>,
  matches: (save: EditorSave) => boolean,
) => {
  await expect.poll(() => saves.some(matches), { timeout: 30_000, message: 'the editor sends the edit' }).toBe(true);

  await keepRecord('editor-saves.json', saves);

  const save = saves.filter(matches).at(-1) as EditorSave;

  for (const sent of saves) {
    for (const [key, recipient] of Object.entries(seeded.r)) {
      const entry = sent.recipients.find((candidate) => candidate.id === recipient.id);

      if (entry) {
        expect(entry.signingOrder, `the editor sends ${key}'s stored order`).toBe(before[key]);
      }
    }
  }

  expect(
    isOk({ status: save.status, body: save.body, retryAfterMs: null }),
    `the save succeeds: ${save.status} ${save.body}`,
  ).toBe(true);
};

const signS1 = async (seeded: G4Seeded) => {
  await seedInserted(seeded, 's1', 'sig', { typed: 'S One' });
  await seedSigned(seeded, 's1');
};

/** Gap fixture: SEQUENTIAL, s1 at 1 (SIGNED), s2 at 3, s3 at 7, each with one SIGNATURE field. */
const seedGap = async () => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    signingOrder: SEQUENTIAL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      { key: 's2', signingOrder: 3, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      { key: 's3', signingOrder: 7, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
    ],
  });

  await signS1(seeded);

  return seeded;
};

const renameInEditor = async (page: Page, seeded: G4Seeded, key: string, expected: Record<string, number | null>) => {
  const saves = recordEditorSaves(page);
  const newName = `Renamed ${key}`;

  await openEditor(page, seeded);

  const row = await rowFor(page, seeded.r[key].email);

  await row.locator('input[placeholder^="Recipient "]').fill(newName);

  await expectSavesKeepOrders(saves, seeded, expected, (save) =>
    save.recipients.some((recipient) => recipient.name === newName),
  );
  expect((await recipientRow(seeded, key)).name, `${key} is renamed`).toBe(newName);
  expect(await storedOrders(seeded), 'every stored order is unchanged').toEqual(expected);
};

test('A3 C6 editor on fixture G (s1 SIGNED; s1, s2 at 1; s3 at 2; s4 no order): renaming s3 keeps 1, 1, 2', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedFixtureG(2);

  await signS1(seeded);
  await renameInEditor(page, seeded, 's3', { s1: 1, s2: 1, s3: 2, s4: null });
});

test('A3 C6 editor on a gap fixture (1, 3, 7; s1 SIGNED): renaming s3 keeps 1, 3, 7', async ({ page }) => {
  test.setTimeout(120_000);

  const seeded = await seedGap();

  await renameInEditor(page, seeded, 's3', { s1: 1, s2: 3, s3: 7 });
});

test('A3 C6 editor on a gap fixture (1, 3, 7; s1 SIGNED): a recipient added in the editor goes after 7', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedGap();
  const saves = recordEditorSaves(page);
  const email = `${seeded.r.s1.mailbox}-added@test.documenso.com`;
  const expected = { s1: 1, s2: 3, s3: 7 };

  await openEditor(page, seeded);

  const inputs = page.locator('[data-testid="signer-email-input"]');
  const count = await inputs.count();

  await clickAddSignerButton(page);
  await expect(inputs).toHaveCount(count + 1);

  const blank = await rowFor(page, '');

  await blank.locator('[data-testid="signer-email-input"]').fill(email);
  await blank.locator('input[placeholder^="Recipient "]').fill('Added signer');

  await expectSavesKeepOrders(saves, seeded, expected, (save) =>
    save.recipients.some((recipient) => recipient.email === email),
  );

  const added = await prisma.recipient.findFirst({ where: { envelopeId: seeded.envelopeId, email } });

  await keepRecord('added.json', { signingOrder: added?.signingOrder ?? null });
  expect(added, 'the added recipient is stored').not.toBeNull();
  expect(added?.signingOrder ?? 0, 'the added recipient goes after every existing order').toBeGreaterThan(7);
  expect(await storedOrders(seeded), 'every existing stored order is unchanged').toEqual(expected);
});

// ---------------------------------------------------------------------------
// Amendment 4 (Codex r2): editor flows on a pending SEQUENTIAL document
// ---------------------------------------------------------------------------

/** Fixture N: SEQUENTIAL, s1 at 1 (SIGNED), s2 with no order (active), each with one SIGNATURE field. */
const seedFixtureN = async () => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    signingOrder: SEQUENTIAL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      { key: 's2', signingOrder: null, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
    ],
  });

  await signS1(seeded);

  return seeded;
};

/** Fixture S (s1..s3 at 1..3, cc at 4) plus a CC c stored at order 1, with s1 SIGNED. */
const seedFixtureSWithC = async () => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    signingOrder: SEQUENTIAL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: sigAndText() },
      { key: 's2', signingOrder: 2, fields: sigAndText() },
      { key: 's3', signingOrder: 3, fields: sigAndText() },
      { key: 'cc', role: 'CC', signingOrder: 4, fields: [] },
      { key: 'c', role: 'CC', signingOrder: 1, fields: [] },
    ],
  });

  await actS1(seeded, 'signed');

  return seeded;
};

test('A4 C6a editor on fixture N (s1 SIGNED at 1, s2 active with no order): adding a signer succeeds, goes after s2, and s2 can still sign', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedFixtureN();
  const saves = recordEditorSaves(page);
  const email = `${seeded.r.s1.mailbox}-added@test.documenso.com`;
  const expected = { s1: 1, s2: null };

  expect(await storedOrders(seeded), 'premise: stored orders').toEqual(expected);

  await openEditor(page, seeded);

  const inputs = page.locator('[data-testid="signer-email-input"]');
  const count = await inputs.count();

  await clickAddSignerButton(page);
  await expect(inputs).toHaveCount(count + 1);

  const blank = await rowFor(page, '');

  await blank.locator('[data-testid="signer-email-input"]').fill(email);
  await blank.locator('input[placeholder^="Recipient "]').fill('Added signer');

  await expectSavesKeepOrders(saves, seeded, expected, (save) =>
    save.recipients.some((recipient) => recipient.email === email),
  );

  const added = await prisma.recipient.findFirst({ where: { envelopeId: seeded.envelopeId, email } });

  await keepRecord('added.json', { signingOrder: added?.signingOrder ?? null, role: added?.role ?? null });
  expect(added, 'the added recipient is stored').not.toBeNull();
  expect(added?.role, 'the added recipient is a SIGNER').toBe('SIGNER');
  expect(
    added?.signingOrder ?? null,
    'the added signer has no order, so it sorts after s2 (numbered recipients sort before unordered ones)',
  ).toBeNull();
  expect(await storedOrders(seeded), 's1 and s2 keep their stored orders').toEqual(expected);
  expect(await statusOf(seeded, 's2'), 's2 has not signed yet').toBe(SigningStatus.NOT_SIGNED);
  await expectS2CanSign(request, seeded);
});

test('A4 C6b editor on fixture S plus CC c at 1 (s1 SIGNED): promoting c to SIGNER succeeds, c goes to 4, and s2 can still sign', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedFixtureSWithC();
  const saves = recordEditorSaves(page);
  const before = { s1: 1, s2: 2, s3: 3, cc: 4, c: 1 };

  expect(await storedOrders(seeded), 'premise: stored orders').toEqual(before);

  await openEditor(page, seeded);

  const row = await rowFor(page, seeded.r.c.email);

  await row.locator('button[role="combobox"]').first().click();
  await page.getByRole('option', { name: 'Needs to sign' }).click();

  // The sent-order check covers the signers. c's order is expected to change, and the
  // CCs carry no position in the editor; their stored orders are checked after the save.
  const { c: _c, cc: _cc, ...others } = seeded.r;

  await expectSavesKeepOrders(saves, { ...seeded, r: others }, before, (save) =>
    save.recipients.some(
      (recipient) => recipient.id === seeded.r.c.id && (recipient as { role?: string }).role === 'SIGNER',
    ),
  );

  expect(await recipientRow(seeded, 'c'), 'c is a SIGNER after every existing non-CC recipient').toMatchObject({
    role: 'SIGNER',
    signingOrder: 4,
  });
  expect(await storedOrders(seeded), 'the other orders are unchanged').toEqual({ ...before, c: 4 });
  expect(await recipientRow(seeded, 'cc'), 'cc stays CC').toMatchObject({ role: 'CC' });
  await expectS2CanSign(request, seeded);
});

test('A4 C2b API v2 /envelope/recipient/update-many: CC c (stored at 1) to SIGNER with no order is refused', async ({
  request,
}) => {
  const seeded = await seedFixtureSWithC();
  const before = await snapshot(seeded);
  const reply = await v2Api(request, seeded.owner.apiToken, '/envelope/recipient/update-many', {
    envelopeId: seeded.envelopeId,
    data: [{ id: seeded.r.c.id, role: 'SIGNER' }],
  });

  await keepRecord('reply.json', { reply: brief(reply) });
  await expectRefused(reply, AHEAD, seeded, before, 'update-many c to SIGNER with no order');
  expect(await recipientRow(seeded, 'c'), 'c stays CC at 1').toMatchObject({ role: 'CC', signingOrder: 1 });
});

test('A5 editor on fixture N plus CC c at 1 (s1 SIGNED, s2 active with no order): promoting c to SIGNER succeeds, c is saved unordered after s2, and s2 can still sign', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedG4Envelope({
    internalVersion: 2,
    signingOrder: SEQUENTIAL,
    recipients: [
      { key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      { key: 's2', signingOrder: null, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
      { key: 'c', role: 'CC', signingOrder: 1, fields: [] },
    ],
  });

  await signS1(seeded);

  const saves = recordEditorSaves(page);
  const before = { s1: 1, s2: null, c: 1 };

  expect(await storedOrders(seeded), 'premise: stored orders').toEqual(before);

  await openEditor(page, seeded);

  const row = await rowFor(page, seeded.r.c.email);

  await row.locator('button[role="combobox"]').first().click();
  await page.getByRole('option', { name: 'Needs to sign' }).click();

  // c's order is expected to change, so the sent-order check covers the other recipients only.
  const { c: _c, ...others } = seeded.r;

  await expectSavesKeepOrders(saves, { ...seeded, r: others }, before, (save) =>
    save.recipients.some(
      (recipient) => recipient.id === seeded.r.c.id && (recipient as { role?: string }).role === 'SIGNER',
    ),
  );

  expect(await recipientRow(seeded, 'c'), 'c is a SIGNER saved with no order').toMatchObject({
    role: 'SIGNER',
    signingOrder: null,
  });
  expect(await storedOrders(seeded), 's1 and s2 keep their stored orders').toEqual({ s1: 1, s2: null, c: null });
  expect(await statusOf(seeded, 's2'), 's2 has not signed yet').toBe(SigningStatus.NOT_SIGNED);

  await openEditor(page, seeded);

  const emails = await page
    .locator('[data-testid="signer-email-input"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));

  expect(emails.indexOf(seeded.r.c.email), 'c is listed after s2').toBeGreaterThan(emails.indexOf(seeded.r.s2.email));
  await expectS2CanSign(request, seeded);
});
