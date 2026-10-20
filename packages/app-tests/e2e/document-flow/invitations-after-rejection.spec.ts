/**
 * G1 round 2, C27: once signer A has rejected, signer B is not invited again,
 * neither by a signing-request job that was already queued nor by the owner's
 * resend.
 *
 * | Criterion | Test                                                                          |
 * | --------- | ----------------------------------------------------------------------------- |
 * | C27       | C27 a signing-request job queued for B runs after A rejected: B is not mailed; job ran |
 * | C27       | C27 resend after A rejected does not mail B (API v1 resend / envelope.redistribute) |
 * | C32       | C32 A rejects between the signing-request job's two checks: no mail, no evidence     |
 *
 * Both tests use the state between A's rejection committing and the seal
 * finishing the envelope REJECTED: A REJECTED with its audit row, the envelope
 * still PENDING (seedRejectedNotSealed, as C2 and C18 do). On a real queue that
 * state lasts for as long as the seal job waits behind other jobs, and a
 * signing-request job for B queued before the rejection (by a send, a resend or
 * a sequential hand-over) can run inside it. The first test delivers B's job
 * through the server's job endpoint only after A's rejection is in place, which
 * is the order the queue would deliver it in; no lock is needed because the job
 * reads the state once, after the rejection has committed.
 *
 * C32 forces A's rejection into the job itself, between its first rejection
 * check and the second one it makes just before mailing. Between the two the
 * local job runner inserts the BackgroundJobTask row for the job's
 * 'send-signing-email' task, and the second check runs inside that task. The
 * test inserts a row with the same id in a transaction it holds open, delivers
 * B's job, waits until the job is a waiter on it (it has passed its first
 * check), commits A's rejection on another connection, and rolls its own
 * transaction back. The runner's insert then goes ahead and the job reaches its
 * second check with the rejection committed. (The barrier used to be the
 * monthly email quota row, but CI runs with DANGEROUS_BYPASS_RATE_LIMITS=true,
 * which skips the quota step and never creates that row.) Nothing may then claim B was invited: no email,
 * no new sentAt, no sendStatus change and no SIGNING_REQUEST EMAIL_SENT row.
 *
 * The job tests require the job endpoint to answer 2xx and the BackgroundJob
 * row to end COMPLETED, so a job that never ran cannot pass.
 *
 * Every assertion counts B's mailbox in the mail catcher and B's
 * SIGNING_REQUEST EMAIL_SENT rows, before and after, with a quiet window for a
 * late job.
 */
import { createHash } from 'node:crypto';

import { prisma } from '@documenso/prisma';
import { expect, test } from '@playwright/test';
import { DocumentStatus, SendStatus, SigningStatus } from '@prisma/client';

import { backendPid, waitForWaiters } from '../fixtures/lock-barrier';
import {
  AUDIT,
  createJobRow,
  deliverJob,
  emailRows,
  envelopeRow,
  JOB,
  keepRecord,
  pause,
  QUIET_WINDOW_MS,
  REJECTION_REASON,
  type Reply,
  recipientRow,
  runJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  send,
  v2Post,
} from '../fixtures/reject-seal';
import { addressFor, jsonHeaders, readMailbox, uniqueLocalPart, V1_URL, waitForMail } from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

/** An envelope whose B has a mailbox in the catcher, with B's first invitation already delivered. */
const seedWithMailbox = async (request: Parameters<typeof seedEnvelope>[0], label: string) => {
  const bBox = uniqueLocalPart(label);
  const seeded = await seedEnvelope(request, { emails: { b: addressFor(bBox) } });

  // The seed's own invitation to B, so the counts below start from a settled mailbox.
  await waitForMail(request, bBox, 1);

  return { seeded, bBox };
};

/** B's mailbox and SIGNING_REQUEST rows now. */
const bMailState = async (request: Parameters<typeof readMailbox>[0], seeded: Seeded, bBox: string) => ({
  mail: (await readMailbox(request, bBox)).length,
  signingRows: (await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.b.id)).length,
});

/** The job endpoint answered 2xx and the BackgroundJob row ended COMPLETED: the job ran. */
const expectJobRan = async (job: { jobRowId: string; status: number; body: string }) => {
  const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.jobRowId } });

  expect(job.status, `the job endpoint ran the job: ${job.body.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
  expect(job.status, `the job endpoint ran the job: ${job.body.slice(0, 300)}`).toBeLessThan(300);
  expect(row.status, 'the BackgroundJob row is COMPLETED').toBe('COMPLETED');
};

/** The premise every C27 test starts from: A REJECTED, B still to sign, the envelope PENDING. */
const expectRejectedElsewhere = async (seeded: Seeded) => {
  expect((await recipientRow(seeded.a.id))?.signingStatus, 'premise: A has rejected').toBe(SigningStatus.REJECTED);
  expect((await recipientRow(seeded.b.id))?.signingStatus, 'premise: B has not signed').toBe(SigningStatus.NOT_SIGNED);
  expect((await envelopeRow(seeded)).status, 'premise: the seal has not run yet').toBe(DocumentStatus.PENDING);
};

test('C27 a signing-request job queued for B runs after A rejected: B gets no invitation and no SIGNING_REQUEST row', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const { seeded, bBox } = await seedWithMailbox(request, 'g1-c27-job-b');

  await seedRejectedNotSealed(seeded);
  await expectRejectedElsewhere(seeded);

  const before = await bMailState(request, seeded, bBox);

  const job = await runJob(JOB.SIGNING_EMAIL, 'Send Signing Email', {
    userId: seeded.userId,
    documentId: seeded.documentId,
    recipientId: seeded.b.id,
  });

  await pause(QUIET_WINDOW_MS);

  const after = await bMailState(request, seeded, bBox);

  await keepRecord('C27-job.json', { envelopeId: seeded.envelopeId, job, before, after });

  await expectJobRan(job);
  expect.soft(after.mail, 'no invitation email reaches B after A rejected').toBe(before.mail);
  expect.soft(after.signingRows, 'no SIGNING_REQUEST EMAIL_SENT row for B after A rejected').toBe(before.signingRows);
});

type ResendRoute = 'API v1 resend' | 'envelope.redistribute';

const RESEND_ROUTES: ResendRoute[] = ['API v1 resend', 'envelope.redistribute'];

for (const route of RESEND_ROUTES) {
  test(`C27 resend after A rejected does not mail B (${route})`, async ({ request }) => {
    test.setTimeout(120_000);

    const { seeded, bBox } = await seedWithMailbox(request, `g1-c27-resend-${route === 'API v1 resend' ? 'v1' : 'v2'}`);

    await seedRejectedNotSealed(seeded);
    await expectRejectedElsewhere(seeded);

    const before = await bMailState(request, seeded, bBox);

    const reply: Reply =
      route === 'API v1 resend'
        ? await send(
            async () =>
              await request.post(`${V1_URL}/documents/${seeded.documentId}/resend`, {
                headers: jsonHeaders(seeded.apiToken),
                data: { recipients: [seeded.b.id] },
              }),
            'API v1 resend',
            true,
          )
        : await v2Post(request, seeded.apiToken, '/envelope/redistribute', {
            envelopeId: seeded.envelopeId,
            recipients: [seeded.b.id],
          });

    await pause(QUIET_WINDOW_MS);

    const after = await bMailState(request, seeded, bBox);

    await keepRecord('C27-resend.json', {
      route,
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 300),
      before,
      after,
    });

    expect(reply.status, `${route} did not fail with a server error: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    expect.soft(after.mail, `${route}: no email reaches B after A rejected`).toBe(before.mail);
    expect
      .soft(after.signingRows, `${route}: no SIGNING_REQUEST EMAIL_SENT row for B after A rejected`)
      .toBe(before.signingRows);
  });
}

/** The local job runner's cache key for the signing-email job's send step. */
const SEND_TASK = 'send-signing-email';

/** Thrown to roll back the barrier transaction once the rejection has committed. */
const ROLLBACK = new Error('roll back the C32 barrier');

test("C32 A rejects between the signing-request job's two checks: B gets no mail and no evidence of one", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const { seeded, bBox } = await seedWithMailbox(request, 'g1-c32-job-b');

  // B's invitation is queued but not yet delivered.
  await prisma.recipient.update({
    where: { id: seeded.b.id },
    data: { sendStatus: SendStatus.NOT_SENT, sentAt: null },
  });

  const before = await bMailState(request, seeded, bBox);
  const bBefore = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });

  // The barrier is the job's 'send-signing-email' task row, which the local job runner inserts after the first
  // check and before the callback that makes the second. The test inserts a row with the same id in a transaction
  // it never commits, so the runner's insert waits on it; the rejection then commits on another connection, and the
  // test's transaction rolls back, letting the runner's insert, and the second check, go ahead.
  const payload = { userId: seeded.userId, documentId: seeded.documentId, recipientId: seeded.b.id };
  const jobRow = await createJobRow(JOB.SIGNING_EMAIL, 'Send Signing Email', payload);
  const taskId = `task-${createHash('sha256').update(SEND_TASK).digest('hex')}--${jobRow.id}`;

  let job: ReturnType<typeof deliverJob> | undefined;
  let barrier: { jobWaiting: number } | undefined;

  await prisma
    .$transaction(
      async (tx) => {
        await tx.backgroundJobTask.create({
          data: { id: taskId, name: SEND_TASK, jobId: jobRow.id, status: 'PENDING' },
        });

        job = deliverJob(JOB.SIGNING_EMAIL, jobRow.id, payload);

        const jobWaiting = await waitForWaiters(await backendPid(tx), 1, 15_000);

        // A's rejection, written as the reject route writes it, commits while the job waits.
        await prisma.$transaction([
          prisma.recipient.update({
            where: { id: seeded.a.id },
            data: { signingStatus: SigningStatus.REJECTED, rejectionReason: REJECTION_REASON, signedAt: new Date() },
          }),
          prisma.documentAuditLog.create({
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
          }),
        ]);

        barrier = { jobWaiting };

        throw ROLLBACK;
      },
      { timeout: 60_000, maxWait: 5_000 },
    )
    .catch((error: unknown) => {
      if (error !== ROLLBACK) {
        throw error;
      }
    });

  if (!job || !barrier) {
    throw new Error('The job was never delivered');
  }

  const ran = await job;

  await pause(QUIET_WINDOW_MS);

  const after = await bMailState(request, seeded, bBox);
  const bAfter = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });

  await keepRecord('C32-job.json', {
    envelopeId: seeded.envelopeId,
    barrier,
    job: ran,
    before,
    after,
    bBefore: { sendStatus: bBefore.sendStatus, sentAt: bBefore.sentAt },
    bAfter: { sendStatus: bAfter.sendStatus, sentAt: bAfter.sentAt },
  });

  expect(barrier.jobWaiting, 'the job was seen waiting on its send task, past its first check').toBeGreaterThanOrEqual(
    1,
  );
  expect((await recipientRow(seeded.a.id))?.signingStatus, 'A has rejected').toBe(SigningStatus.REJECTED);
  await expectJobRan(ran);

  expect.soft(after.mail, 'no invitation email reaches B').toBe(before.mail);
  expect.soft(after.signingRows, 'no SIGNING_REQUEST EMAIL_SENT row for B').toBe(before.signingRows);
  expect.soft(bAfter.sentAt, "B's sentAt is unchanged").toEqual(bBefore.sentAt);
  expect.soft(bAfter.sendStatus, "B's sendStatus is unchanged").toBe(bBefore.sendStatus);
});
