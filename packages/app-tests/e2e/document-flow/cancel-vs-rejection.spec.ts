/**
 * G1 round 8, C37 (black-box F2): an owner's cancel and a recipient's
 * rejection never both succeed.
 *
 * | Criterion | Test                                                                                        |
 * | --------- | ------------------------------------------------------------------------------------------- |
 * | C37 (a)   | C37 rejection commits first, then the cancel (API v2 envelope.cancel / envelope.bulk.cancel) |
 * | C37 (a)   | C37 cancel commits first, then the rejection (API v2 envelope.cancel)                        |
 *
 * (a) is forced. The test holds SELECT ... FOR UPDATE on the Envelope row from
 * its own connection, fires the first request and waits until the waiter probe
 * shows it queued on that row, fires the second and waits for it to queue
 * behind the first, then commits. Postgres hands the row to the first waiter,
 * so the first request commits before the second takes the row.
 *
 *   - Rejection first: the cancel must be refused (a 4xx; for the bulk cancel,
 *     a 4xx or a 2xx listing the envelope in failedIds), and the envelope
 *     ends REJECTED once the seal job has run, with no DOCUMENT_CANCELLED row
 *     and no cancellation-email job from the cancel.
 *   - Cancel first: the rejection must be refused with a 4xx, and the envelope
 *     ends CANCELLED with A not REJECTED.
 *
 * (b), the sequential case (A rejects, then the owner cancels before the seal
 * job runs), is not covered: nothing in the real routes holds the seal job
 * off. In the one attempt (G1/red-r8/run1) the rejection's seal job had
 * finished 73 ms before the cancel was sent, so the cancel met a REJECTED
 * envelope and the attempt proved nothing.
 *
 * The rejection itself queues a send.document.cancelled.emails job, carrying
 * the rejection reason, to tell the other recipients. A cancellation email
 * from the cancel is therefore told apart by the cancel's reason.
 *
 * API v1 has no cancel route; the cancel routes are envelope.cancel (through
 * its API v2 path, owner token) and envelope.bulk.cancel (session).
 */
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, SigningStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  auditRows,
  cancelEnvelope,
  envelopeRow,
  JOB,
  jobsFor,
  keepRecord,
  pause,
  QUIET_WINDOW_MS,
  type Reply,
  recipientRow,
  reject,
  type Seeded,
  seedEnvelope,
  sessionFor,
  trpcRaw,
  waitForSealJobsIdle,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

/** The reasons the cancel routes send: cancelEnvelope's, and the bulk cancel's below. */
const CANCEL_REASONS = ['G1 cancel', 'G1 C37 bulk cancel'];

type CancelRoute = 'API v2 envelope.cancel' | 'tRPC envelope.bulk.cancel';

const fireCancel = async (
  request: APIRequestContext,
  session: APIRequestContext | null,
  route: CancelRoute,
  seeded: Seeded,
): Promise<Reply> => {
  if (route === 'API v2 envelope.cancel' || !session) {
    return await cancelEnvelope(request, seeded, false);
  }

  return await trpcRaw(
    session,
    'envelope.bulk.cancel',
    { envelopeIds: [seeded.envelopeId], reason: 'G1 C37 bulk cancel' },
    { retry: false, teamId: seeded.teamId },
  );
};

/** The envelope, A, and every trace of a cancel, after the seal jobs are idle and a quiet window. */
const outcome = async (seeded: Seeded) => {
  await waitForSealJobsIdle(seeded);
  await pause(QUIET_WINDOW_MS);

  return {
    status: (await envelopeRow(seeded)).status,
    aStatus: (await recipientRow(seeded.a.id))?.signingStatus,
    rejectedRows: (await auditRows(seeded.envelopeId, AUDIT.REJECTED)).length,
    cancelledRows: (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED)).length,
    cancelEmailJobs: (await jobsFor(JOB.CANCELLED_EMAILS, 'documentId', seeded.documentId)).filter((job) =>
      CANCEL_REASONS.includes(String((job.payload as { cancellationReason?: unknown }).cancellationReason)),
    ).length,
  };
};

/**
 * Whether the cancel was refused. envelope.cancel must answer 4xx. The bulk
 * cancel reports per envelope in a 2xx body, so for it a 4xx or a 2xx naming
 * this envelope in failedIds with nothing cancelled is a refusal.
 */
const cancelRefused = (route: CancelRoute, reply: Reply, seeded: Seeded) => {
  if (reply.status >= 400 && reply.status < 500) {
    return true;
  }

  if (route !== 'tRPC envelope.bulk.cancel' || reply.status < 200 || reply.status >= 300) {
    return false;
  }

  const body = JSON.parse(reply.body) as {
    result?: { data?: { json?: { cancelledCount?: number; failedIds?: string[] } } };
  };
  const result = body.result?.data?.json;

  return result?.cancelledCount === 0 && (result.failedIds ?? []).includes(seeded.envelopeId);
};

const expectRejectionWon = (
  result: Awaited<ReturnType<typeof outcome>>,
  cancelReply: Reply,
  route: CancelRoute,
  seeded: Seeded,
) => {
  expect.soft(cancelReply.status, `${route}: the cancel did not fail with a 5xx`).toBeLessThan(500);
  expect
    .soft(
      cancelRefused(route, cancelReply, seeded),
      `${route}: the cancel is refused: ${cancelReply.body.slice(0, 300)}`,
    )
    .toBe(true);
  expect.soft(result.status, `${route}: the envelope ends REJECTED`).toBe(DocumentStatus.REJECTED);
  expect.soft(result.cancelledRows, `${route}: no DOCUMENT_CANCELLED row`).toBe(0);
  expect.soft(result.cancelEmailJobs, `${route}: no cancellation-email job from the cancel`).toBe(0);
};

for (const route of ['API v2 envelope.cancel', 'tRPC envelope.bulk.cancel'] as const) {
  test(`C37 (a) A's rejection commits first, then the owner's cancel (${route}): the cancel is refused`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const seeded = await seedEnvelope(request);
    const session = route === 'tRPC envelope.bulk.cancel' ? await sessionFor(page, seeded.userEmail) : null;

    let rejection: Promise<Reply> | undefined;
    let cancel: Promise<Reply> | undefined;

    const waiters = await withLock(
      async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
      async (pid) => {
        rejection = reject(request, seeded, seeded.a, 'G1 C37 rejection', false);

        const afterReject = await waitForWaiters(pid, 1);

        cancel = fireCancel(request, session, route, seeded);

        const afterCancel = await waitForWaiters(pid, 2);

        return { afterReject, afterCancel };
      },
    );

    if (!rejection || !cancel) {
      throw new Error('A request was never fired');
    }

    const [rejectReply, cancelReply] = await Promise.all([rejection, cancel]);
    const result = await outcome(seeded);

    await keepRecord('C37-a-reject-first.json', {
      route,
      envelopeId: seeded.envelopeId,
      waiters,
      rejectReply: rejectReply.status,
      cancelReply: cancelReply.status,
      cancelBody: cancelReply.body.slice(0, 300),
      ...result,
    });

    expect(waiters.afterReject, 'the rejection was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
    expect(waiters.afterCancel, 'the cancel was seen waiting behind it').toBeGreaterThanOrEqual(2);
    expect(rejectReply.status, `A's rejection succeeds: ${rejectReply.body.slice(0, 300)}`).toBe(200);
    expect(result.aStatus, 'A is REJECTED').toBe(SigningStatus.REJECTED);

    expectRejectionWon(result, cancelReply, route, seeded);
  });
}

test("C37 (a) the owner's cancel commits first, then A's rejection: the rejection is refused", async ({ request }) => {
  test.setTimeout(180_000);

  const seeded = await seedEnvelope(request);

  let cancel: Promise<Reply> | undefined;
  let rejection: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
    async (pid) => {
      cancel = cancelEnvelope(request, seeded, false);

      const afterCancel = await waitForWaiters(pid, 1);

      rejection = reject(request, seeded, seeded.a, 'G1 C37 rejection', false);

      const afterReject = await waitForWaiters(pid, 2);

      return { afterCancel, afterReject };
    },
  );

  if (!rejection || !cancel) {
    throw new Error('A request was never fired');
  }

  const [cancelReply, rejectReply] = await Promise.all([cancel, rejection]);
  const result = await outcome(seeded);

  await keepRecord('C37-a-cancel-first.json', {
    envelopeId: seeded.envelopeId,
    waiters,
    cancelReply: cancelReply.status,
    rejectReply: rejectReply.status,
    rejectBody: rejectReply.body.slice(0, 300),
    ...result,
  });

  expect(waiters.afterCancel, 'the cancel was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
  expect(waiters.afterReject, 'the rejection was seen waiting behind it').toBeGreaterThanOrEqual(2);
  expect(cancelReply.status, `the cancel succeeds: ${cancelReply.body.slice(0, 300)}`).toBe(200);

  expect
    .soft(rejectReply.status, `the rejection is refused with a 4xx: ${rejectReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect
    .soft(rejectReply.status, `the rejection is refused with a 4xx: ${rejectReply.body.slice(0, 300)}`)
    .toBeLessThan(500);
  expect.soft(result.status, 'the envelope ends CANCELLED').toBe(DocumentStatus.CANCELLED);
  expect.soft(result.aStatus, 'A is not REJECTED').not.toBe(SigningStatus.REJECTED);
  expect.soft(result.rejectedRows, 'no rejection row').toBe(0);
});
