/**
 * Two reseals of one finished envelope: one wins, and the loser leaves nothing
 * behind (G1 round 2, C30).
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md,
 * "Added after Codex round 1"). An administrator reseals an envelope that is
 * already COMPLETED or REJECTED twice at once through admin.document.reseal,
 * which queues two internal.seal-document jobs with isResealing. The outcome is
 * read from the database: DOCUMENT_COMPLETED audit rows, the item's
 * documentDataId and the DocumentData rows the reseals wrote.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | C30       | C30 two admin reseals of a completed / rejected envelope: one wins, no orphans |
 *
 * The interleaving is forced. The test holds SELECT ... FOR UPDATE on the
 * Envelope row from its own connection. The seal's commit opens with a
 * conditional UPDATE of that row (status and completedAt) before it swaps the
 * item's documentDataId, so a seal that has built and stored its sealed copy
 * waits there. The test waits until both reseals are queued on the lock and
 * both sealed copies are stored (DocumentData rows carrying the envelope's
 * initialData), which proves each seal reached its commit after staging, and
 * only then releases the lock.
 *
 * DocumentData rows are counted by the envelope's own initialData (an S3 key
 * unique to this upload, which every sealed copy of the envelope carries), so a
 * seal of another envelope running at the same time is not counted.
 */
import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  adminSession,
  auditRows,
  envelopeRow,
  expectOk,
  itemDataIds,
  JOB,
  jobsFor,
  keepRecord,
  pause,
  QUIET_WINDOW_MS,
  runSealJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  seedSignedNotSealed,
  trpcRaw,
  waitForSealJobsIdle,
  waitForStatus,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

/** The initialData keys of the envelope's items, which every sealed copy of them carries. */
const initialDataOf = async (seeded: Seeded) =>
  (
    await prisma.envelopeItem.findMany({ where: { envelopeId: seeded.envelopeId }, include: { documentData: true } })
  ).map((item) => item.documentData.initialData);

/** DocumentData rows of this envelope's items written since `since`, and those no item references. */
const sealedCopiesSince = async (initialData: string[], since: Date) => {
  const rows = await prisma.documentData.findMany({
    where: { initialData: { in: initialData }, createdAt: { gte: since } },
    select: { id: true, envelopeItem: { select: { id: true } } },
  });

  return {
    all: rows.map((row) => row.id).sort(),
    unreferenced: rows
      .filter((row) => row.envelopeItem === null)
      .map((row) => row.id)
      .sort(),
  };
};

for (const state of ['completed', 'rejected'] as const) {
  test(`C30 two admin reseals of a ${state} envelope: exactly one wins and the loser leaves no DocumentData`, async ({
    page,
    request,
  }) => {
    test.setTimeout(5 * 60_000);

    const seeded = await seedEnvelope(request);
    const terminal = state === 'completed' ? DocumentStatus.COMPLETED : DocumentStatus.REJECTED;

    if (state === 'completed') {
      await seedSignedNotSealed(seeded);
    } else {
      await seedRejectedNotSealed(seeded);
    }

    const firstSeal = await runSealJob(seeded);

    expect(firstSeal.status, `the first seal answers OK: ${firstSeal.body}`).toBe(200);
    await waitForStatus(seeded, terminal);
    await waitForSealJobsIdle(seeded);

    const admin = await adminSession(page);
    const initialData = await initialDataOf(seeded);
    const dataBefore = await itemDataIds(seeded);
    const completedRowsBefore = (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED)).length;
    const sealJobsBefore = (await jobsFor(JOB.SEAL, 'documentId', seeded.documentId)).length;
    const since = new Date();

    const barrier = await withLock(
      async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
      async (pid) => {
        // The route only queues the job, so both replies arrive while the lock is held.
        const replies = await Promise.all([
          trpcRaw(admin, 'admin.document.reseal', { id: seeded.envelopeId }, { retry: false }),
          trpcRaw(admin, 'admin.document.reseal', { id: seeded.envelopeId }, { retry: false }),
        ]);

        const waiters = await waitForWaiters(pid, 2, 60_000);
        const staged = await sealedCopiesSince(initialData, since);

        return { replies, waiters, stagedAtBarrier: staged.unreferenced.length };
      },
    );

    for (const [index, reply] of barrier.replies.entries()) {
      expectOk(reply, `admin reseal ${index + 1}`);
    }

    await waitForSealJobsIdle(seeded);
    await pause(QUIET_WINDOW_MS);
    await waitForSealJobsIdle(seeded);

    const envelope = await envelopeRow(seeded);
    const items = await itemDataIds(seeded);
    const copies = await sealedCopiesSince(initialData, since);
    const completedRows = (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED)).length - completedRowsBefore;
    const sealJobs = (await jobsFor(JOB.SEAL, 'documentId', seeded.documentId)).slice(sealJobsBefore);

    await keepRecord(`C30-${state}.json`, {
      envelopeId: seeded.envelopeId,
      waiters: barrier.waiters,
      stagedAtBarrier: barrier.stagedAtBarrier,
      status: envelope.status,
      dataBefore,
      items,
      copiesWritten: copies.all,
      copiesUnreferenced: copies.unreferenced,
      newCompletedRows: completedRows,
      sealJobs: sealJobs.map((job) => ({ id: job.id, status: job.status, retried: job.retried })),
    });

    // The barrier: both reseals queued on the Envelope row with their sealed copies already stored.
    expect(barrier.waiters, 'both reseals were seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(2);
    expect(barrier.stagedAtBarrier, 'both sealed copies were stored before either commit ran').toBeGreaterThanOrEqual(
      2 * initialData.length,
    );

    expect.soft(envelope.status, `the envelope stays ${terminal}`).toBe(terminal);
    expect.soft(completedRows, 'exactly one reseal wins: one new DOCUMENT_COMPLETED row').toBe(1);
    expect.soft(items, 'the item points at a sealed copy written by the race').not.toEqual(dataBefore);
    expect
      .soft(
        items.every((id) => copies.all.includes(id)),
        'the item points at a sealed copy written by the race',
      )
      .toBe(true);
    expect.soft(copies.unreferenced, "no DocumentData row is left over from the loser's sealed copy").toEqual([]);
  });
}
