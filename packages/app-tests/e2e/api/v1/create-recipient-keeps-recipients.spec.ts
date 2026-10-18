/**
 * API v1 POST /documents/:id/recipients keeps the existing recipients (
 * criteria C1 to C8).
 *
 * Written from the specification alone, without reading the implementation.
 *
 * | Test | Criterion |
 * | ---- | --------- |
 * | C1 DRAFT: the new signer is added and the two existing keep id, token and fields | C1 |
 * | C2 PENDING: the existing signers keep id, token, send state and auth options | C2 |
 * | C3 old link: the existing signers' signing links still open the signing page | C3 |
 * | C4 no email: no existing signer receives a message | C4 |
 * | C5 audit: exactly one RECIPIENT_CREATED row and no deleted or updated rows | C5 |
 * | C6 signed recipient: a signed signer and an unsigned one are untouched | C6 |
 * | C7 refusals: duplicate email, completed document and other team leave recipients unchanged | C7 |
 * | C8 concurrent adds: two simultaneous adds both succeed and keep the originals | C8 |
 *
 * Every document is a V1 document seeded through Prisma, flipped to PENDING
 * where the criterion needs it, with lowercase unique emails. The snapshot
 * taken just before each call covers the recipients' id, token, send and
 * signing state, sentAt, authOptions, the fields' ids and owners, the audit
 * rows and the mailbox counts.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, Prisma, SendStatus, SigningStatus } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  addressFor,
  assertMailCatcherReachable,
  expectNoNewMail,
  jsonHeaders,
  readMailbox,
  uniqueLocalPart,
  V1_URL,
} from '../../fixtures/send-path';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(async ({ request }) => {
  await assertMailCatcherReachable(request);
});

type Seeded = {
  token: string;
  userId: number;
  teamId: number;
  envelopeId: string;
  documentId: number;
  localParts: string[];
};

type SeedOptions = {
  pending: boolean;
  /** Signer A has signed, filled their field and requires account access auth. */
  firstSigned?: boolean;
};

/** A V1 document with two signers, each with one SIGNATURE field, DRAFT or PENDING. */
const seedV1Document = async (label: string, options: SeedOptions): Promise<Seeded> => {
  const { user, team, token } = await apiCreateTestContext(`create-recipient-${label}`);
  const localParts = [uniqueLocalPart(`${label}-a`), uniqueLocalPart(`${label}-b`)];
  const document = await seedDraftDocument(user, team.id, localParts.map(addressFor), { internalVersion: 1 });
  const item = document.envelopeItems[0];

  for (const [index, localPart] of localParts.entries()) {
    const recipient = await prisma.recipient.findFirstOrThrow({
      where: { envelopeId: document.id, email: addressFor(localPart) },
    });

    const field = await prisma.field.create({
      data: {
        envelopeId: document.id,
        envelopeItemId: item.id,
        recipientId: recipient.id,
        type: FieldType.SIGNATURE,
        page: 1,
        positionX: new Prisma.Decimal(10),
        positionY: new Prisma.Decimal(20 + 30 * (index + 1)),
        width: new Prisma.Decimal(25),
        height: new Prisma.Decimal(8),
        customText: '',
        inserted: false,
      },
    });

    if (!options.pending) {
      continue;
    }

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { sendStatus: SendStatus.SENT, sentAt: new Date(Date.now() - 60_000 * (index + 1)) },
    });

    if (options.firstSigned && index === 0) {
      await prisma.recipient.update({
        where: { id: recipient.id },
        data: {
          signingStatus: SigningStatus.SIGNED,
          signedAt: new Date(),
          authOptions: { accessAuth: ['ACCOUNT'], actionAuth: [] },
        },
      });
      await prisma.field.updateMany({
        where: { recipientId: recipient.id },
        data: { inserted: true, customText: 'Signer A' },
      });
      await prisma.signature.create({
        data: { recipientId: recipient.id, fieldId: field.id, typedSignature: 'Signer A' },
      });
    }
  }

  if (options.pending) {
    await prisma.envelope.update({ where: { id: document.id }, data: { status: DocumentStatus.PENDING } });
  }

  return {
    token,
    userId: user.id,
    teamId: team.id,
    envelopeId: document.id,
    documentId: mapSecondaryIdToDocumentId(document.secondaryId),
    localParts,
  };
};

type Snapshot = {
  recipients: {
    id: number;
    email: string;
    token: string;
    sendStatus: SendStatus;
    signingStatus: SigningStatus;
    sentAt: Date | null;
    authOptions: Prisma.JsonValue;
  }[];
  fields: { id: number; recipientId: number | null; inserted: boolean }[];
  auditIds: string[];
};

const takeSnapshot = async (envelopeId: string): Promise<Snapshot> => ({
  recipients: await prisma.recipient.findMany({
    where: { envelopeId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      email: true,
      token: true,
      sendStatus: true,
      signingStatus: true,
      sentAt: true,
      authOptions: true,
    },
  }),
  fields: await prisma.field.findMany({
    where: { envelopeId },
    orderBy: { id: 'asc' },
    select: { id: true, recipientId: true, inserted: true },
  }),
  auditIds: (await prisma.documentAuditLog.findMany({ where: { envelopeId }, select: { id: true } })).map((r) => r.id),
});

const mailboxCounts = async (request: APIRequestContext, localParts: string[]) =>
  await Promise.all(localParts.map(async (localPart) => (await readMailbox(request, localPart)).length));

const addRecipient = async (request: APIRequestContext, doc: Seeded, localPart: string, token = doc.token) =>
  await request.post(`${V1_URL}/documents/${doc.documentId}/recipients`, {
    headers: jsonHeaders(token),
    data: { name: `New ${localPart}`, email: addressFor(localPart), role: 'SIGNER' },
  });

const expectOk = async (res: Awaited<ReturnType<typeof addRecipient>>) => {
  const text = await res.text();

  expect(res.status(), `add recipient: ${text}`).toBe(200);

  return JSON.parse(text) as { id: number; email: string; token: string; documentId: number; signingUrl: string };
};

/** The existing recipients and fields are exactly as they were: same ids, tokens, states and owners. */
const expectExistingUntouched = (before: Snapshot, after: Snapshot) => {
  const beforeIds = before.recipients.map((r) => r.id);

  expect(
    after.recipients.filter((r) => beforeIds.includes(r.id)),
    'every existing recipient keeps id, email, token, send and signing state, sentAt and authOptions',
  ).toEqual(before.recipients);
  expect(
    after.fields.filter((f) => before.fields.some((b) => b.id === f.id)),
    'every existing field row survives with the same id, recipientId and inserted flag',
  ).toEqual(before.fields);
};

test('C1 DRAFT: the new signer is added and the two existing keep id, token and fields', async ({ request }) => {
  const doc = await seedV1Document('c1', { pending: false });
  const before = await takeSnapshot(doc.envelopeId);
  const newPart = uniqueLocalPart('c1-new');

  const created = await expectOk(await addRecipient(request, doc, newPart));
  const after = await takeSnapshot(doc.envelopeId);

  expectExistingUntouched(before, after);
  expect(after.recipients).toHaveLength(before.recipients.length + 1);

  const added = after.recipients.find((r) => r.email === addressFor(newPart));

  expect(added, 'the new recipient exists').toBeDefined();
  expect(created.id).toBe(added!.id);
  expect(created.signingUrl.endsWith(`/sign/${added!.token}`), `signingUrl ${created.signingUrl}`).toBe(true);
  expect(before.recipients.map((r) => r.token)).not.toContain(added!.token);
  expect(await prisma.field.count({ where: { recipientId: added!.id } }), 'the new recipient has no fields').toBe(0);
});

test('C2 PENDING: the existing signers keep id, token, send state and auth options', async ({ request }) => {
  const doc = await seedV1Document('c2', { pending: true });
  const before = await takeSnapshot(doc.envelopeId);

  expect(
    before.recipients.map((r) => r.sendStatus),
    'premise: both signers were sent',
  ).toEqual([SendStatus.SENT, SendStatus.SENT]);
  expect(before.recipients.every((r) => r.sentAt !== null)).toBe(true);

  await expectOk(await addRecipient(request, doc, uniqueLocalPart('c2-new')));
  const after = await takeSnapshot(doc.envelopeId);

  expectExistingUntouched(before, after);
  expect(after.recipients.map((r) => r.signingStatus).slice(0, 2)).toEqual([
    SigningStatus.NOT_SIGNED,
    SigningStatus.NOT_SIGNED,
  ]);
});

test('C3 old link: the existing signers signing links still open the signing page', async ({ page, request }) => {
  const doc = await seedV1Document('c3', { pending: true });
  const before = await takeSnapshot(doc.envelopeId);

  await expectOk(await addRecipient(request, doc, uniqueLocalPart('c3-new')));

  for (const recipient of before.recipients) {
    await page.goto(`${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`);
    await expect(page.getByRole('heading', { name: 'Sign Document' }), `link of ${recipient.email}`).toBeVisible();
  }
});

test('C4 no email: no existing signer receives a message', async ({ request }) => {
  test.setTimeout(60_000);

  const doc = await seedV1Document('c4', { pending: true });
  const countsBefore = await mailboxCounts(request, doc.localParts);

  expect(countsBefore, 'premise: seeding sent no mail').toEqual([0, 0]);

  await expectOk(await addRecipient(request, doc, uniqueLocalPart('c4-new')));

  // One wait covers both mailboxes: the window starts at the call.
  await expectNoNewMail(request, doc.localParts[0], countsBefore[0], 'adding a recipient');

  expect(await mailboxCounts(request, doc.localParts), 'no existing signer gained a message').toEqual(countsBefore);
});

test('C5 audit: exactly one RECIPIENT_CREATED row and no deleted or updated rows', async ({ request }) => {
  const doc = await seedV1Document('c5', { pending: true });
  const before = await takeSnapshot(doc.envelopeId);
  const newPart = uniqueLocalPart('c5-new');

  const created = await expectOk(await addRecipient(request, doc, newPart));

  const rows = await prisma.documentAuditLog.findMany({
    where: { envelopeId: doc.envelopeId, id: { notIn: before.auditIds } },
  });

  expect(
    rows.map((r) => r.type),
    'the call adds one row, RECIPIENT_CREATED',
  ).toEqual(['RECIPIENT_CREATED']);
  expect(rows[0].data).toMatchObject({ recipientId: created.id, recipientEmail: addressFor(newPart) });
  expect(rows.some((r) => r.type === 'RECIPIENT_DELETED' || r.type === 'RECIPIENT_UPDATED')).toBe(false);
});

test('C6 signed recipient: a signed signer and an unsigned one are untouched', async ({ request }) => {
  const doc = await seedV1Document('c6', { pending: true, firstSigned: true });
  const before = await takeSnapshot(doc.envelopeId);

  expect(before.recipients[0].signingStatus, 'premise: signer A signed').toBe(SigningStatus.SIGNED);
  expect(before.recipients[0].authOptions).toEqual({ accessAuth: ['ACCOUNT'], actionAuth: [] });
  expect(before.fields.some((f) => f.recipientId === before.recipients[0].id && f.inserted)).toBe(true);

  await expectOk(await addRecipient(request, doc, uniqueLocalPart('c6-new')));
  const after = await takeSnapshot(doc.envelopeId);

  expectExistingUntouched(before, after);
  expect(after.recipients[0].signingStatus).toBe(SigningStatus.SIGNED);
  expect(after.recipients[1].signingStatus).toBe(SigningStatus.NOT_SIGNED);
});

test('C7 refusals: duplicate email, completed document and other team leave recipients unchanged', async ({
  request,
}) => {
  const doc = await seedV1Document('c7', { pending: true });
  const before = await takeSnapshot(doc.envelopeId);

  // Email already on the document.
  const duplicate = await addRecipient(request, doc, doc.localParts[0]);

  expect(duplicate.status(), await duplicate.text()).toBe(400);
  expect((await duplicate.json()).message).toBe('Recipient already exists');
  expect(await takeSnapshot(doc.envelopeId)).toEqual(before);

  // A caller from another team cannot see the document; the V1 middleware answers 401 for that today.
  const other = await apiCreateTestContext('create-recipient-c7-other');
  const foreign = await addRecipient(request, doc, uniqueLocalPart('c7-foreign'), other.token);

  expect(foreign.status(), await foreign.text()).toBe(401);
  expect((await foreign.json()).message).toBe('Envelope could not be found');
  expect(await takeSnapshot(doc.envelopeId)).toEqual(before);

  // Completed document.
  await prisma.envelope.update({ where: { id: doc.envelopeId }, data: { status: DocumentStatus.COMPLETED } });
  const completed = await addRecipient(request, doc, uniqueLocalPart('c7-completed'));

  expect(completed.status(), await completed.text()).toBe(400);
  expect((await completed.json()).message).toBe('Document is already completed');
  expect(await takeSnapshot(doc.envelopeId)).toEqual(before);
});

test('C8 concurrent adds: two simultaneous adds both succeed and keep the originals', async ({ request }) => {
  const doc = await seedV1Document('c8', { pending: true });
  const before = await takeSnapshot(doc.envelopeId);
  const partX = uniqueLocalPart('c8-x');
  const partY = uniqueLocalPart('c8-y');

  const [resX, resY] = await Promise.all([addRecipient(request, doc, partX), addRecipient(request, doc, partY)]);
  const createdX = await expectOk(resX);
  const createdY = await expectOk(resY);
  const after = await takeSnapshot(doc.envelopeId);

  expectExistingUntouched(before, after);
  expect(after.recipients.map((r) => r.email).sort()).toEqual(
    [...before.recipients.map((r) => r.email), addressFor(partX), addressFor(partY)].sort(),
  );
  expect(createdX.id).not.toBe(createdY.id);

  for (const [created, part] of [
    [createdX, partX],
    [createdY, partY],
  ] as const) {
    const row = after.recipients.find((r) => r.email === addressFor(part));

    expect(row?.id).toBe(created.id);
    expect(created.signingUrl.endsWith(`/sign/${row?.token}`)).toBe(true);
  }
});
