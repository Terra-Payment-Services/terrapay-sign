/**
 * G1 round 4, C33: the editor's field set-list never writes a stale value over
 * a frozen recipient's field.
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C33       | C33 a set-list that read A's field before an owner edit and A's rejection leaves it at Y |
 *
 * The interleaving is forced with real routes only. The test holds SELECT ...
 * FOR UPDATE on the Envelope row from its own connection, and fires, waiting
 * after each until the waiter probe shows it queued on that row:
 *
 *   1. the owner's V2 field update of A's field to geometry Y (width 22,
 *      height 7), which queues first;
 *   2. A's rejection, which queues second;
 *   3. the editor's set-list (V2 envelope.field.set), which reads the fields
 *      while neither has committed, so it carries A's field unchanged at
 *      geometry X (width 30, height 8), and queues third.
 *
 * Then the test commits. Postgres hands the row to the waiters in turn: the
 * edit commits Y, the rejection commits, and the set-list proceeds with its
 * stale X for a recipient who is now REJECTED. The audit rows confirm the
 * order. Passing means A's field ends at Y (the set-list refused with a 4xx or
 * skipped the frozen field) and the set-list did not answer 5xx.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  auditRows,
  expectOk,
  keepRecord,
  type Reply,
  reject,
  seedEnvelope,
  sessionFor,
  trpcRaw,
  v2Post,
} from '../fixtures/reject-seal';

const Y = { width: 22, height: 7 };

test("C33 a set-list that read A's field before an owner edit and A's rejection leaves A's field at the edited geometry", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request);
  const session = await sessionFor(page, seeded.userEmail);
  const fieldsX = await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } });
  const aX = fieldsX.find((field) => field.id === seeded.a.fieldId);

  expect(aX, "premise: A's field exists").toBeTruthy();
  expect([Number(aX?.width), Number(aX?.height)], 'premise: X differs from Y').not.toEqual([Y.width, Y.height]);

  // The list the editor holds: every field as it is now, A's at geometry X.
  const setList = fieldsX.map((field) => ({
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

  let edit: Promise<Reply> | undefined;
  let rejection: Promise<Reply> | undefined;
  let save: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
    async (pid) => {
      edit = v2Post(
        request,
        seeded.apiToken,
        '/envelope/field/update-many',
        { envelopeId: seeded.envelopeId, data: [{ id: seeded.a.fieldId, type: FieldType.SIGNATURE, ...Y }] },
        false,
      );

      const afterEdit = await waitForWaiters(pid, 1);

      rejection = reject(request, seeded, seeded.a, 'A rejects while the editor saves', false);

      const afterReject = await waitForWaiters(pid, 2);

      save = trpcRaw(
        session,
        'envelope.field.set',
        { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', fields: setList },
        { retry: false, teamId: seeded.teamId },
      );

      const afterSave = await waitForWaiters(pid, 3);

      return { afterEdit, afterReject, afterSave };
    },
  );

  if (!edit || !rejection || !save) {
    throw new Error('A request was never fired');
  }

  const [editReply, rejectReply, saveReply] = await Promise.all([edit, rejection, save]);

  const aAfter = await prisma.field.findUnique({ where: { id: seeded.a.fieldId } });
  const a = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.a.id } });
  const updatedAt = (await auditRows(seeded.envelopeId, 'FIELD_UPDATED')).map((row) => row.createdAt.getTime());
  const rejectedAt = (await auditRows(seeded.envelopeId, AUDIT.REJECTED)).map((row) => row.createdAt.getTime());

  await keepRecord('C33.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    editReply: editReply.status,
    rejectReply: rejectReply.status,
    saveReply: saveReply.status,
    saveBody: saveReply.body.slice(0, 400),
    aStatus: a.signingStatus,
    x: { width: Number(aX?.width), height: Number(aX?.height) },
    y: Y,
    after: aAfter ? { width: Number(aAfter.width), height: Number(aAfter.height) } : null,
    fieldUpdatedAt: updatedAt.map((at) => new Date(at).toISOString()),
    rejectedAt: rejectedAt.map((at) => new Date(at).toISOString()),
  });

  expect(waiters.afterEdit, 'the owner edit was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
  expect(waiters.afterReject, "A's rejection was seen waiting behind it").toBeGreaterThanOrEqual(2);
  expect(waiters.afterSave, 'the set-list was seen waiting behind both').toBeGreaterThanOrEqual(3);
  expect(saveReply.status, 'the set-list was not rate-limited').not.toBe(429);
  expectOk(editReply, "the owner's edit to Y");
  expectOk(rejectReply, "A's rejection");
  expect(a.signingStatus, 'A is REJECTED').toBe(SigningStatus.REJECTED);
  expect(updatedAt.length, 'the edit wrote a FIELD_UPDATED row').toBeGreaterThanOrEqual(1);
  expect(rejectedAt, 'one rejection row').toHaveLength(1);
  expect(updatedAt[0], 'the edit committed before the rejection').toBeLessThanOrEqual(rejectedAt[0]);

  expect
    .soft(saveReply.status, `the set-list did not fail with a 5xx: ${saveReply.body.slice(0, 300)}`)
    .toBeLessThan(500);
  expect.soft(aAfter, "A's field still exists").not.toBeNull();
  expect
    .soft(aAfter ? { width: Number(aAfter.width), height: Number(aAfter.height) } : null, "A's field stays at Y")
    .toEqual(Y);
});
