/**
 * G1 round 2, C25: a cancel that lands between a send's unlocked status read
 * and its transaction is never overwritten by that send.
 *
 * | Criterion | Test                                                                               |
 * | --------- | ---------------------------------------------------------------------------------- |
 * | C25       | C25 a cancel between the API v1 send's read and its transaction wins                |
 * | C25       | C25 a cancel between the tRPC envelope.distribute read and its transaction wins     |
 *
 * The interleaving is forced with the real cancel route. The test holds
 * SELECT ... FOR UPDATE on the Envelope row from its own connection. It fires
 * the cancel, which reads PENDING and queues on that row with its conditional
 * status update, and waits until it is a waiter. It then fires the send, which
 * reads PENDING outside any lock and queues on the same row behind the cancel,
 * and waits for that second waiter. Then the test commits. Postgres hands the
 * row to the cancel first, so the cancel commits CANCELLED after the send's
 * read and before the send writes anything to the envelope.
 *
 * Passing means the send is refused with a 4xx, the envelope stays CANCELLED,
 * and no signing-request job or SIGNING_REQUEST EMAIL_SENT row appears after
 * the DOCUMENT_CANCELLED row. On 0c875745c the send instead wrote PENDING back
 * unconditionally after a CANCELLED commit (G1/red-r2/new, both C25 tests:
 * "expected CANCELLED, received PENDING").
 */
import { expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  AUDIT,
  auditRows,
  cancelEnvelope,
  emailRows,
  envelopeRow,
  expectOk,
  JOB,
  jobsFor,
  keepRecord,
  pause,
  QUIET_WINDOW_MS,
  type Reply,
  type Seeded,
  seedEnvelope,
  send,
  sessionFor,
  time,
  trpcRaw,
} from '../fixtures/reject-seal';
import { jsonHeaders, V1_URL } from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

type Route = 'API v1 send' | 'tRPC envelope.distribute';

const ROUTES: Route[] = ['API v1 send', 'tRPC envelope.distribute'];

for (const route of ROUTES) {
  test(`C25 a cancel between the ${route}'s read and its transaction wins: the send is refused`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const seeded: Seeded = await seedEnvelope(request);

    expect((await envelopeRow(seeded)).status, 'premise: the envelope is PENDING').toBe(DocumentStatus.PENDING);

    const session = route === 'tRPC envelope.distribute' ? await sessionFor(page, seeded.userEmail) : null;

    const fireSend = async (): Promise<Reply> => {
      if (session) {
        return await trpcRaw(
          session,
          'envelope.distribute',
          { envelopeId: seeded.envelopeId },
          { retry: false, teamId: seeded.teamId },
        );
      }

      return await send(
        async () =>
          await request.post(`${V1_URL}/documents/${seeded.documentId}/send`, {
            headers: jsonHeaders(seeded.apiToken),
            data: { sendEmail: true },
          }),
        'API v1 send',
        false,
      );
    };

    let cancelReply: Promise<Reply> | undefined;
    let sendReply: Promise<Reply> | undefined;

    const barrier = await withLock(
      async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${seeded.envelopeId} FOR UPDATE`,
      async (pid) => {
        cancelReply = cancelEnvelope(request, seeded, false);

        const cancelWaiting = await waitForWaiters(pid, 1);

        sendReply = fireSend();

        const sendWaiting = await waitForWaiters(pid, 2);

        return { cancelWaiting, sendWaiting };
      },
    );

    if (!cancelReply || !sendReply) {
      throw new Error('The cancel or the send was never fired');
    }

    const [cancel, reply] = await Promise.all([cancelReply, sendReply]);

    await pause(QUIET_WINDOW_MS);

    const envelope = await envelopeRow(seeded);
    const cancelRows = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED);
    const cancelledAt = time(cancelRows[0]) ?? 0;
    const signingJobsAfter = (await jobsFor(JOB.SIGNING_EMAIL, 'documentId', seeded.documentId)).filter(
      (job) => job.submittedAt.getTime() > cancelledAt,
    );
    const signingRowsAfter = (await emailRows(seeded.envelopeId, 'SIGNING_REQUEST')).filter(
      (row) => row.createdAt.getTime() > cancelledAt,
    );

    await keepRecord('C25.json', {
      route,
      envelopeId: seeded.envelopeId,
      barrier,
      cancelReply: cancel.status,
      sendReply: reply.status,
      sendBody: reply.body.slice(0, 300),
      finalStatus: envelope.status,
      cancelRows: cancelRows.map((row) => row.createdAt.toISOString()),
      signingJobsAfterCancel: signingJobsAfter.length,
      signingRowsAfterCancel: signingRowsAfter.length,
    });

    expect(barrier.cancelWaiting, 'the cancel was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
    expect(barrier.sendWaiting, 'the send was seen waiting behind the cancel').toBeGreaterThanOrEqual(2);
    expect(reply.status, 'the send was not rate-limited').not.toBe(429);
    expectOk(cancel, 'the cancel');
    expect(cancelRows, 'one DOCUMENT_CANCELLED row').toHaveLength(1);

    expect
      .soft(envelope.status, 'the envelope stays CANCELLED; the send did not write PENDING back')
      .toBe(DocumentStatus.CANCELLED);
    expect
      .soft(reply.status, `the send is refused with a 4xx: ${reply.body.slice(0, 300)}`)
      .toBeGreaterThanOrEqual(400);
    expect.soft(reply.status, `the send is refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    expect.soft(signingJobsAfter, 'no signing-request job after the cancel').toHaveLength(0);
    expect.soft(signingRowsAfter, 'no SIGNING_REQUEST EMAIL_SENT row after the cancel').toHaveLength(0);
  });
}
