/**
 * A cancelled envelope stays cancelled and silent.
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md)
 * before any fix, without reading the seal, cancel or recipient write paths.
 * Envelopes are seeded through API v2; the owner cancels through
 * POST /envelope/cancel (or the bulk route), recipients act through their own
 * tRPC routes, and the seal job runs inside the server through its signed job
 * endpoint, as seal-document-job.spec.ts does. The outcome is read from the
 * database (envelope status and completedAt, item documentDataId, DocumentData
 * rows, audit rows, BackgroundJob rows) and from a local webhook receiver the
 * team's webhook points at, subscribed to DOCUMENT_COMPLETED, DOCUMENT_REJECTED
 * and DOCUMENT_CANCELLED.
 *
 * | Criterion | Test                                                                   |
 * | --------- | ---------------------------------------------------------------------- |
 * | C10       | C10 a rejected envelope before its seal: the cancel is refused, REJECTED |
 * | C11       | C11 cancelling a signed envelope before its seal keeps it cancelled     |
 * | C12       | C12 a cancelled envelope is never resealed (admin route and job); the   |
 * |           | rejected half seeds legacy CANCELLED-with-REJECTED data directly        |
 * | C13       | C13 cancel and seal together (signed / rejected; cancel or seal queued   |
 * |           | first on the Envelope row lock, with the sealed copy staged); on a      |
 * |           | rejected envelope the seal always wins (decision of 18 October 2026)    |
 * | C14       | C14 two cancels together / cancel and bulk cancel together              |
 * | C15       | C15 cancel and B's completion together                                  |
 * | C15, #134 | C15 B's field sign waits on the envelope lock while the cancel commits  |
 * | C16       | C16 control: an envelope that is not cancelled seals and tells everyone |
 *
 * Decision of 18 October 2026 (after C37): a committed rejection fixes the
 * outcome. Once any recipient is REJECTED the cancel is refused and the seal
 * finishes the envelope REJECTED, so C10 and the rejected half of C13 expect
 * that; the signed half of C13 still lets whichever commits first win.
 *
 * Needs the server started with NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS=127.0.0.1,
 * since the receiver is a local HTTP server. "Nothing happened" assertions wait
 * QUIET_WINDOW_MS after the seal jobs are idle, for a late webhook or email job.
 * Runs in the `ui` project because C12 and C14 use a signed-in session.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  adminSession,
  auditRows,
  auditRowsForRecipient,
  cancelEnvelope,
  complete,
  createOwner,
  dataRowsSince,
  emailRows,
  envelopeRow,
  expectOk,
  fieldAuditRows,
  fieldRow,
  isSuccess,
  itemDataIds,
  JOB,
  jobsFor,
  keepRecord,
  type Outcome,
  pause,
  QUIET_WINDOW_MS,
  REJECTION_REASON,
  type Receiver,
  type Reply,
  rateLimited,
  recipientRow,
  replyVerdict,
  runIterations,
  runSealJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  seedSignedNotSealed,
  sessionFor,
  signV2,
  startReceiver,
  time,
  trpcRaw,
  unreferencedDataSince,
  verdictOf,
  waitForSealJobsIdle,
  waitForStatus,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

let receiver: Receiver;

test.beforeAll(async () => {
  receiver = await startReceiver();
});

test.afterAll(async () => {
  await receiver.close();
});

type State = 'rejected' | 'signed';

const seedState = async (seeded: Seeded, state: State) => {
  if (state === 'rejected') {
    await seedRejectedNotSealed(seeded);
  } else {
    await seedSignedNotSealed(seeded);
  }
};

/** Everything that tells anyone the envelope finished, read after the quiet window. */
const silenceOf = async (seeded: Seeded) => ({
  completedAuditRows: (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED)).length,
  completedDeliveries: receiver.count(seeded.envelopeId, 'DOCUMENT_COMPLETED'),
  rejectedDeliveries: receiver.count(seeded.envelopeId, 'DOCUMENT_REJECTED'),
  completedEmailJobs: (await jobsFor(JOB.COMPLETED_EMAILS, 'envelopeId', seeded.envelopeId)).length,
  completedEmailRows: (await emailRows(seeded.envelopeId, 'DOCUMENT_COMPLETED')).length,
  archiveJobs: (await jobsFor(JOB.ARCHIVE, 'envelopeId', seeded.envelopeId)).length,
});

const settle = async (seeded: Seeded) => {
  await waitForSealJobsIdle(seeded);
  await pause(QUIET_WINDOW_MS);
};

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

/**
 * C10, as decided on 18 October 2026: on "rejected but not yet sealed" the
 * owner's cancel is refused, and the seal job then finishes the envelope
 * REJECTED. Nothing records or announces a cancel.
 */
test('C10 cancelling a rejected envelope before its seal is refused, and the seal finishes it REJECTED', async ({
  request,
}) => {
  test.setTimeout(180_000);

  const seeded = await seedEnvelope(request, { receiver });

  await seedState(seeded, 'rejected');

  const cancelReply = await cancelEnvelope(request, seeded);
  const afterCancel = await envelopeRow(seeded);
  const job = await runSealJob(seeded);

  await settle(seeded);

  const envelope = await envelopeRow(seeded);
  const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
  // Under G4 C108 the seal queues the rejection's own cancellation email, carrying the rejection reason. C10 is
  // about the owner's refused cancel, so only a cancellation-email job for any other reason counts against it.
  const allCancelEmailJobs = await jobsFor(JOB.CANCELLED_EMAILS, 'documentId', seeded.documentId);
  const isRejectionsOwn = (row: (typeof allCancelEmailJobs)[number]) =>
    (row.payload as { cancellationReason?: string } | null)?.cancellationReason === REJECTION_REASON;
  const cancelEmailJobs = allCancelEmailJobs.filter((row) => !isRejectionsOwn(row));
  const rejectionEmailJobs = allCancelEmailJobs.filter(isRejectionsOwn);

  await keepRecord('C10-outcome.json', {
    cancelReply: cancelReply.status,
    cancelBody: cancelReply.body.slice(0, 300),
    statusAfterCancel: afterCancel.status,
    job,
    envelope,
    cancelRows: cancelRows.length,
    cancelEmailJobs: cancelEmailJobs.length,
    rejectionEmailJobs: rejectionEmailJobs.length,
    cancelledDeliveries: receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED'),
    rejectedDeliveries: receiver.count(seeded.envelopeId, 'DOCUMENT_REJECTED'),
  });

  expect
    .soft(cancelReply.status, `the cancel is refused with a 4xx: ${cancelReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect
    .soft(cancelReply.status, `the cancel is refused with a 4xx: ${cancelReply.body.slice(0, 300)}`)
    .toBeLessThan(500);
  expect.soft(afterCancel.status, 'the refused cancel leaves the envelope PENDING').toBe(DocumentStatus.PENDING);
  expect.soft(job.status, `the seal job run answers OK: ${job.body.slice(0, 300)}`).toBe(200);
  expect.soft(envelope.status, 'the seal finishes the envelope REJECTED').toBe(DocumentStatus.REJECTED);
  expect.soft(cancelRows, 'no DOCUMENT_CANCELLED audit row').toHaveLength(0);
  expect.soft(cancelEmailJobs, 'no cancellation-email job for the refused cancel').toHaveLength(0);
  expect.soft(rejectionEmailJobs, "C108: the seal queues the rejection's own cancellation email once").toHaveLength(1);
  expect.soft(receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED'), 'no DOCUMENT_CANCELLED delivery').toBe(0);
});

for (const [criterion, state] of [['C11', 'signed']] as const) {
  test(`${criterion} cancelling a ${state} envelope before its seal keeps it cancelled and silent`, async ({
    request,
  }) => {
    test.setTimeout(180_000);

    const seeded = await seedEnvelope(request, { receiver });

    await seedState(seeded, state);

    const dataBefore = await itemDataIds(seeded);

    expectOk(await cancelEnvelope(request, seeded), 'the owner cancels');

    const cancelled = await envelopeRow(seeded);

    expect(cancelled.status).toBe(DocumentStatus.CANCELLED);

    const since = new Date();
    const job = await runSealJob(seeded);

    await settle(seeded);

    const jobRow = await jobsFor(JOB.SEAL, 'documentId', seeded.documentId);
    const envelope = await envelopeRow(seeded);
    const silence = await silenceOf(seeded);

    await keepRecord(`${criterion}-outcome.json`, { job, jobRows: jobRow, envelope, silence });

    expect.soft(job.status, `the seal job run answers OK: ${job.body.slice(0, 300)}`).toBe(200);
    expect
      .soft(
        jobRow.map((row) => row.status),
        'the seal job completed',
      )
      .toEqual(['COMPLETED']);
    expect.soft(jobRow[0]?.retried, 'the seal job was not retried').toBe(0);

    expect.soft(envelope.status, 'the envelope stays CANCELLED').toBe(DocumentStatus.CANCELLED);
    expect.soft(envelope.completedAt, "completedAt is the cancel's").toEqual(cancelled.completedAt);
    expect.soft(silence.completedAuditRows, 'no DOCUMENT_COMPLETED audit row').toBe(0);
    expect.soft(receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED'), 'one DOCUMENT_CANCELLED delivery').toBe(1);
    expect.soft(silence.completedDeliveries, 'no DOCUMENT_COMPLETED delivery').toBe(0);
    expect.soft(silence.rejectedDeliveries, 'no DOCUMENT_REJECTED delivery').toBe(0);
    expect.soft(silence.completedEmailJobs, 'no send.document.completed.emails job').toBe(0);
    expect.soft(silence.completedEmailRows, 'no DOCUMENT_COMPLETED email row').toBe(0);
    expect.soft(await itemDataIds(seeded), 'each envelope item keeps its documentDataId').toEqual(dataBefore);
    expect.soft(await unreferencedDataSince(seeded, since), 'no orphaned sealed copy').toEqual([]);
  });
}

/**
 * Legacy data for C12: an envelope CANCELLED while a recipient is REJECTED.
 * After the C37 fix no route can produce this state, but rows written before
 * the fix exist, so the test writes it directly, as the cancel route wrote it:
 * status CANCELLED with completedAt, and a DOCUMENT_CANCELLED audit row.
 */
const seedLegacyCancelledRejected = async (seeded: Seeded) => {
  await prisma.envelope.update({
    where: { id: seeded.envelopeId },
    data: { status: DocumentStatus.CANCELLED, completedAt: new Date() },
  });
  await prisma.documentAuditLog.create({
    data: {
      envelopeId: seeded.envelopeId,
      type: AUDIT.DOCUMENT_CANCELLED,
      userId: seeded.userId,
      email: seeded.userEmail,
      data: { reason: 'G1 legacy cancel' },
    },
  });
};

test('C12 a cancelled envelope is never resealed, through the admin route or the job', async ({ page, request }) => {
  test.setTimeout(10 * 60_000);

  const admin = await adminSession(page);
  const problems: string[] = [];

  for (const state of ['rejected', 'signed'] as const) {
    for (const via of ['admin route', 'job with isResealing'] as const) {
      const seeded = await seedEnvelope(request, { receiver });

      await seedState(seeded, state);

      if (state === 'rejected') {
        await seedLegacyCancelledRejected(seeded);
      } else {
        expectOk(await cancelEnvelope(request, seeded), `${state}/${via}: the owner cancels`);
      }

      const cancelled = await envelopeRow(seeded);
      const dataBefore = await itemDataIds(seeded);
      const since = new Date();

      let reply: { status: number; body: string };

      if (via === 'admin route') {
        reply = await trpcRaw(admin, 'admin.document.reseal', { id: seeded.envelopeId });
      } else {
        reply = await runSealJob(seeded, { isResealing: true });
      }

      await settle(seeded);

      const envelope = await envelopeRow(seeded);
      const silence = await silenceOf(seeded);
      const newData = await dataRowsSince(seeded, since);
      const items = await itemDataIds(seeded);

      const record = { state, via, reply: reply.status, status: envelope.status, silence, newData, items, dataBefore };

      await keepRecord(`C12-${state}-${via.replace(/ /g, '-')}.json`, record);

      const label = `${state}/${via}`;
      const isRefused = reply.status >= 400 && reply.status < 500;

      if (via === 'admin route' && !isRefused) {
        problems.push(`${label}: the admin reseal answered ${reply.status}, expected a 4xx`);
      }

      if (via === 'job with isResealing' && reply.status >= 500) {
        problems.push(`${label}: the job answered ${reply.status}`);
      }

      if (envelope.status !== DocumentStatus.CANCELLED) {
        problems.push(`${label}: the envelope is ${envelope.status}, expected CANCELLED`);
      }

      if (envelope.completedAt?.getTime() !== cancelled.completedAt?.getTime()) {
        problems.push(`${label}: completedAt moved`);
      }

      if (silence.completedDeliveries + silence.rejectedDeliveries > 0) {
        problems.push(
          `${label}: ${silence.completedDeliveries} DOCUMENT_COMPLETED and ${silence.rejectedDeliveries} DOCUMENT_REJECTED deliveries`,
        );
      }

      if (silence.completedAuditRows > 0) {
        problems.push(`${label}: ${silence.completedAuditRows} DOCUMENT_COMPLETED audit row(s)`);
      }

      if (silence.completedEmailJobs + silence.completedEmailRows > 0) {
        problems.push(`${label}: a completed email was queued or sent`);
      }

      if (silence.archiveJobs > 0) {
        problems.push(`${label}: ${silence.archiveJobs} archive job(s)`);
      }

      if (newData.length > 0 || JSON.stringify(items) !== JSON.stringify(dataBefore)) {
        problems.push(`${label}: ${newData.length} new DocumentData row(s); items now ${JSON.stringify(items)}`);
      }
    }
  }

  expect(problems, 'C12: a cancelled envelope was resealed or announced').toEqual([]);
});

// ---------------------------------------------------------------------------
// Interleaved
// ---------------------------------------------------------------------------

/** The C13 judgement: whichever of the cancel and the seal won, it won cleanly. */
const judgeC13 = async (
  seeded: Seeded,
  state: State,
  cancelReply: Reply,
  sealReply: { status: number },
  dataBefore: Awaited<ReturnType<typeof itemDataIds>>,
  since: Date,
) => {
  await settle(seeded);

  const envelope = await envelopeRow(seeded);
  const silence = await silenceOf(seeded);
  const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
  const cancelDeliveries = receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED');
  const items = await itemDataIds(seeded);
  const orphans = await unreferencedDataSince(seeded, since);
  const sealedStatus = state === 'signed' ? DocumentStatus.COMPLETED : DocumentStatus.REJECTED;
  const completionEvent = state === 'signed' ? 'DOCUMENT_COMPLETED' : 'DOCUMENT_REJECTED';
  const completionDeliveries = receiver.count(seeded.envelopeId, completionEvent);

  const record = {
    envelopeId: seeded.envelopeId,
    cancelReply: cancelReply.status,
    sealReply: sealReply.status,
    status: envelope.status,
    cancelRows: cancelRows.length,
    cancelDeliveries,
    completionDeliveries,
    silence,
    itemsChanged: JSON.stringify(items) !== JSON.stringify(dataBefore),
    orphans,
  };

  const problems: Array<string | null> = [];

  // Decision of 18 October 2026: a committed rejection fixes the outcome, so on a rejected envelope only the seal wins.
  if (state === 'rejected' && envelope.status !== sealedStatus) {
    problems.push(`a cancel won over a committed rejection: the envelope ended ${envelope.status}`);
  }

  if (envelope.status === sealedStatus) {
    problems.push(isSuccess(cancelReply) ? `the seal won but the cancel answered ${cancelReply.status}` : null);
    problems.push(replyVerdict(cancelReply, false, 'the cancel'));
    problems.push(cancelRows.length === 0 ? null : `seal won with ${cancelRows.length} DOCUMENT_CANCELLED row(s)`);
    problems.push(cancelDeliveries === 0 ? null : `seal won with ${cancelDeliveries} DOCUMENT_CANCELLED delivery`);
    problems.push(completionDeliveries === 1 ? null : `seal won with ${completionDeliveries} ${completionEvent}`);
  } else if (envelope.status === DocumentStatus.CANCELLED) {
    problems.push(replyVerdict(cancelReply, true, 'the cancel'));
    problems.push(silence.completedAuditRows === 0 ? null : 'cancel won with a DOCUMENT_COMPLETED audit row');
    problems.push(
      silence.completedDeliveries + silence.rejectedDeliveries === 0 ? null : 'cancel won with a completion delivery',
    );
    problems.push(
      silence.completedEmailJobs + silence.completedEmailRows === 0 ? null : 'cancel won with a completed email',
    );
    problems.push(record.itemsChanged ? 'cancel won but an item documentDataId changed' : null);
    problems.push(orphans.length === 0 ? null : `cancel won with ${orphans.length} orphaned DocumentData row(s)`);
  } else {
    problems.push(`the envelope ended ${envelope.status}`);
  }

  problems.push(sealReply.status >= 500 ? `the seal job answered ${sealReply.status}` : null);

  return { problems, record };
};

/** The initialData keys of the envelope's items, which every sealed copy of them carries. */
const initialDataOf = async (seeded: Seeded) =>
  (
    await prisma.envelopeItem.findMany({ where: { envelopeId: seeded.envelopeId }, include: { documentData: true } })
  ).map((item) => item.documentData.initialData);

/** Sealed copies of the envelope's items written since `since` that no item references yet. */
const stagedCopiesSince = async (initialData: string[], since: Date) =>
  await prisma.documentData.count({
    where: { initialData: { in: initialData }, createdAt: { gte: since }, envelopeItem: null },
  });

/*
 * C13 is a forced interleaving in both orders. The test holds SELECT ... FOR
 * UPDATE on the Envelope row from its own connection. The seal's commit opens
 * with a conditional UPDATE of that row, after it has built and stored its
 * sealed copy, and the cancel writes the same row. The test waits until both
 * are queued on the lock and the sealed copy is stored (a DocumentData row with
 * the envelope's initialData that no item references), which proves the seal
 * reached its commit after staging, and only then releases the lock. The
 * envelope is given a qrToken first, so the seal's first write to the row is
 * its commit rather than the qrToken it would otherwise set before building.
 */
for (const state of ['signed', 'rejected'] as const) {
  for (const order of ['cancel queued first', 'seal queued first'] as const) {
    test(`C13 cancel and the seal job together on a ${state} envelope (${order}): one of them wins, cleanly`, async ({
      request,
    }) => {
      test.setTimeout(5 * 60_000);

      const seeded = await seedEnvelope(request, { receiver });

      await seedState(seeded, state);
      await prisma.envelope.updateMany({
        where: { id: seeded.envelopeId, qrToken: null },
        data: { qrToken: `qr_g1c13${Date.now()}` },
      });

      const initialData = await initialDataOf(seeded);
      const dataBefore = await itemDataIds(seeded);
      const since = new Date();

      let cancel: Promise<Reply> | undefined;
      let seal: ReturnType<typeof runSealJob> | undefined;

      const barrier = await withLock(
        async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
        async (pid) => {
          if (order === 'cancel queued first') {
            cancel = cancelEnvelope(request, seeded, false);

            const first = await waitForWaiters(pid, 1);

            seal = runSealJob(seeded);

            const second = await waitForWaiters(pid, 2, 60_000);

            return { first, second, staged: await stagedCopiesSince(initialData, since) };
          }

          seal = runSealJob(seeded);

          const first = await waitForWaiters(pid, 1, 60_000);
          const staged = await stagedCopiesSince(initialData, since);

          cancel = cancelEnvelope(request, seeded, false);

          const second = await waitForWaiters(pid, 2);

          return { first, second, staged };
        },
      );

      if (!cancel || !seal) {
        throw new Error('The cancel or the seal was never fired');
      }

      const [cancelReply, sealReply] = await Promise.all([cancel, seal]);

      expect(cancelReply.status, 'the cancel was not rate-limited').not.toBe(429);

      const { problems, record } = await judgeC13(seeded, state, cancelReply, sealReply, dataBefore, since);

      await keepRecord(`C13-${state}-${order.replace(/ /g, '-')}.json`, { barrier, ...record, problems });

      expect(barrier.first, 'the first request was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
      expect(barrier.second, 'the second request was seen waiting behind it').toBeGreaterThanOrEqual(2);
      expect(barrier.staged, 'the seal stored its sealed copy before it reached its commit').toBeGreaterThanOrEqual(
        initialData.length,
      );
      expect(
        problems.filter((problem) => problem !== null),
        `C13-${state} (${order})`,
      ).toEqual([]);
    });
  }
}

test('C14 two cancels together: exactly one lands', async ({ request }) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C14-two-cancels', async (): Promise<Outcome> => {
    const seeded = await seedEnvelope(request, { receiver });

    const [first, second] = await Promise.all([
      cancelEnvelope(request, seeded, false),
      cancelEnvelope(request, seeded, false),
    ]);

    const limited = rateLimited(seeded, { first, second });

    if (limited) {
      return limited;
    }

    await pause(QUIET_WINDOW_MS);

    const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
    const deliveries = receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED');
    const emailJobs = await jobsFor(JOB.CANCELLED_EMAILS, 'documentId', seeded.documentId);
    const successes = [first, second].filter(isSuccess).length;

    const record = {
      envelopeId: seeded.envelopeId,
      first: first.status,
      second: second.status,
      cancelRows: cancelRows.length,
      deliveries,
      emailJobs: emailJobs.length,
    };

    return {
      verdict: verdictOf(
        successes === 1 ? null : `${successes} cancels succeeded, expected 1`,
        [first, second].some((reply) => reply.status >= 500) ? 'a cancel answered 5xx' : null,
        [first, second].every((reply) => isSuccess(reply) || (reply.status >= 400 && reply.status < 500))
          ? null
          : 'a cancel answered neither 2xx nor 4xx',
        cancelRows.length === 1 ? null : `${cancelRows.length} DOCUMENT_CANCELLED audit rows`,
        deliveries === 1 ? null : `${deliveries} DOCUMENT_CANCELLED deliveries`,
        emailJobs.length === 1 ? null : `${emailJobs.length} send.document.cancelled.emails jobs`,
      ),
      record,
    };
  });
});

test('C14 a cancel and a bulk cancel naming the same envelope: exactly one lands', async ({ page, request }) => {
  test.setTimeout(15 * 60_000);

  const owner = await createOwner(receiver);
  const session = await sessionFor(page, owner.user.email);

  await runIterations('C14-bulk', async (): Promise<Outcome> => {
    const seeded = await seedEnvelope(request, { owner });

    const [single, bulk] = await Promise.all([
      cancelEnvelope(request, seeded, false),
      trpcRaw(
        session,
        'envelope.bulk.cancel',
        { envelopeIds: [seeded.envelopeId], reason: 'G1 bulk cancel' },
        { retry: false, teamId: seeded.teamId },
      ),
    ]);

    const limited = rateLimited(seeded, { single, bulk });

    if (limited) {
      return limited;
    }

    await pause(QUIET_WINDOW_MS);

    const parsed = (() => {
      try {
        return (
          JSON.parse(bulk.body) as { result?: { data?: { json?: { cancelledCount: number; failedIds: string[] } } } }
        ).result?.data?.json;
      } catch {
        return undefined;
      }
    })();

    const bulkLanded = isSuccess(bulk) && parsed?.cancelledCount === 1 && !parsed.failedIds.includes(seeded.envelopeId);
    const bulkRefused =
      (isSuccess(bulk) && parsed?.failedIds.includes(seeded.envelopeId) === true) ||
      (bulk.status >= 400 && bulk.status < 500);
    const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
    const deliveries = receiver.count(seeded.envelopeId, 'DOCUMENT_CANCELLED');
    const emailJobs = await jobsFor(JOB.CANCELLED_EMAILS, 'documentId', seeded.documentId);
    const landed = (isSuccess(single) ? 1 : 0) + (bulkLanded ? 1 : 0);

    const record = {
      envelopeId: seeded.envelopeId,
      single: single.status,
      bulk: bulk.status,
      bulkResult: parsed ?? bulk.body.slice(0, 200),
      cancelRows: cancelRows.length,
      deliveries,
      emailJobs: emailJobs.length,
    };

    return {
      verdict: verdictOf(
        landed === 1 ? null : `${landed} of the two cancels reported success, expected 1`,
        single.status >= 500 || bulk.status >= 500 ? 'a cancel answered 5xx' : null,
        isSuccess(single) || (single.status >= 400 && single.status < 500) ? null : 'the single cancel answered oddly',
        bulkLanded || bulkRefused ? null : 'the bulk cancel neither landed nor listed a failure',
        cancelRows.length === 1 ? null : `${cancelRows.length} DOCUMENT_CANCELLED audit rows`,
        deliveries === 1 ? null : `${deliveries} DOCUMENT_CANCELLED deliveries`,
        emailJobs.length === 1 ? null : `${emailJobs.length} send.document.cancelled.emails jobs`,
      ),
      record,
    };
  });
});

/**
 * C15. B's write either landed before the cancel (its audit row no later than
 * the DOCUMENT_CANCELLED row, and the cancel still succeeded) or was refused
 * with a 4xx and left B and its field as they were. When the envelope ends
 * CANCELLED with B SIGNED, nothing announces a completion.
 */
for (const variant of ['complete'] as const) {
  test(`C15 cancel and B's ${variant === 'complete' ? 'completion' : 'field sign'} together`, async ({ request }) => {
    test.setTimeout(30 * 60_000);

    const race = (variant: 'complete' | 'sign') => async (): Promise<Outcome> => {
      const seeded = await seedEnvelope(request, { receiver });

      // A already SIGNED; for the completion race B's field is already inserted.
      expectOk(await signV2(request, seeded.a), 'A signs');
      expectOk(await complete(request, seeded, seeded.a), 'A completes');

      if (variant === 'complete') {
        expectOk(await signV2(request, seeded.b), 'B inserts its field before the race');
      }

      const fieldBefore = await fieldRow(seeded.b.fieldId);

      const [cancelReply, bReply] = await Promise.all([
        cancelEnvelope(request, seeded, false),
        variant === 'complete'
          ? complete(request, seeded, seeded.b, { retry: false })
          : signV2(request, seeded.b, undefined, false),
      ]);

      const limited = rateLimited(seeded, { cancelReply, bReply });

      if (limited) {
        return limited;
      }

      await settle(seeded);

      const envelope = await envelopeRow(seeded);
      const b = await recipientRow(seeded.b.id);
      const field = await fieldRow(seeded.b.fieldId);
      const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
      const bRows =
        variant === 'complete'
          ? await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_COMPLETED, seeded.b.id)
          : await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, seeded.b.fieldSecondaryId);
      const silence = await silenceOf(seeded);

      const bLanded = variant === 'complete' ? b?.signingStatus === SigningStatus.SIGNED : field?.inserted === true;

      const record = {
        envelopeId: seeded.envelopeId,
        variant,
        cancelReply: cancelReply.status,
        bReply: bReply.status,
        status: envelope.status,
        bStatus: b?.signingStatus,
        bFieldInserted: field?.inserted,
        cancelAt: cancelRows.map((row) => row.createdAt.toISOString()),
        bAt: bRows.map((row) => row.createdAt.toISOString()),
        silence,
      };

      const problems: Array<string | null> = [
        replyVerdict(bReply, bLanded, `B's ${variant}`),
        replyVerdict(cancelReply, envelope.status === DocumentStatus.CANCELLED, 'the cancel'),
      ];

      if (bLanded) {
        problems.push(bRows.length === 1 ? null : `B's ${variant} landed with ${bRows.length} audit row(s)`);

        if (cancelRows.length > 0) {
          problems.push(
            (time(bRows[0]) ?? Infinity) <= (time(cancelRows[0]) ?? -Infinity)
              ? null
              : `B's ${variant} audit row is later than the DOCUMENT_CANCELLED row`,
          );
        }
      } else {
        problems.push(
          b?.signingStatus === SigningStatus.NOT_SIGNED
            ? null
            : `B's ${variant} was refused but B is ${b?.signingStatus}`,
        );
        problems.push(
          field?.inserted === fieldBefore?.inserted && field?.signature?.id === fieldBefore?.signature?.id
            ? null
            : `B's ${variant} was refused but B's field changed`,
        );
      }

      if (envelope.status === DocumentStatus.CANCELLED && b?.signingStatus === SigningStatus.SIGNED) {
        problems.push(
          silence.completedDeliveries + silence.rejectedDeliveries === 0
            ? null
            : 'cancelled with B SIGNED, yet a completion was delivered',
        );
        problems.push(
          silence.completedEmailJobs + silence.completedEmailRows === 0
            ? null
            : 'cancelled with B SIGNED, yet a completed email was queued',
        );
        problems.push(
          silence.completedAuditRows === 0 ? null : 'cancelled with B SIGNED, yet a DOCUMENT_COMPLETED row',
        );
      }

      if (envelope.status !== DocumentStatus.CANCELLED && envelope.status !== DocumentStatus.COMPLETED) {
        problems.push(`the envelope ended ${envelope.status}`);
      }

      return { verdict: verdictOf(...problems), record };
    };

    await runIterations(`C15-${variant}`, race(variant));
  });
}

/**
 * C15, the field sign, with the lock window forced (#134). Fired together
 * without control, the sign always landed before the cancel, so the window in
 * which a sign that has passed its PENDING check waits on the envelope lock
 * while the cancel commits was never reached. Here the test holds
 * SELECT ... FOR UPDATE on the Envelope row from its own database connection,
 * fires the cancel and waits until it is blocked on that lock, then fires B's
 * sign and waits until it is blocked too, then commits. The cancel queued first,
 * so it takes the row first and commits; the sign then gets the lock on a
 * CANCELLED envelope. B's sign must then be refused with a 4xx and leave the
 * field as it was; a sign that lands with its insert row after the
 * DOCUMENT_CANCELLED row breaks the criterion.
 */
test("C15 B's field sign waits on the envelope lock while the cancel commits: the sign is refused", async ({
  request,
}) => {
  test.setTimeout(180_000);

  const seeded = await seedEnvelope(request, { receiver });

  expectOk(await signV2(request, seeded.a), 'A signs');
  expectOk(await complete(request, seeded, seeded.a), 'A completes');

  const fieldBefore = await fieldRow(seeded.b.fieldId);

  /**
   * Polls until `count` backends wait on `pid`, directly or behind another
   * waiter, or five seconds pass. Returns the count seen. The chain matters:
   * a second request queued for the same row is reported as blocked by the
   * first waiter, not by the lock holder.
   */
  const waitForWaiters = async (pid: number, count: number) => {
    const deadline = Date.now() + 5_000;
    let seen = 0;

    while (Date.now() < deadline) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        WITH RECURSIVE waiter(pid) AS (
          SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiter w ON w.pid = ANY(pg_blocking_pids(a.pid))
        )
        SELECT count(*)::int AS n FROM waiter`;

      seen = n;

      if (n >= count) {
        break;
      }

      await pause(50);
    }

    return seen;
  };

  let cancel: Promise<Reply> | undefined;
  let sign: Promise<Reply> | undefined;

  const waiters = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`;

      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

      cancel = cancelEnvelope(request, seeded, false);

      const afterCancel = await waitForWaiters(pid, 1);

      sign = signV2(request, seeded.b, undefined, false);

      const afterSign = await waitForWaiters(pid, 2);

      return { afterCancel, afterSign };
    },
    { timeout: 30_000, maxWait: 5_000 },
  );

  if (!cancel || !sign) {
    throw new Error('The cancel or the sign was never fired');
  }

  const [cancelReply, signReply] = await Promise.all([cancel, sign]);

  await settle(seeded);

  const envelope = await envelopeRow(seeded);
  const field = await fieldRow(seeded.b.fieldId);
  const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
  const inserts = await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, seeded.b.fieldSecondaryId);

  await keepRecord('C15-sign-forced.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    cancelReply: cancelReply.status,
    signReply: signReply.status,
    signBody: signReply.body.slice(0, 300),
    status: envelope.status,
    bFieldInserted: field?.inserted,
    cancelAt: cancelRows.map((row) => row.createdAt.toISOString()),
    insertAt: inserts.map((row) => row.createdAt.toISOString()),
  });

  expect(cancelReply.status, 'neither request was rate-limited').not.toBe(429);
  expect(signReply.status, 'neither request was rate-limited').not.toBe(429);
  expect(waiters.afterCancel, 'the cancel was seen waiting on the test lock').toBeGreaterThanOrEqual(1);
  expect(waiters.afterSign, "B's sign was seen waiting on the test lock behind the cancel").toBeGreaterThanOrEqual(2);

  expectOk(cancelReply, 'the cancel');
  expect.soft(envelope.status, 'the envelope is CANCELLED').toBe(DocumentStatus.CANCELLED);
  expect.soft(cancelRows, 'one DOCUMENT_CANCELLED row').toHaveLength(1);
  expect
    .soft(signReply.status, `B's sign is refused with a 4xx: ${signReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect.soft(signReply.status, `B's sign is refused with a 4xx: ${signReply.body.slice(0, 300)}`).toBeLessThan(500);
  expect.soft(field?.inserted, "B's field stays uninserted").toBe(fieldBefore?.inserted);
  expect.soft(field?.signature?.id, "B's field has no new signature").toBe(fieldBefore?.signature?.id);
  expect.soft(inserts, 'no DOCUMENT_FIELD_INSERTED row after the cancel').toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

test('C16 control: an envelope that is not cancelled seals COMPLETED and tells everyone once', async ({
  page,
  request,
}) => {
  test.setTimeout(5 * 60_000);

  const seeded = await seedEnvelope(request, { receiver });

  expectOk(await signV2(request, seeded.a), 'A signs');
  expectOk(await complete(request, seeded, seeded.a), 'A completes');
  expectOk(await signV2(request, seeded.b), 'B signs');
  expectOk(await complete(request, seeded, seeded.b), 'B completes');

  await waitForStatus(seeded, DocumentStatus.COMPLETED);
  await settle(seeded);

  await expect.poll(() => receiver.count(seeded.envelopeId, 'DOCUMENT_COMPLETED'), { timeout: 30_000 }).toBe(1);

  for (const signer of [seeded.a, seeded.b]) {
    expect(
      await emailRows(seeded.envelopeId, 'DOCUMENT_COMPLETED', signer.id),
      `one completed email row for ${signer.name}`,
    ).toHaveLength(1);
  }

  expect(await jobsFor(JOB.COMPLETED_EMAILS, 'envelopeId', seeded.envelopeId), 'one completed-emails job').toHaveLength(
    1,
  );
  expect(await jobsFor(JOB.ARCHIVE, 'envelopeId', seeded.envelopeId), 'one archive job').toHaveLength(1);

  // A retried seal leaves the document as it was and still tells the team (seal-document-job criteria 2 and 3).
  const dataBefore = await itemDataIds(seeded);
  const completedBefore = (await envelopeRow(seeded)).completedAt;
  const retry = await runSealJob(seeded);

  expect(retry.status, 'the retried seal answers OK').toBe(200);
  await settle(seeded);
  expect(await itemDataIds(seeded), 'a retried seal keeps the documentDataId').toEqual(dataBefore);
  expect((await envelopeRow(seeded)).completedAt, 'a retried seal keeps completedAt').toEqual(completedBefore);
  expect(await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED), 'still one completion row').toHaveLength(1);
  await expect.poll(() => receiver.count(seeded.envelopeId, 'DOCUMENT_COMPLETED'), { timeout: 30_000 }).toBe(2);

  // An administrator can reseal it (seal-document-job criterion 4).
  const admin = await adminSession(page);

  expectOk(await trpcRaw(admin, 'admin.document.reseal', { id: seeded.envelopeId }), 'the admin reseal');
  await expect.poll(async () => await itemDataIds(seeded), { timeout: 60_000 }).not.toEqual(dataBefore);
  await expect
    .poll(async () => (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED)).length, { timeout: 60_000 })
    .toBe(2);
  expect((await envelopeRow(seeded)).status).toBe(DocumentStatus.COMPLETED);
});
