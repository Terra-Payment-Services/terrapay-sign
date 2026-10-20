/**
 * G1 round 2, C29: a V2 DATE field is inserted once.
 *
 * Every request goes to the running server through the route a recipient uses;
 * every assertion reads the database.
 *
 * | Criterion | Test                                                                          |
 * | --------- | ----------------------------------------------------------------------------- |
 * | C29       | C29 a DATE field inserted while B's completion waits keeps its value, one row  |
 * | C29 (r3)  | the same test: the completion succeeds and B ends SIGNED                       |
 *
 * The interleaving is deterministic. B's completion reads B's fields, finds the
 * DATE field uninserted, and then takes the Envelope row lock to write the
 * automatic date; B's own DATE sign takes the same lock to insert it. A
 * transaction on a second database connection holds SELECT ... FOR UPDATE on
 * the Envelope row. The test fires B's DATE sign first and waits until it
 * queues on that row, then fires B's completion and waits until it queues
 * behind the sign (the completion has read the fields by then, since its read
 * comes before its locked transaction), then commits. Postgres hands the row to
 * the first waiter, so the sign inserts the DATE field and commits while the
 * completion still waits. The envelope's date format carries milliseconds, so
 * the sign's value and the completion's value differ. The lock lives only in
 * the test.
 *
 * After Codex round 2 the test also requires the completion to succeed (2xx)
 * and B to end SIGNED, so a completion that refuses after waiting cannot pass.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { FieldType, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  complete,
  dataOf,
  expectOk,
  fieldAuditRows,
  keepRecord,
  pause,
  type Reply,
  recipientRow,
  seedEnvelope,
  signFieldV2,
  signV2,
} from '../fixtures/reject-seal';

/** A format with milliseconds, so two insertions a moment apart write different values. */
const DATE_FORMAT_WITH_MS = 'yyyy-MM-dd HH:mm:ss.SSS';

test("C29 a DATE field inserted while B's completion waits on the lock keeps its value and has one insertion row", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedEnvelope(request, { bFields: [{ type: FieldType.DATE }] });
  const dateField = seeded.bExtra.find((field) => field.type === FieldType.DATE);

  if (!dateField) {
    throw new Error('B has no DATE field');
  }

  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } });

  expect(envelope.internalVersion, 'a V2 envelope').toBe(2);

  await prisma.documentMeta.update({
    where: { id: envelope.documentMetaId },
    data: { dateFormat: DATE_FORMAT_WITH_MS },
  });

  expectOk(await signV2(request, seeded.b), 'B signs its SIGNATURE field');

  let sign: Promise<Reply> | undefined;
  let completion: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
    async (pid) => {
      sign = signFieldV2(request, seeded.b.token, dateField.id, { type: FieldType.DATE, value: true }, false);

      const afterSign = await waitForWaiters(pid, 1);

      // Milliseconds in the format: let the clock move before the completion works out its date.
      await pause(50);

      completion = complete(request, seeded, seeded.b, { retry: false });

      const afterCompletion = await waitForWaiters(pid, 2);

      return { afterSign, afterCompletion };
    },
  );

  if (!sign || !completion) {
    throw new Error('The sign or the completion was never fired');
  }

  const [signReply, completionReply] = await Promise.all([sign, completion]);

  const field = await prisma.field.findUniqueOrThrow({ where: { id: dateField.id } });
  const inserts = await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, dateField.secondaryId);
  const insertedValues = inserts.map((row) => (dataOf(row).field as { data?: unknown } | undefined)?.data);
  const b = await recipientRow(seeded.b.id);

  await keepRecord('C29-date.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    signReply: signReply.status,
    signBody: signReply.body.slice(0, 300),
    completionReply: completionReply.status,
    completionBody: completionReply.body.slice(0, 300),
    bStatus: b?.signingStatus,
    field: { inserted: field.inserted, customText: field.customText },
    inserts: inserts.map((row, index) => ({ at: row.createdAt.toISOString(), value: insertedValues[index] })),
  });

  expect(signReply.status, 'the sign was not rate-limited').not.toBe(429);
  expect(completionReply.status, 'the completion was not rate-limited').not.toBe(429);
  expect(waiters.afterSign, "B's DATE sign was seen waiting on the test lock").toBeGreaterThanOrEqual(1);
  expect(waiters.afterCompletion, "B's completion was seen waiting behind the sign").toBeGreaterThanOrEqual(2);

  expectOk(signReply, "B's DATE sign");
  expect.soft(field.inserted, 'the DATE field is inserted').toBe(true);
  expect.soft(inserts, 'exactly one insertion audit row for the DATE field').toHaveLength(1);
  expect.soft(field.customText, 'the DATE field keeps the value its first insertion wrote').toBe(insertedValues[0]);
  expect
    .soft(completionReply.status, `the completion succeeds: ${completionReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(200);
  expect
    .soft(completionReply.status, `the completion succeeds: ${completionReply.body.slice(0, 300)}`)
    .toBeLessThan(300);
  expect.soft(b?.signingStatus, 'B ends SIGNED').toBe(SigningStatus.SIGNED);
});
