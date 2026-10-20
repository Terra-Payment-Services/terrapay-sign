/**
 * The next signer is never a rejecter.
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md)
 * before any fix, without reading the completion or signing-email code. The
 * envelope is sequential, B first (order 1) and A second (order 2), with
 * "allow dictate next signer" on where stated. B signs and completes through its
 * token routes, optionally naming a dictated next signer X; the owner rejects on
 * behalf of A through API v2; the signing-request job runs through the server's
 * signed job endpoint. Assertions read A's row, audit rows, EMAIL_SENT rows and
 * BackgroundJob rows.
 *
 * | Criterion | Test                                                                       |
 * | --------- | -------------------------------------------------------------------------- |
 * | C17       | C17 control: after A rejected, B's completion naming X is refused            |
 * | C18       | C18 a rejection that commits while B's completion waits on A's row (X / none) |
 * | C19       | C19 B's completion naming X and the owner's reject of A together; A's SENT   |
 * |           | is accepted only when a send.signing.rejected.emails job names A             |
 * | C20       | C20 the signing-request job sends nothing to a REJECTED recipient            |
 *
 * C18 is a deterministic interleaving. The test opens a transaction on a second
 * database connection and takes SELECT ... FOR UPDATE on A's Recipient row (never
 * the Envelope row), fires B's completion, waits until pg_stat_activity shows a
 * backend blocked by that transaction or five seconds pass, then in the same
 * transaction marks A REJECTED, writes the rejection audit row and commits. The
 * lock lives only in the test; no application code is involved in holding it.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { SendStatus, SigningStatus } from '@prisma/client';

import {
  AUDIT,
  auditRowsForRecipient,
  complete,
  emailRows,
  expectOk,
  expectRefused,
  isClientError,
  isSuccess,
  JOB,
  jobsFor,
  keepRecord,
  type Outcome,
  pause,
  QUIET_WINDOW_MS,
  REJECTION_REASON,
  type Reply,
  rateLimited,
  recipientRow,
  rejectOnBehalf,
  replyVerdict,
  runIterations,
  runJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  signV2,
  verdictOf,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

const X = { email: 'dictated-x@test.documenso.com', name: 'Dictated X' };

const seedSequential = async (request: APIRequestContext) => {
  const seeded = await seedEnvelope(request, { signingOrder: 'SEQUENTIAL', allowDictateNextSigner: true });
  const rows = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId } });

  // B signs first, A second: B was sent the invitation, A was not.
  expect(rows.find((row) => row.id === seeded.b.id)?.signingOrder, 'B is first').toBe(1);
  expect(rows.find((row) => row.id === seeded.a.id)?.signingOrder, 'A is second').toBe(2);

  return seeded;
};

/**
 * What the C18 and C19 assertions read about A, and the problems found. With
 * `allowRejectionMail`, A's move from NOT_SENT to SENT is accepted when a
 * send.signing.rejected.emails job names A: that job marks the rejecter SENT
 * after mailing them, and C19's reject-on-behalf queues it. C18 seeds the
 * rejection directly, so no such job runs there and the strict check stays.
 */
const judgeA = async (
  seeded: Seeded,
  aBefore: { sendStatus: SendStatus },
  { allowRejectionMail = false }: { allowRejectionMail?: boolean } = {},
) => {
  await pause(QUIET_WINDOW_MS);

  const a = await recipientRow(seeded.a.id);
  const updates = await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_UPDATED, seeded.a.id);
  const signingJobs = await jobsFor(JOB.SIGNING_EMAIL, 'recipientId', seeded.a.id);
  const signingEmails = await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.a.id);
  const rejectionJobs = allowRejectionMail
    ? await jobsFor('send.signing.rejected.emails', 'recipientId', seeded.a.id)
    : [];
  const sentByRejectionMail =
    rejectionJobs.length > 0 && aBefore.sendStatus === SendStatus.NOT_SENT && a?.sendStatus === SendStatus.SENT;

  const record = {
    aStatus: a?.signingStatus,
    aName: a?.name,
    aEmail: a?.email,
    aSendStatus: a?.sendStatus,
    aUpdatedRows: updates.length,
    aSigningJobs: signingJobs.length,
    aSigningEmails: signingEmails.length,
    aRejectionJobs: rejectionJobs.length,
  };

  const problems = [
    a?.signingStatus === SigningStatus.REJECTED ? null : `A is ${a?.signingStatus}, expected REJECTED`,
    a?.name === seeded.a.name ? null : `A's name became "${a?.name}"`,
    a?.email === seeded.a.email ? null : `A's email became "${a?.email}"`,
    a?.sendStatus === aBefore.sendStatus || sentByRejectionMail
      ? null
      : `A's sendStatus went from ${aBefore.sendStatus} to ${a?.sendStatus}`,
    updates.length === 0 ? null : `${updates.length} RECIPIENT_UPDATED row(s) name A`,
    signingJobs.length === 0 ? null : `${signingJobs.length} send.signing.requested.email job(s) for A`,
    signingEmails.length === 0 ? null : `${signingEmails.length} signing-request EMAIL_SENT row(s) for A`,
  ];

  return { record, problems };
};

// ---------------------------------------------------------------------------
// C17, control
// ---------------------------------------------------------------------------

test("C17 control: after A rejected, B's completion naming a dictated signer is refused and A is unchanged", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const seeded = await seedSequential(request);

  expectOk(await signV2(request, seeded.b), 'B signs its field before A rejects');
  await seedRejectedNotSealed(seeded);

  expectRefused(
    await complete(request, seeded, seeded.b, { nextSigner: X }),
    "B's completion naming X after A rejected",
  );

  const a = await recipientRow(seeded.a.id);

  expect((await recipientRow(seeded.b.id))?.signingStatus).toBe(SigningStatus.NOT_SIGNED);
  expect(a?.signingStatus).toBe(SigningStatus.REJECTED);
  expect(a?.name).toBe(seeded.a.name);
  expect(a?.email).toBe(seeded.a.email);
});

// ---------------------------------------------------------------------------
// C18, deterministic interleaving
// ---------------------------------------------------------------------------

const WAITER_TIMEOUT_MS = 5_000;

/** Polls until a backend is blocked by `pid`, or the timeout passes. Returns whether one was seen. */
const waitForWaiter = async (pid: number) => {
  const deadline = Date.now() + WAITER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;

    if (n > 0) {
      return true;
    }

    await pause(50);
  }

  return false;
};

for (const dictated of [true, false]) {
  test(`C18 a rejection that commits while B's completion waits on A's row: A is never invited (${
    dictated ? 'dictated signer X' : 'no dictated signer'
  })`, async ({ request }) => {
    test.setTimeout(180_000);

    const seeded = await seedSequential(request);

    expectOk(await signV2(request, seeded.b), 'B signs its field');

    const aBefore = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.a.id } });

    let completion: Promise<Reply> | undefined;

    const sawWaiter = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Recipient" WHERE "id" = ${seeded.a.id} FOR UPDATE`;

        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

        completion = complete(request, seeded, seeded.b, { nextSigner: dictated ? X : undefined, retry: false });

        const waited = await waitForWaiter(pid);

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

        return waited;
      },
      { timeout: 30_000, maxWait: 5_000 },
    );

    if (!completion) {
      throw new Error("B's completion was never fired");
    }

    const reply = await completion;

    expect(reply.status, 'the completion was not rate-limited').not.toBe(429);

    const b = await recipientRow(seeded.b.id);
    const { record, problems } = await judgeA(seeded, aBefore);

    await keepRecord(`C18-outcome-${dictated ? 'dictated' : 'plain'}.json`, {
      dictated,
      sawWaiter,
      completionReply: reply.status,
      bStatus: b?.signingStatus,
      ...record,
    });

    expect.soft(isSuccess(reply), `B's completion succeeds: ${reply.status} ${reply.body.slice(0, 300)}`).toBe(true);
    expect.soft(b?.signingStatus, 'B is SIGNED').toBe(SigningStatus.SIGNED);
    expect(
      problems.filter((problem) => problem !== null),
      'A after the interleaving',
    ).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// C19, real endpoints interleaved
// ---------------------------------------------------------------------------

test("C19 B's completion naming X and the owner's reject of A together: a rejected A is never invited", async ({
  request,
}) => {
  test.setTimeout(20 * 60_000);

  await runIterations('C19', async (): Promise<Outcome> => {
    const seeded = await seedSequential(request);

    expectOk(await signV2(request, seeded.b), 'B signs its field before the race');

    const aBefore = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.a.id } });

    const [completeReply, rejectReply] = await Promise.all([
      complete(request, seeded, seeded.b, { nextSigner: X, retry: false }),
      rejectOnBehalf(request, seeded, seeded.a.id, 'The owner rejects for A', false),
    ]);

    const limited = rateLimited(seeded, { completeReply, rejectReply });

    if (limited) {
      return limited;
    }

    const b = await recipientRow(seeded.b.id);
    const { record, problems } = await judgeA(seeded, aBefore, { allowRejectionMail: true });
    const aRejected = record.aStatus === SigningStatus.REJECTED;
    const bSigned = b?.signingStatus === SigningStatus.SIGNED;

    return {
      verdict: verdictOf(
        ...(aRejected ? problems : []),
        isClientError(completeReply) && b?.signingStatus !== SigningStatus.NOT_SIGNED
          ? `B's completion was refused but B is ${b?.signingStatus}`
          : null,
        replyVerdict(completeReply, bSigned, "B's completion"),
        replyVerdict(rejectReply, aRejected, "the owner's reject of A"),
      ),
      record: {
        envelopeId: seeded.envelopeId,
        completeReply: completeReply.status,
        rejectReply: rejectReply.status,
        bStatus: b?.signingStatus,
        ...record,
      },
    };
  });
});

// ---------------------------------------------------------------------------
// C20
// ---------------------------------------------------------------------------

test('C20 the signing-request job sends nothing to a recipient who has rejected', async ({ request }) => {
  test.setTimeout(120_000);

  const runSigningJob = async (seeded: Seeded) =>
    await runJob(JOB.SIGNING_EMAIL, 'Send Signing Email', {
      userId: seeded.userId,
      documentId: seeded.documentId,
      recipientId: seeded.a.id,
    });

  // Control: the same job for A while A is NOT_SIGNED sends the invitation.
  const control = await seedSequential(request);

  expect((await recipientRow(control.a.id))?.sendStatus, 'control: A has not been sent yet').toBe(SendStatus.NOT_SENT);

  const controlRun = await runSigningJob(control);

  expect(controlRun.status, `control: the job answers OK: ${controlRun.body.slice(0, 200)}`).toBe(200);
  await expect
    .poll(async () => (await emailRows(control.envelopeId, 'SIGNING_REQUEST', control.a.id)).length, {
      message: 'control: a signing-request EMAIL_SENT row for A',
      timeout: 30_000,
    })
    .toBe(1);
  expect((await recipientRow(control.a.id))?.sendStatus, 'control: A is now SENT').toBe(SendStatus.SENT);

  // A has rejected.
  const seeded = await seedSequential(request);

  await seedRejectedNotSealed(seeded);

  const run = await runSigningJob(seeded);

  expect(run.status, `the job answers without a server error: ${run.body.slice(0, 200)}`).toBeLessThan(500);
  await pause(QUIET_WINDOW_MS);

  expect
    .soft(await emailRows(seeded.envelopeId, 'SIGNING_REQUEST', seeded.a.id), 'no signing-request email to A')
    .toHaveLength(0);
  expect.soft((await recipientRow(seeded.a.id))?.sendStatus, "A's sendStatus is unchanged").toBe(SendStatus.NOT_SENT);
});
