/**
 * A rejection survives a CC role (G1 round 2, C28).
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md,
 * "Added after Codex round 1"). Envelopes are seeded through API v2. The
 * administrator edits a recipient through admin.recipient.update on a signed-in
 * session, a recipient rejects through recipient.rejectDocumentWithToken, and
 * the seal runs inside the server through its signed job endpoint. The outcome
 * is read from the database.
 *
 * | Criterion | Test                                                                            |
 * | --------- | ------------------------------------------------------------------------------- |
 * | C28       | C28 an administrator cannot turn a recipient who rejected into a CC (unsealed / sealed) |
 * | C28       | C28 an admin edit to CC queued behind A's rejection is refused                  |
 * | C28       | C28 a CC recipient cannot reject (seeded CC / signer made CC by the admin)      |
 * | C28       | C28 the seal keeps a REJECTED recipient REJECTED (rejected CC / rejecter made CC) |
 *
 * The queued edit is a forced interleaving. The test holds SELECT ... FOR
 * UPDATE on A's Recipient row from its own connection, the row both the
 * rejection and the admin edit write. It fires A's rejection, waits until it is
 * queued on the lock, fires the edit, waits until that is queued too, and only
 * then releases the lock, so the rejection commits first and the edit runs
 * against a recipient who has rejected.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  adminSession,
  auditRows,
  auditRowsForRecipient,
  envelopeRow,
  expectOk,
  expectRefused,
  keepRecord,
  outsideSweepWindow,
  type Reply,
  recipientRow,
  reject,
  runSealJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  trpcRaw,
  waitForSealJobsIdle,
  waitForStatus,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

const REASON = 'A rejects in the C28 spec';

const makeCc = async (admin: Awaited<ReturnType<typeof adminSession>>, recipientId: number, retry = true) =>
  await trpcRaw(admin, 'admin.recipient.update', { id: recipientId, role: 'CC' }, { retry });

/** Marks `recipientId` REJECTED with an audit row, as a rejection leaves it, with `role` as given. */
const seedRejection = async (seeded: Seeded, recipientId: number, role: RecipientRole) => {
  const row = await prisma.recipient.update({
    where: { id: recipientId },
    data: { signingStatus: SigningStatus.REJECTED, rejectionReason: REASON, signedAt: outsideSweepWindow(), role },
  });

  await prisma.documentAuditLog.create({
    data: {
      envelopeId: seeded.envelopeId,
      type: AUDIT.REJECTED,
      name: row.name,
      email: row.email,
      data: {
        recipientEmail: row.email,
        recipientName: row.name,
        recipientId: row.id,
        recipientRole: role,
        reason: REASON,
      },
    },
  });
};

for (const stage of ['unsealed', 'sealed'] as const) {
  test(`C28 an administrator cannot turn a recipient who rejected into a CC (${stage})`, async ({ page, request }) => {
    test.setTimeout(3 * 60_000);

    const seeded = await seedEnvelope(request);

    if (stage === 'unsealed') {
      await seedRejectedNotSealed(seeded, REASON);
    } else {
      expectOk(await reject(request, seeded, seeded.a, REASON), 'A rejects');
      await waitForStatus(seeded, DocumentStatus.REJECTED);
      await waitForSealJobsIdle(seeded);
    }

    const admin = await adminSession(page);
    const reply = await makeCc(admin, seeded.a.id);
    const a = await recipientRow(seeded.a.id);

    await keepRecord(`C28-make-cc-${stage}.json`, {
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 300),
      aRole: a?.role,
      aStatus: a?.signingStatus,
    });

    expectRefused(reply, "the admin edit turning A's rejection into a CC");
    expect.soft(a?.role, 'A is still a SIGNER').toBe(RecipientRole.SIGNER);
    expect.soft(a?.signingStatus, 'A is still REJECTED').toBe(SigningStatus.REJECTED);
    expect.soft(a?.rejectionReason, "A's reason is kept").toBe(REASON);
  });
}

test("C28 an admin edit to CC queued behind A's rejection is refused", async ({ page, request }) => {
  test.setTimeout(3 * 60_000);

  const seeded = await seedEnvelope(request);
  const admin = await adminSession(page);

  let rejection: Promise<Reply> | undefined;
  let edit: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => await tx.$queryRaw`SELECT "id" FROM "Recipient" WHERE "id" = ${seeded.a.id} FOR UPDATE`,
    async (pid) => {
      rejection = reject(request, seeded, seeded.a, REASON, false);

      const afterRejection = await waitForWaiters(pid, 1);

      edit = makeCc(admin, seeded.a.id, false);

      const afterEdit = await waitForWaiters(pid, 2);

      return { afterRejection, afterEdit };
    },
  );

  if (!rejection || !edit) {
    throw new Error('The rejection or the edit was never fired');
  }

  const [rejectReply, editReply] = await Promise.all([rejection, edit]);

  await waitForSealJobsIdle(seeded);

  const a = await recipientRow(seeded.a.id);
  const envelope = await envelopeRow(seeded);

  await keepRecord('C28-queued-edit.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    rejectReply: rejectReply.status,
    editReply: editReply.status,
    editBody: editReply.body.slice(0, 300),
    aRole: a?.role,
    aStatus: a?.signingStatus,
    status: envelope.status,
  });

  expect(waiters.afterRejection, "A's rejection was seen waiting on A's Recipient row").toBeGreaterThanOrEqual(1);
  expect(waiters.afterEdit, 'the admin edit was seen waiting behind it').toBeGreaterThanOrEqual(2);

  expectOk(rejectReply, "A's rejection");
  expectRefused(editReply, 'the admin edit queued behind the rejection');
  expect.soft(a?.role, 'A is still a SIGNER').toBe(RecipientRole.SIGNER);
  expect.soft(a?.signingStatus, 'A is REJECTED').toBe(SigningStatus.REJECTED);
  expect.soft(envelope.status, 'the envelope seals REJECTED').toBe(DocumentStatus.REJECTED);
});

/*
 * A CC seeded at send time is marked SIGNED by the send, so its refusal can come
 * from "already actioned". The second variant turns signer A, still NOT_SIGNED,
 * into a CC through the admin edit (allowed for a recipient who has not acted)
 * and then has A reject.
 */
for (const variant of ['seeded CC', 'signer made CC by the admin'] as const) {
  test(`C28 a CC recipient cannot reject (${variant})`, async ({ page, request }) => {
    test.setTimeout(3 * 60_000);

    const seeded = await seedEnvelope(request, { cc: variant === 'seeded CC' });
    let ccId: number;

    if (variant === 'seeded CC') {
      if (!seeded.cc) {
        throw new Error('The CC recipient was not seeded');
      }

      ccId = seeded.cc.id;
    } else {
      const admin = await adminSession(page);

      expectOk(await makeCc(admin, seeded.a.id), 'the admin turns A, who has not acted, into a CC');
      ccId = seeded.a.id;
    }

    const ccBefore = await prisma.recipient.findUniqueOrThrow({ where: { id: ccId } });

    expect(ccBefore.role, 'the recipient is a CC').toBe(RecipientRole.CC);

    const reply = await trpcRaw(request, 'recipient.rejectDocumentWithToken', {
      token: ccBefore.token,
      documentId: seeded.documentId,
      reason: 'The CC rejects',
    });

    await waitForSealJobsIdle(seeded);

    const cc = await recipientRow(ccId);
    const envelope = await envelopeRow(seeded);
    const rejections = await auditRowsForRecipient(seeded.envelopeId, AUDIT.REJECTED, ccId);

    await keepRecord(`C28-cc-rejects-${variant.replace(/ /g, '-')}.json`, {
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 300),
      ccStatusBefore: ccBefore.signingStatus,
      ccStatus: cc?.signingStatus,
      ccReason: cc?.rejectionReason,
      status: envelope.status,
      rejectionRows: rejections.length,
    });

    expectRefused(reply, "the CC's rejection");
    expect.soft(cc?.signingStatus, 'the CC is unchanged').toBe(ccBefore.signingStatus);
    expect.soft(cc?.rejectionReason ?? null, 'the CC has no rejection reason').toBeNull();
    expect.soft(rejections, 'no rejection audit row names the CC').toHaveLength(0);
    expect.soft(envelope.status, 'the envelope stays PENDING').toBe(DocumentStatus.PENDING);
  });
}

for (const variant of ['rejected CC', 'rejecter made CC'] as const) {
  test(`C28 the seal keeps a REJECTED recipient REJECTED and finishes the envelope REJECTED (${variant})`, async ({
    request,
  }) => {
    test.setTimeout(3 * 60_000);

    const seeded = await seedEnvelope(request, { cc: true });

    if (!seeded.cc) {
      throw new Error('The CC recipient was not seeded');
    }

    // A CC who rejected: either the seeded CC, or signer A after its role became CC.
    const rejecterId = variant === 'rejected CC' ? seeded.cc.id : seeded.a.id;

    await seedRejection(seeded, rejecterId, RecipientRole.CC);

    const seal = await runSealJob(seeded);

    await waitForSealJobsIdle(seeded);

    const rejecter = await recipientRow(rejecterId);
    const envelope = await envelopeRow(seeded);
    const completedRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED);

    await keepRecord(`C28-seal-${variant.replace(/ /g, '-')}.json`, {
      envelopeId: seeded.envelopeId,
      seal: seal.status,
      sealBody: seal.body.slice(0, 300),
      rejecterStatus: rejecter?.signingStatus,
      rejecterRole: rejecter?.role,
      status: envelope.status,
      completedRows: completedRows.map((row) => row.data),
    });

    expect.soft(seal.status, `the seal answers OK: ${seal.body.slice(0, 300)}`).toBe(200);
    expect.soft(rejecter?.signingStatus, 'the rejecter is still REJECTED, never SIGNED').toBe(SigningStatus.REJECTED);
    expect.soft(envelope.status, 'the envelope finishes REJECTED').toBe(DocumentStatus.REJECTED);
    expect.soft(completedRows, 'one completion row').toHaveLength(1);
  });
}
