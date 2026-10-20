/**
 * G1 round 9, C38 (Codex round 8): once a recipient has rejected, the owner's
 * deletion behaves like the deletion of a completed document, and nobody is
 * told the document was cancelled.
 *
 * | Criterion | Test                                                                                     |
 * | --------- | ---------------------------------------------------------------------------------------- |
 * | C38 (a)   | C38 A rejects, the owner deletes at once (document delete / envelope delete / bulk / v1)  |
 * | C38 (b)   | C38 A's rejection commits first, then the owner's envelope delete (forced)                |
 * | C38 (c)   | C38 an administrator's super-delete after A rejected sends no cancellation email          |
 *
 * Every test seeds two envelopes whose signers have their own mail-catcher
 * mailboxes: the subject, and a control on which A rejects and nothing else
 * happens. After both settle (seal jobs idle, then a quiet window), the
 * mail subjects A and B received on the subject envelope, with its title
 * replaced by a placeholder, must equal those on the control. Any extra mail,
 * such as a cancellation notice, shows up as a difference, without the test
 * having to know its wording.
 *
 * For (a) and (b) the subject envelope must still exist with its recipients,
 * end REJECTED (the seal ran), keep its rejection audit row and have no
 * DOCUMENT_CANCELLED row, and the delete must answer 2xx. Its deletedAt must be
 * set, since a deleted document leaves the owner's list. (a) records
 * whether the seal had already finished when the delete was sent; the forced
 * case (b) is the one that pins the rejected-but-unsealed window. (c) lets the
 * purge proceed: it must answer 2xx, the envelope must be gone, and the mail is checked.
 *
 * Run 1 showed the seal finishing about 70 ms after a real rejection, before
 * the next request lands, so the sequential (a) and (c) meet an envelope that
 * is already REJECTED. The "window" variants reach the state they were meant
 * to probe by seeding it with seedRejectedNotSealed (A REJECTED with its audit
 * row, envelope PENDING, no seal job), which is what the database holds
 * between the rejection's commit and the seal. The control gets the same seed.
 * After the delete the test delivers the seal job itself on both, as C10 does.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type Browser, expect, test } from '@playwright/test';
import { DocumentStatus } from '@prisma/client';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import {
  API_V1,
  AUDIT,
  adminSession,
  auditRows,
  expectOk,
  JOB,
  jobsFor,
  keepRecord,
  pause,
  QUIET_WINDOW_MS,
  type Reply,
  reject,
  runSealJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  send,
  sessionFor,
  trpcRaw,
  v2Post,
  waitForSealJobsIdle,
} from '../fixtures/reject-seal';
import { addressFor, readMailbox, uniqueLocalPart, waitForMail } from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

const REASON = 'G1 C38 rejection';

type Boxed = { seeded: Seeded; aBox: string; bBox: string };

const seedBoxed = async (request: APIRequestContext, label: string): Promise<Boxed> => {
  const aBox = uniqueLocalPart(`${label}-a`);
  const bBox = uniqueLocalPart(`${label}-b`);
  const seeded = await seedEnvelope(request, { emails: { a: addressFor(aBox), b: addressFor(bBox) } });

  // Both invitations, so every later count starts from a settled mailbox.
  await waitForMail(request, aBox, 1);
  await waitForMail(request, bBox, 1);

  return { seeded, aBox, bBox };
};

/** A's and B's mail subjects, with the envelope's title replaced, sorted. */
const subjectsOf = async (request: APIRequestContext, boxed: Boxed) => {
  const normalise = async (box: string) =>
    (await readMailbox(request, box))
      .map((message) => message.subject.split(boxed.seeded.title).join('<title>'))
      .sort();

  return { a: await normalise(boxed.aBox), b: await normalise(boxed.bBox) };
};

const settle = async (boxed: Boxed) => {
  await waitForSealJobsIdle(boxed.seeded);
  await pause(QUIET_WINDOW_MS + 4_000);
};

/** Everything C38 reads about the subject envelope. */
const stateOf = async (seeded: Seeded) => {
  const envelope = await prisma.envelope.findUnique({ where: { id: seeded.envelopeId } });

  return {
    exists: envelope !== null,
    status: envelope?.status ?? null,
    deletedAt: envelope?.deletedAt?.toISOString() ?? null,
    recipients: await prisma.recipient.count({ where: { envelopeId: seeded.envelopeId } }),
    rejectedRows: (await auditRows(seeded.envelopeId, AUDIT.REJECTED)).length,
    cancelledRows: (await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_CANCELLED)).length,
    cancelEmailJobs: (await jobsFor(JOB.CANCELLED_EMAILS, 'documentId', seeded.documentId)).filter(
      (job) => (job.payload as { cancellationReason?: unknown }).cancellationReason !== REASON,
    ).length,
  };
};

type DeleteRoute =
  | 'API v2 /document/delete'
  | 'API v2 /envelope/delete'
  | 'tRPC envelope.bulk.delete'
  | 'API v1 DELETE';

const ROUTES: DeleteRoute[] = [
  'API v2 /document/delete',
  'API v2 /envelope/delete',
  'tRPC envelope.bulk.delete',
  'API v1 DELETE',
];

const deleteVia = async (
  request: APIRequestContext,
  session: APIRequestContext | null,
  route: DeleteRoute,
  seeded: Seeded,
): Promise<Reply> => {
  if (route === 'API v2 /document/delete') {
    return await v2Post(request, seeded.apiToken, '/document/delete', { documentId: seeded.documentId }, false);
  }

  if (route === 'API v2 /envelope/delete') {
    return await v2Post(request, seeded.apiToken, '/envelope/delete', { envelopeId: seeded.envelopeId }, false);
  }

  if (route === 'tRPC envelope.bulk.delete' && session) {
    return await trpcRaw(
      session,
      'envelope.bulk.delete',
      { envelopeIds: [seeded.envelopeId] },
      { retry: false, teamId: seeded.teamId },
    );
  }

  return await send(
    async () =>
      await request.delete(`${API_V1}/documents/${seeded.documentId}`, {
        headers: { Authorization: `Bearer ${seeded.apiToken}`, 'Content-Type': 'application/json' },
        data: {},
      }),
    'API v1 DELETE',
    false,
  );
};

/** Bulk delete reports per envelope in a 2xx body: deleted means not in failedIds. */
const deleteSucceeded = (route: DeleteRoute, reply: Reply, seeded: Seeded) => {
  if (reply.status < 200 || reply.status >= 300) {
    return false;
  }

  if (route !== 'tRPC envelope.bulk.delete') {
    return true;
  }

  const body = JSON.parse(reply.body) as { result?: { data?: { json?: { failedIds?: string[] } } } };

  return !(body.result?.data?.json?.failedIds ?? []).includes(seeded.envelopeId);
};

const expectDeletionLikeCompleted = (
  route: DeleteRoute,
  reply: Reply,
  seeded: Seeded,
  state: Awaited<ReturnType<typeof stateOf>>,
  subjects: Awaited<ReturnType<typeof subjectsOf>>,
  control: Awaited<ReturnType<typeof subjectsOf>>,
) => {
  expect
    .soft(deleteSucceeded(route, reply, seeded), `${route}: the delete succeeds: ${reply.body.slice(0, 300)}`)
    .toBe(true);
  expect.soft(state.exists, `${route}: the envelope still exists`).toBe(true);
  expect.soft(state.deletedAt, `${route}: the owner's delete set deletedAt`).not.toBeNull();
  expect.soft(state.recipients, `${route}: both recipients still exist`).toBe(2);
  expect.soft(state.status, `${route}: the seal finished the envelope REJECTED`).toBe(DocumentStatus.REJECTED);
  expect.soft(state.rejectedRows, `${route}: the rejection audit row stays attached`).toBe(1);
  expect.soft(state.cancelledRows, `${route}: no DOCUMENT_CANCELLED row`).toBe(0);
  expect.soft(state.cancelEmailJobs, `${route}: no cancellation-email job beyond the rejection's own`).toBe(0);
  expect.soft(subjects.a, `${route}: A gets the same mail as on the control`).toEqual(control.a);
  expect.soft(subjects.b, `${route}: B gets the same mail as on the control`).toEqual(control.b);
};

for (const route of ROUTES) {
  test(`C38 (a) A rejects and the owner deletes at once (${route}): deleted like a completed document`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const control = await seedBoxed(request, 'g1-c38-ctl');
    const subject = await seedBoxed(request, 'g1-c38-del');
    const session = route === 'tRPC envelope.bulk.delete' ? await sessionFor(page, subject.seeded.userEmail) : null;

    expectOk(await reject(request, control.seeded, control.seeded.a, REASON), 'A rejects the control');
    expectOk(await reject(request, subject.seeded, subject.seeded.a, REASON), 'A rejects the subject');

    const deleteSentAt = Date.now();
    const reply = await deleteVia(request, session, route, subject.seeded);
    const sealDoneAt = (await jobsFor(JOB.SEAL, 'documentId', subject.seeded.documentId))
      .map((job) => job.completedAt?.getTime())
      .filter((at): at is number => at !== undefined);

    await settle(control);
    await settle(subject);

    const state = await stateOf(subject.seeded);
    const subjects = await subjectsOf(request, subject);
    const controlSubjects = await subjectsOf(request, control);

    await keepRecord('C38-a.json', {
      route,
      envelopeId: subject.seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 300),
      sealFinishedBeforeDelete: sealDoneAt.some((at) => at < deleteSentAt),
      state,
      subjects,
      controlSubjects,
    });

    expectDeletionLikeCompleted(route, reply, subject.seeded, state, subjects, controlSubjects);
  });
}

test("C38 (b) A's rejection commits first, then the owner's envelope delete (forced): deleted like a completed document", async ({
  request,
}) => {
  test.setTimeout(180_000);

  const control = await seedBoxed(request, 'g1-c38b-ctl');
  const subject = await seedBoxed(request, 'g1-c38b-del');

  expectOk(await reject(request, control.seeded, control.seeded.a, REASON), 'A rejects the control');

  let rejection: Promise<Reply> | undefined;
  let deletion: Promise<Reply> | undefined;

  const waiters = await withLock(
    async (tx) => await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${subject.seeded.envelopeId} FOR UPDATE`,
    async (pid) => {
      rejection = reject(request, subject.seeded, subject.seeded.a, REASON, false);

      const afterReject = await waitForWaiters(pid, 1);

      deletion = deleteVia(request, null, 'API v2 /envelope/delete', subject.seeded);

      const afterDelete = await waitForWaiters(pid, 2);

      return { afterReject, afterDelete };
    },
  );

  if (!rejection || !deletion) {
    throw new Error('A request was never fired');
  }

  const [rejectReply, reply] = await Promise.all([rejection, deletion]);

  await settle(control);
  await settle(subject);

  const state = await stateOf(subject.seeded);
  const subjects = await subjectsOf(request, subject);
  const controlSubjects = await subjectsOf(request, control);

  await keepRecord('C38-b.json', {
    envelopeId: subject.seeded.envelopeId,
    waiters,
    rejectReply: rejectReply.status,
    reply: reply.status,
    body: reply.body.slice(0, 300),
    state,
    subjects,
    controlSubjects,
  });

  expect(waiters.afterReject, 'the rejection was seen waiting on the Envelope row lock').toBeGreaterThanOrEqual(1);
  expect(waiters.afterDelete, 'the delete was seen waiting behind it').toBeGreaterThanOrEqual(2);
  expect(rejectReply.status, `A's rejection succeeds: ${rejectReply.body.slice(0, 300)}`).toBe(200);

  expectDeletionLikeCompleted('API v2 /envelope/delete', reply, subject.seeded, state, subjects, controlSubjects);
});

const adminDelete = async (browser: Browser, seeded: Seeded) => {
  const context = await browser.newContext();

  try {
    const admin = await adminSession(await context.newPage());

    return await trpcRaw(admin, 'admin.document.delete', { id: seeded.envelopeId, reason: 'G1 C38 admin purge' });
  } finally {
    await context.close();
  }
};

test('C38 (c) an administrator super-deletes after A rejected: no cancellation email to the recipients', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);

  const control = await seedBoxed(request, 'g1-c38c-ctl');
  const subject = await seedBoxed(request, 'g1-c38c-del');

  expectOk(await reject(request, control.seeded, control.seeded.a, REASON), 'A rejects the control');
  expectOk(await reject(request, subject.seeded, subject.seeded.a, REASON), 'A rejects the subject');

  const reply = await adminDelete(browser, subject.seeded);

  await settle(control);
  await pause(QUIET_WINDOW_MS + 4_000);

  const subjects = await subjectsOf(request, subject);
  const controlSubjects = await subjectsOf(request, control);

  await keepRecord('C38-c.json', {
    envelopeId: subject.seeded.envelopeId,
    reply: reply.status,
    body: reply.body.slice(0, 300),
    envelopeExists: (await prisma.envelope.findUnique({ where: { id: subject.seeded.envelopeId } })) !== null,
    subjects,
    controlSubjects,
  });

  expect(reply.status, `the purge succeeds: ${reply.body.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
  expect(reply.status, `the purge succeeds: ${reply.body.slice(0, 300)}`).toBeLessThan(300);
  expect(
    await prisma.envelope.findUnique({ where: { id: subject.seeded.envelopeId } }),
    'the purged envelope is gone',
  ).toBeNull();

  const cancelLike = (list: string[]) => list.filter((line) => /cancel/i.test(line));

  expect
    .soft(cancelLike(subjects.a), 'A gets no cancellation email beyond what the control got')
    .toEqual(cancelLike(controlSubjects.a));
  expect
    .soft(cancelLike(subjects.b), 'B gets no cancellation email beyond what the control got')
    .toEqual(cancelLike(controlSubjects.b));
});

for (const route of ROUTES) {
  test(`C38 (a) window: owner deletes while A's rejection is committed but unsealed (${route})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const control = await seedBoxed(request, 'g1-c38w-ctl');
    const subject = await seedBoxed(request, 'g1-c38w-del');
    const session = route === 'tRPC envelope.bulk.delete' ? await sessionFor(page, subject.seeded.userEmail) : null;

    await seedRejectedNotSealed(control.seeded, REASON);
    await seedRejectedNotSealed(subject.seeded, REASON);

    const reply = await deleteVia(request, session, route, subject.seeded);
    const controlSeal = await runSealJob(control.seeded);
    const seal = await runSealJob(subject.seeded);

    await settle(control);
    await pause(QUIET_WINDOW_MS + 4_000);

    const state = await stateOf(subject.seeded);
    const subjects = await subjectsOf(request, subject);
    const controlSubjects = await subjectsOf(request, control);

    await keepRecord('C38-a-window.json', {
      route,
      envelopeId: subject.seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 300),
      seal: { status: seal.status, body: seal.body.slice(0, 300) },
      controlSeal: controlSeal.status,
      state,
      subjects,
      controlSubjects,
    });

    expect(controlSeal.status, 'the seal job runs on the control').toBe(200);

    expectDeletionLikeCompleted(route, reply, subject.seeded, state, subjects, controlSubjects);
  });
}

test('C38 (c) window: an administrator super-deletes while the rejection is unsealed: no cancellation email', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);

  const control = await seedBoxed(request, 'g1-c38cw-ctl');
  const subject = await seedBoxed(request, 'g1-c38cw-del');

  await seedRejectedNotSealed(control.seeded, REASON);
  await seedRejectedNotSealed(subject.seeded, REASON);

  const reply = await adminDelete(browser, subject.seeded);

  await runSealJob(control.seeded);
  await settle(control);
  await pause(QUIET_WINDOW_MS + 4_000);

  const subjects = await subjectsOf(request, subject);
  const controlSubjects = await subjectsOf(request, control);

  await keepRecord('C38-c-window.json', {
    envelopeId: subject.seeded.envelopeId,
    reply: reply.status,
    body: reply.body.slice(0, 300),
    envelopeExists: (await prisma.envelope.findUnique({ where: { id: subject.seeded.envelopeId } })) !== null,
    subjects,
    controlSubjects,
  });

  expect(reply.status, `the purge succeeds: ${reply.body.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
  expect(reply.status, `the purge succeeds: ${reply.body.slice(0, 300)}`).toBeLessThan(300);
  expect(
    await prisma.envelope.findUnique({ where: { id: subject.seeded.envelopeId } }),
    'the purged envelope is gone',
  ).toBeNull();

  const cancelLike = (list: string[]) => list.filter((line) => /cancel/i.test(line));

  // Under G4 C108 the control's seal sends its rejection's own cancellation email, which the purged envelope never
  // gets, so the control is an upper bound: the subject's cancellation emails must be a subset of the control's.
  const beyondControl = (subject: string[], control: string[]) => {
    const left = [...cancelLike(control)];

    return cancelLike(subject).filter((line) => {
      const at = left.indexOf(line);

      if (at === -1) {
        return true;
      }

      left.splice(at, 1);

      return false;
    });
  };

  expect
    .soft(beyondControl(subjects.a, controlSubjects.a), 'A gets no cancellation email beyond what the control got')
    .toEqual([]);
  expect
    .soft(beyondControl(subjects.b, controlSubjects.b), 'B gets no cancellation email beyond what the control got')
    .toEqual([]);
  // The purged envelope is never sealed, so it does not get even the rejection's own cancellation email.
  expect.soft([...cancelLike(subjects.a), ...cancelLike(subjects.b)], 'no cancellation email at all').toEqual([]);
});
