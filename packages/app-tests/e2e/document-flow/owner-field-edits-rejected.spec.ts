/**
 * G1 round 2, C26: the owner cannot change a rejecter's fields.
 *
 * Every request goes to the running server through the route the owner uses
 * (API v2, API v1 or the editor's tRPC route); every assertion reads the
 * database.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | C26       | C26 a V2 field create for A while A's rejection commits is refused             |
 * | C26       | C26 a V2 field update for A while A's rejection commits is refused             |
 * | C26       | C26 a V2 field delete for A while A's rejection commits is refused             |
 * | C26       | C26 with A REJECTED, the editor's field set-list cannot remove A's field       |
 * | C26       | C26 with A REJECTED, API v1 field deletion cannot remove A's field             |
 *
 * The three V2 tests are deterministic interleavings. A transaction on a second
 * database connection takes SELECT ... FOR UPDATE on the Envelope row, A's
 * Recipient row and, for update and delete, A's Field row, then marks A
 * REJECTED and writes the rejection audit row without committing. The field
 * request reads A as NOT_SIGNED under MVCC, passes any check made outside a
 * lock, and then queues on one of the held rows: the Field row for update and
 * delete, A's Recipient row for create (the foreign-key check of the new Field
 * row takes KEY SHARE on it), or the Envelope row if the route locks it first.
 * The test waits until the database shows the request waiting on its
 * transaction, then commits, so the rejection lands first. The lock lives only
 * in the test.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  API_V1,
  AUDIT,
  auditRows,
  dataOf,
  expectRefused,
  keepRecord,
  REJECTION_REASON,
  type Reply,
  recipientRow,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  send,
  sessionFor,
  trpcRaw,
  v2Post,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

const FIELD_AUDIT = {
  CREATED: 'FIELD_CREATED',
  UPDATED: 'FIELD_UPDATED',
  DELETED: 'FIELD_DELETED',
} as const;

/** Field audit rows of the envelope that name A, by any of the keys the field audit rows use. */
const fieldAuditRowsForA = async (seeded: Seeded, type: string) =>
  (await auditRows(seeded.envelopeId, type)).filter((row) => {
    const data = dataOf(row);

    return data.fieldRecipientId === seeded.a.id || data.recipientId === seeded.a.id;
  });

const aFields = async (seeded: Seeded) =>
  await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId, recipientId: seeded.a.id } });

/**
 * Holds the rows named above, marks A REJECTED inside the same transaction,
 * fires `request`, waits until it queues behind the transaction, then commits.
 */
const rejectWhile = async (seeded: Seeded, lockFieldId: number | null, request: () => Promise<Reply>) => {
  let reply: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Recipient" WHERE "id" = ${seeded.a.id} FOR UPDATE`;

      if (lockFieldId !== null) {
        await tx.$queryRaw`SELECT "id" FROM "Field" WHERE "id" = ${lockFieldId} FOR UPDATE`;
      }

      await tx.recipient.update({
        where: { id: seeded.a.id },
        data: { signingStatus: SigningStatus.REJECTED, rejectionReason: REJECTION_REASON, signedAt: new Date() },
      });

      await tx.documentAuditLog.create({
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
            reason: REJECTION_REASON,
          },
        },
      });
    },
    async (pid) => {
      reply = request();

      return await waitForWaiters(pid, 1);
    },
  );

  if (!reply) {
    throw new Error('The field request was never fired');
  }

  return { waiters, reply: await reply };
};

const expectWaiterAndRejection = async (seeded: Seeded, waiters: number, reply: Reply) => {
  expect(reply.status, 'the field request was not rate-limited').not.toBe(429);
  expect(waiters, 'the field request was seen waiting on the test transaction').toBeGreaterThanOrEqual(1);
  expect((await recipientRow(seeded.a.id))?.signingStatus, 'A is REJECTED').toBe(SigningStatus.REJECTED);
};

// ---------------------------------------------------------------------------
// V2 field routes, interleaved with the rejection
// ---------------------------------------------------------------------------

test("C26 a V2 field create for A while A's rejection commits is refused", async ({ request }) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);
  const before = await aFields(seeded);
  const createdBefore = await fieldAuditRowsForA(seeded, FIELD_AUDIT.CREATED);

  const { waiters, reply } = await rejectWhile(
    seeded,
    null,
    async () =>
      await v2Post(
        request,
        seeded.apiToken,
        '/envelope/field/create-many',
        {
          envelopeId: seeded.envelopeId,
          data: [
            {
              recipientId: seeded.a.id,
              envelopeItemId: seeded.itemIds[0],
              type: FieldType.SIGNATURE,
              page: 1,
              positionX: 55,
              positionY: 40,
              width: 20,
              height: 6,
            },
          ],
        },
        false,
      ),
  );

  const after = await aFields(seeded);
  const created = (await fieldAuditRowsForA(seeded, FIELD_AUDIT.CREATED)).filter(
    (row) => !createdBefore.some((earlier) => earlier.id === row.id),
  );

  await keepRecord('C26-create.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    reply: reply.status,
    body: reply.body.slice(0, 400),
    aFieldsBefore: before.map((field) => field.id),
    aFieldsAfter: after.map((field) => field.id),
    newFieldCreatedRows: created.length,
  });

  await expectWaiterAndRejection(seeded, waiters, reply);

  expect
    .soft(reply.status, `the create is refused with a 4xx: ${reply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect.soft(reply.status, `the create is refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
  expect
    .soft(
      after.map((field) => field.id),
      'A has no new field',
    )
    .toEqual(before.map((field) => field.id));
  expect.soft(created, 'no new FIELD_CREATED row names A').toHaveLength(0);
});

test("C26 a V2 field update for A while A's rejection commits is refused", async ({ request }) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);
  const before = await prisma.field.findUniqueOrThrow({ where: { id: seeded.a.fieldId } });

  const { waiters, reply } = await rejectWhile(
    seeded,
    seeded.a.fieldId,
    async () =>
      await v2Post(
        request,
        seeded.apiToken,
        '/envelope/field/update-many',
        {
          envelopeId: seeded.envelopeId,
          data: [{ id: seeded.a.fieldId, type: FieldType.SIGNATURE, width: 22, height: 7 }],
        },
        false,
      ),
  );

  const after = await prisma.field.findUniqueOrThrow({ where: { id: seeded.a.fieldId } });
  const updated = await fieldAuditRowsForA(seeded, FIELD_AUDIT.UPDATED);

  await keepRecord('C26-update.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    reply: reply.status,
    body: reply.body.slice(0, 400),
    before: { width: String(before.width), height: String(before.height) },
    after: { width: String(after.width), height: String(after.height) },
    fieldUpdatedRows: updated.length,
  });

  await expectWaiterAndRejection(seeded, waiters, reply);

  expect
    .soft(reply.status, `the update is refused with a 4xx: ${reply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect.soft(reply.status, `the update is refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
  expect.soft(String(after.width), "A's field kept its width").toBe(String(before.width));
  expect.soft(String(after.height), "A's field kept its height").toBe(String(before.height));
  expect.soft(updated, 'no FIELD_UPDATED row names A').toHaveLength(0);
});

test("C26 a V2 field delete for A while A's rejection commits is refused", async ({ request }) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);

  const { waiters, reply } = await rejectWhile(
    seeded,
    seeded.a.fieldId,
    async () => await v2Post(request, seeded.apiToken, '/envelope/field/delete', { fieldId: seeded.a.fieldId }, false),
  );

  const after = await prisma.field.findUnique({ where: { id: seeded.a.fieldId } });
  const deleted = await fieldAuditRowsForA(seeded, FIELD_AUDIT.DELETED);

  await keepRecord('C26-delete.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    reply: reply.status,
    body: reply.body.slice(0, 400),
    fieldStillThere: after !== null,
    fieldDeletedRows: deleted.length,
  });

  await expectWaiterAndRejection(seeded, waiters, reply);

  expect
    .soft(reply.status, `the delete is refused with a 4xx: ${reply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect.soft(reply.status, `the delete is refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
  expect.soft(after, "A's field still exists").not.toBeNull();
  expect.soft(deleted, 'no FIELD_DELETED row names A').toHaveLength(0);
});

// ---------------------------------------------------------------------------
// A already REJECTED, no race
// ---------------------------------------------------------------------------

/** The envelope's fields in the editor's set-list shape, leaving out `omitFieldId`. */
const setListWithout = async (seeded: Seeded, omitFieldId: number) =>
  (await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } }))
    .filter((field) => field.id !== omitFieldId)
    .map((field) => ({
      id: field.id,
      envelopeItemId: field.envelopeItemId,
      recipientId: field.recipientId,
      type: field.type,
      page: field.page,
      positionX: Number(field.positionX),
      positionY: Number(field.positionY),
      width: Number(field.width),
      height: Number(field.height),
      ...(field.fieldMeta ? { fieldMeta: field.fieldMeta } : {}),
    }));

test("C26 with A REJECTED, the editor's field set-list cannot remove A's uninserted field", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);

  await seedRejectedNotSealed(seeded);

  const session = await sessionFor(page, seeded.userEmail);
  const fields = await setListWithout(seeded, seeded.a.fieldId);

  expect(
    fields.map((field) => field.id),
    "the list keeps B's field and leaves out A's",
  ).toEqual([seeded.b.fieldId]);

  const reply = await trpcRaw(
    session,
    'envelope.field.set',
    { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', fields },
    { teamId: seeded.teamId },
  );

  const after = await prisma.field.findUnique({ where: { id: seeded.a.fieldId } });
  const deleted = await fieldAuditRowsForA(seeded, FIELD_AUDIT.DELETED);

  await keepRecord('C26-set-list.json', {
    envelopeId: seeded.envelopeId,
    reply: reply.status,
    body: reply.body.slice(0, 400),
    fieldStillThere: after !== null,
    fieldDeletedRows: deleted.length,
  });

  expectRefused(reply, "the set-list that drops A's field");
  expect.soft(after, "A's field still exists").not.toBeNull();
  expect.soft(deleted, 'no FIELD_DELETED row names A').toHaveLength(0);
});

const deleteFieldV1 = async (request: APIRequestContext, seeded: Seeded, fieldId: number) =>
  await send(
    async () =>
      await request.delete(`${API_V1}/documents/${seeded.documentId}/fields/${fieldId}`, {
        headers: { Authorization: `Bearer ${seeded.apiToken}` },
      }),
    'API v1 delete field',
    true,
  );

test("C26 with A REJECTED, API v1 field deletion cannot remove A's uninserted field", async ({ request }) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);

  await seedRejectedNotSealed(seeded);

  const reply = await deleteFieldV1(request, seeded, seeded.a.fieldId);
  const after = await prisma.field.findUnique({ where: { id: seeded.a.fieldId } });
  const deleted = await fieldAuditRowsForA(seeded, FIELD_AUDIT.DELETED);

  await keepRecord('C26-v1-delete.json', {
    envelopeId: seeded.envelopeId,
    reply: reply.status,
    body: reply.body.slice(0, 400),
    fieldStillThere: after !== null,
    fieldDeletedRows: deleted.length,
  });

  expectRefused(reply, "API v1 deletion of A's field");
  expect.soft(after, "A's field still exists").not.toBeNull();
  expect.soft(deleted, 'no FIELD_DELETED row names A').toHaveLength(0);
});
