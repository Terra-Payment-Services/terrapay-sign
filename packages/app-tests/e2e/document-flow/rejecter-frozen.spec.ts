/**
 * The rejecter is frozen until the seal runs.
 *
 * Written from the G1 specification (terrapay-sign-evidence/campaign-2026-10-17/G1/spec.md)
 * before any fix, without reading the recipient or field write paths. A PENDING
 * V2 envelope with signers A and B is seeded through API v2; "rejected but not
 * yet sealed" is seeded directly (A REJECTED with a reason and a
 * DOCUMENT_RECIPIENT_REJECTED row, envelope PENDING, no seal job). The owner then
 * edits A through every route the enumeration lists, and each assertion reads
 * the database: A's row, A's fields, audit rows, BackgroundJob rows, and the
 * mail catcher for the recipient-removed email, which writes no EMAIL_SENT row.
 *
 * | Criterion | Test                                                                         |
 * | --------- | ---------------------------------------------------------------------------- |
 * | C1        | C1 the owner cannot update the rejecter (v2 update-many, document update, v1) |
 * | C2        | C2 the owner cannot delete the rejecter (v2 delete, document delete, v1)      |
 * | C3        | C3 the editor save cannot drop, change or reset the rejecter (+ V2 editor UI) |
 * | C4        | C4 the owner cannot create, update or delete the rejecter's fields            |
 * | C5        | C5 a super admin cannot update the rejecter (name, role to CC)               |
 * | C6        | C6 after every attempt in C1 to C5 the seal still finds the rejecter          |
 * | C7        | C7 A's reject and the owner's update of A together                           |
 * | C8        | C8 A's reject and the owner's delete of A; C8 ... editor save omitting A      |
 * | C9        | C9 control: without a rejection the owner still updates and deletes           |
 *
 * Runs in the `ui` project: C3 drives the V2 editor and C3, C5 and C8 use a
 * signed-in session for routes with no API v2 surface.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import {
  API_V1,
  AUDIT,
  adminSession,
  auditRows,
  auditRowsForRecipient,
  createOwner,
  dataOf,
  envelopeRow,
  expectOk,
  isSuccess,
  JOB,
  jobsFor,
  keepRecord,
  type Outcome,
  ownerBrowserSignin,
  pause,
  QUIET_WINDOW_MS,
  REJECTION_REASON,
  type Reply,
  rateLimited,
  recipientRow,
  reject,
  replyVerdict,
  runIterations,
  runSealJob,
  type Seeded,
  seedEnvelope,
  seedRejectedNotSealed,
  send,
  sessionFor,
  time,
  trpcRaw,
  v2Post,
  verdictOf,
  waitForSealJobsIdle,
} from '../fixtures/reject-seal';
import { addressFor, readMailbox, uniqueLocalPart, waitForMail } from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

// ---------------------------------------------------------------------------
// The owner's routes
// ---------------------------------------------------------------------------

type Change = { name: string; email: string };

const changeFor = (seeded: Seeded): Change => ({
  name: 'Renamed by the owner',
  email: `renamed-${seeded.a.id}@test.documenso.com`,
});

const UPDATE_ROUTES = ['envelope update-many', 'document update', 'v1 PATCH'] as const;
const DELETE_ROUTES = ['envelope delete', 'document delete', 'v1 DELETE'] as const;

type UpdateRoute = (typeof UPDATE_ROUTES)[number];
type DeleteRoute = (typeof DELETE_ROUTES)[number];

const updateRecipient = async (
  request: APIRequestContext,
  seeded: Seeded,
  route: UpdateRoute,
  recipientId: number,
  change: Change,
  retry = true,
): Promise<Reply> => {
  if (route === 'envelope update-many') {
    return await v2Post(
      request,
      seeded.apiToken,
      '/envelope/recipient/update-many',
      { envelopeId: seeded.envelopeId, data: [{ id: recipientId, ...change }] },
      retry,
    );
  }

  if (route === 'document update') {
    return await v2Post(
      request,
      seeded.apiToken,
      '/document/recipient/update',
      { documentId: seeded.documentId, recipient: { id: recipientId, ...change } },
      retry,
    );
  }

  return await send(
    async () =>
      await request.patch(`${API_V1}/documents/${seeded.documentId}/recipients/${recipientId}`, {
        headers: { Authorization: `Bearer ${seeded.apiToken}`, 'Content-Type': 'application/json' },
        data: { ...change, role: 'SIGNER' },
      }),
    'API v1 PATCH recipient',
    retry,
  );
};

const deleteRecipient = async (
  request: APIRequestContext,
  seeded: Seeded,
  route: DeleteRoute,
  recipientId: number,
  retry = true,
): Promise<Reply> => {
  if (route === 'envelope delete') {
    return await v2Post(request, seeded.apiToken, '/envelope/recipient/delete', { recipientId }, retry);
  }

  if (route === 'document delete') {
    return await v2Post(request, seeded.apiToken, '/document/recipient/delete', { recipientId }, retry);
  }

  return await send(
    async () =>
      await request.delete(`${API_V1}/documents/${seeded.documentId}/recipients/${recipientId}`, {
        headers: { Authorization: `Bearer ${seeded.apiToken}`, 'Content-Type': 'application/json' },
        data: {},
      }),
    'API v1 DELETE recipient',
    retry,
  );
};

type SetVariant = 'omit A' | "change A's email" | 'rename B';

/** The editor's save: the whole recipient list through envelope.recipient.set, built from the rows as they are. */
const editorSave = async (session: APIRequestContext, seeded: Seeded, variant: SetVariant, retry = true) => {
  const rows = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } });

  const recipients = rows
    .filter((row) => !(variant === 'omit A' && row.id === seeded.a.id))
    .map((row) => ({
      id: row.id,
      email:
        variant === "change A's email" && row.id === seeded.a.id ? `changed-${row.id}@test.documenso.com` : row.email,
      name: variant === 'rename B' && row.id === seeded.b.id ? 'B renamed in the editor' : row.name,
      role: row.role,
      ...(row.signingOrder !== null ? { signingOrder: row.signingOrder } : {}),
    }));

  return await trpcRaw(
    session,
    'envelope.recipient.set',
    { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', recipients },
    { retry, teamId: seeded.teamId },
  );
};

// ---------------------------------------------------------------------------
// Assertions about A
// ---------------------------------------------------------------------------

/** A is exactly as seeded: REJECTED, original name, email and reason, and no update or delete row. */
const expectAFrozen = async (seeded: Seeded, what: string) => {
  const a = await recipientRow(seeded.a.id);

  expect.soft(a, `${what}: A still exists`).not.toBeNull();
  expect.soft(a?.signingStatus, `${what}: A is still REJECTED`).toBe(SigningStatus.REJECTED);
  expect.soft(a?.name, `${what}: A's name is unchanged`).toBe(seeded.a.name);
  expect.soft(a?.email, `${what}: A's email is unchanged`).toBe(seeded.a.email);
  expect.soft(a?.rejectionReason, `${what}: A's rejection reason is unchanged`).toBe(REJECTION_REASON);
  expect
    .soft(
      await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_UPDATED, seeded.a.id),
      `${what}: no RECIPIENT_UPDATED row for A`,
    )
    .toHaveLength(0);
  expect
    .soft(
      await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_DELETED, seeded.a.id),
      `${what}: no RECIPIENT_DELETED row for A`,
    )
    .toHaveLength(0);
};

const removedEmailJobsFor = async (email: string) => await jobsFor(JOB.REMOVED_EMAIL, 'recipientEmail', email);

const fieldsOf = async (seeded: Seeded, recipientId: number) =>
  (await prisma.field.findMany({ where: { envelopeId: seeded.envelopeId, recipientId }, orderBy: { id: 'asc' } })).map(
    (field) => ({
      id: field.id,
      type: field.type,
      page: field.page,
      positionX: Number(field.positionX),
      positionY: Number(field.positionY),
      width: Number(field.width),
      height: Number(field.height),
      fieldMeta: field.fieldMeta,
    }),
  );

const FIELD_ROUTES = ['create', 'update', 'delete'] as const;

type FieldRoute = (typeof FIELD_ROUTES)[number];

const editAField = async (request: APIRequestContext, seeded: Seeded, route: FieldRoute) => {
  if (route === 'create') {
    return await v2Post(request, seeded.apiToken, '/envelope/field/create-many', {
      envelopeId: seeded.envelopeId,
      data: [
        {
          recipientId: seeded.a.id,
          envelopeItemId: seeded.itemIds[0],
          type: FieldType.SIGNATURE,
          page: 1,
          positionX: 50,
          positionY: 40,
          width: 20,
          height: 6,
        },
      ],
    });
  }

  if (route === 'update') {
    return await v2Post(request, seeded.apiToken, '/envelope/field/update-many', {
      envelopeId: seeded.envelopeId,
      data: [
        {
          id: seeded.a.fieldId,
          type: FieldType.SIGNATURE,
          positionX: 55,
          fieldMeta: { type: 'signature', label: 'Moved' },
        },
      ],
    });
  }

  return await v2Post(request, seeded.apiToken, '/envelope/field/delete', { fieldId: seeded.a.fieldId });
};

const ADMIN_CHANGES = [
  { label: 'name change', input: { name: 'Renamed by an admin' } },
  { label: 'role change to CC', input: { role: 'CC' } },
] as const;

// ---------------------------------------------------------------------------
// Sequential, on "rejected but not yet sealed"
// ---------------------------------------------------------------------------

test('C1 the owner cannot update the rejecter through update-many, document update or API v1', async ({ request }) => {
  test.setTimeout(180_000);

  for (const route of UPDATE_ROUTES) {
    const seeded = await seedEnvelope(request);

    await seedRejectedNotSealed(seeded);

    const reply = await updateRecipient(request, seeded, route, seeded.a.id, changeFor(seeded));

    expect.soft(reply.status, `${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
    expect.soft(reply.status, `${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    await expectAFrozen(seeded, route);
  }
});

test('C2 the owner cannot delete the rejecter through envelope delete, document delete or API v1', async ({
  request,
}) => {
  test.setTimeout(240_000);

  for (const route of DELETE_ROUTES) {
    const aBox = uniqueLocalPart('g1-c2-a');
    const seeded = await seedEnvelope(request, { emails: { a: addressFor(aBox) } });

    await seedRejectedNotSealed(seeded);

    // The invitation first, so a late invitation is not counted as the removed email.
    const mailBefore = (await waitForMail(request, aBox, 1)).length;
    const reply = await deleteRecipient(request, seeded, route, seeded.a.id);

    expect.soft(reply.status, `${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
    expect.soft(reply.status, `${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    await expectAFrozen(seeded, route);

    await pause(QUIET_WINDOW_MS);

    expect
      .soft(await removedEmailJobsFor(seeded.a.email), `${route}: no recipient-removed email job for A`)
      .toHaveLength(0);
    expect.soft(await readMailbox(request, aBox), `${route}: no new email reaches A`).toHaveLength(mailBefore);
  }
});

test('C3 the editor save cannot drop, change or reset the rejecter, and the V2 editor shows A disabled', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  const owner = await createOwner();
  const session = await sessionFor(page, owner.user.email);

  // (a) A list that omits A.
  const omit = await seedEnvelope(request, { owner });

  await seedRejectedNotSealed(omit);
  const omitReply = await editorSave(session, omit, 'omit A');

  expect
    .soft(omitReply.status, `(a) a list without A is refused: ${omitReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect.soft(omitReply.status, `(a) a list without A is refused: ${omitReply.body.slice(0, 300)}`).toBeLessThan(500);
  await expectAFrozen(omit, '(a) omit A');

  // (b) A list that changes A's email.
  const change = await seedEnvelope(request, { owner });

  await seedRejectedNotSealed(change);
  const changeReply = await editorSave(session, change, "change A's email");

  expect
    .soft(changeReply.status, `(b) changing A's email is refused: ${changeReply.body.slice(0, 300)}`)
    .toBeGreaterThanOrEqual(400);
  expect
    .soft(changeReply.status, `(b) changing A's email is refused: ${changeReply.body.slice(0, 300)}`)
    .toBeLessThan(500);
  await expectAFrozen(change, "(b) change A's email");

  // (c) A as it is, B renamed: succeeds, and A is still REJECTED.
  const rename = await seedEnvelope(request, { owner });

  await seedRejectedNotSealed(rename);
  const renameReply = await editorSave(session, rename, 'rename B');

  expect
    .soft(isSuccess(renameReply), `(c) renaming B succeeds: ${renameReply.status} ${renameReply.body.slice(0, 300)}`)
    .toBe(true);
  expect.soft((await recipientRow(rename.b.id))?.name, '(c) B is renamed').toBe('B renamed in the editor');
  await expectAFrozen(rename, '(c) rename B');

  // The V2 editor: A's row is disabled. The locator is checked on a SIGNED recipient first.
  const signedControl = await seedEnvelope(request, { owner });

  await prisma.recipient.update({ where: { id: signedControl.a.id }, data: { signingStatus: SigningStatus.SIGNED } });

  const ui = await seedEnvelope(request, { owner });

  await seedRejectedNotSealed(ui);

  const emailInputFor = async (seeded: Seeded, email: string) => {
    await ownerBrowserSignin(
      page,
      seeded,
      `/t/${seeded.teamUrl}/documents/${seeded.envelopeId}/edit?step=uploadAndRecipients`,
    );

    const inputs = page.locator('[data-testid="signer-email-input"]');

    await expect(inputs.first()).toBeVisible({ timeout: 30_000 });

    const count = await inputs.count();

    for (let index = 0; index < count; index++) {
      if ((await inputs.nth(index).inputValue()) === email) {
        return inputs.nth(index);
      }
    }

    throw new Error(`No recipient row with email ${email}`);
  };

  await expect(
    await emailInputFor(signedControl, signedControl.a.email),
    'control: a SIGNED row is disabled',
  ).toBeDisabled();
  await expect(await emailInputFor(ui, ui.b.email), "control: B's row is editable").toBeEnabled();
  await expect.soft(await emailInputFor(ui, ui.a.email), "the rejecter's row is disabled").toBeDisabled();
});

test("C4 the owner cannot create, update or delete the rejecter's fields", async ({ request }) => {
  test.setTimeout(180_000);

  for (const route of FIELD_ROUTES) {
    const seeded = await seedEnvelope(request);

    await seedRejectedNotSealed(seeded);

    const before = await fieldsOf(seeded, seeded.a.id);
    const reply = await editAField(request, seeded, route);

    expect
      .soft(reply.status, `field ${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`)
      .toBeGreaterThanOrEqual(400);
    expect.soft(reply.status, `field ${route}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    expect.soft(await fieldsOf(seeded, seeded.a.id), `field ${route}: A's fields are unchanged`).toEqual(before);
  }
});

test('C5 a super admin cannot update the rejecter, and is refused with a 4xx', async ({ page, request }) => {
  test.setTimeout(180_000);

  const admin = await adminSession(page);

  for (const { label, input } of ADMIN_CHANGES) {
    const seeded = await seedEnvelope(request);

    await seedRejectedNotSealed(seeded);

    const reply = await trpcRaw(admin, 'admin.recipient.update', { id: seeded.a.id, ...input });

    expect
      .soft(reply.status, `admin ${label}: refused with a 4xx: ${reply.body.slice(0, 300)}`)
      .toBeGreaterThanOrEqual(400);
    expect.soft(reply.status, `admin ${label}: refused with a 4xx: ${reply.body.slice(0, 300)}`).toBeLessThan(500);
    await expectAFrozen(seeded, `admin ${label}`);
    expect.soft((await recipientRow(seeded.a.id))?.role, `admin ${label}: A's role is unchanged`).toBe('SIGNER');
  }
});

test('C6 after every attempt in C1 to C5, the seal still seals the envelope REJECTED', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(15 * 60_000);

  const owner = await createOwner();
  const session = await sessionFor(page, owner.user.email);
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const admin = await adminSession(adminPage);

  const attempts: Array<{ label: string; attempt: (seeded: Seeded) => Promise<Reply> }> = [
    ...UPDATE_ROUTES.map((route) => ({
      label: `update via ${route}`,
      attempt: async (seeded: Seeded) => await updateRecipient(request, seeded, route, seeded.a.id, changeFor(seeded)),
    })),
    ...DELETE_ROUTES.map((route) => ({
      label: `delete via ${route}`,
      attempt: async (seeded: Seeded) => await deleteRecipient(request, seeded, route, seeded.a.id),
    })),
    ...(['omit A', "change A's email", 'rename B'] as const).map((variant) => ({
      label: `editor save: ${variant}`,
      attempt: async (seeded: Seeded) => await editorSave(session, seeded, variant),
    })),
    ...FIELD_ROUTES.map((route) => ({
      label: `field ${route}`,
      attempt: async (seeded: Seeded) => await editAField(request, seeded, route),
    })),
    ...ADMIN_CHANGES.map(({ label, input }) => ({
      label: `admin ${label}`,
      attempt: async (seeded: Seeded) => await trpcRaw(admin, 'admin.recipient.update', { id: seeded.a.id, ...input }),
    })),
  ];

  const problems: string[] = [];

  for (const { label, attempt } of attempts) {
    const seeded = await seedEnvelope(request, { owner });

    await seedRejectedNotSealed(seeded);

    const reply = await attempt(seeded);
    const job = await runSealJob(seeded);

    await waitForSealJobsIdle(seeded);

    const envelope = await envelopeRow(seeded);
    const completed = await auditRows(seeded.envelopeId, AUDIT.DOCUMENT_COMPLETED);
    const isRejectedSeal = completed.length === 1 && dataOf(completed[0]).isRejected === true;

    await keepRecord(`C6-${label.replace(/[^a-z0-9]+/gi, '-')}.json`, {
      label,
      reply: reply.status,
      job: job.status,
      status: envelope.status,
      completed: completed.map(dataOf),
    });

    if (envelope.status !== DocumentStatus.REJECTED) {
      problems.push(
        `${label} (answered ${reply.status}): the seal left the envelope ${envelope.status}, expected REJECTED`,
      );
    }

    if (!isRejectedSeal) {
      problems.push(`${label}: ${completed.length} DOCUMENT_COMPLETED row(s), expected one marked rejected`);
    }
  }

  await adminContext.close();

  expect(problems, 'C6: attempts after which the seal found no rejecter').toEqual([]);
});

// ---------------------------------------------------------------------------
// Interleaved, from a plain PENDING envelope
// ---------------------------------------------------------------------------

test("C7 A's reject and the owner's update of A together: A ends REJECTED with its own details", async ({
  request,
}) => {
  test.setTimeout(15 * 60_000);

  await runIterations('C7', async (): Promise<Outcome> => {
    const seeded = await seedEnvelope(request);
    const change = changeFor(seeded);

    const [rejectReply, updateReply] = await Promise.all([
      reject(request, seeded, seeded.a, 'A rejects during the race', false),
      updateRecipient(request, seeded, 'envelope update-many', seeded.a.id, change, false),
    ]);

    const limited = rateLimited(seeded, { rejectReply, updateReply });

    if (limited) {
      return limited;
    }

    const a = await recipientRow(seeded.a.id);
    const rejection = await auditRowsForRecipient(seeded.envelopeId, AUDIT.REJECTED, seeded.a.id);
    const updates = await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_UPDATED, seeded.a.id);
    const isOriginal = a?.name === seeded.a.name && a?.email === seeded.a.email;
    const isChanged = a?.name === change.name && a?.email === change.email;

    const record = {
      envelopeId: seeded.envelopeId,
      rejectReply: rejectReply.status,
      updateReply: updateReply.status,
      aStatus: a?.signingStatus,
      aName: a?.name,
      rejectionAt: rejection.map((row) => row.createdAt.toISOString()),
      updateAt: updates.map((row) => row.createdAt.toISOString()),
    };

    const problems: Array<string | null> = [
      a?.signingStatus === SigningStatus.REJECTED ? null : `A is ${a?.signingStatus}, expected REJECTED`,
      rejection.length === 1 ? null : `${rejection.length} rejection rows, expected 1`,
      replyVerdict(rejectReply, a?.signingStatus === SigningStatus.REJECTED, "A's reject"),
    ];

    if (isSuccess(updateReply)) {
      problems.push(isChanged ? null : "the update answered 2xx but A's details are not the update's");
      problems.push(
        updates.length >= 1 && (time(updates[0]) ?? Infinity) <= (time(rejection[0]) ?? -Infinity)
          ? null
          : 'the update succeeded but its RECIPIENT_UPDATED row is not earlier than the rejection',
      );
    } else {
      problems.push(replyVerdict(updateReply, false, "the owner's update"));
      problems.push(isOriginal ? null : "the update was refused but A's details changed");
    }

    return { verdict: verdictOf(...problems), record };
  });
});

for (const variant of ['delete', 'editor save'] as const) {
  test(`C8 A's reject and the owner's ${variant === 'delete' ? 'delete of A' : 'editor save omitting A'} together`, async ({
    page,
    request,
  }) => {
    test.setTimeout(30 * 60_000);

    const owner = await createOwner();
    const session = await sessionFor(page, owner.user.email);

    const race = (variant: 'delete' | 'editor save') => async (): Promise<Outcome> => {
      const seeded = await seedEnvelope(request, { owner });

      const [rejectReply, removeReply] = await Promise.all([
        reject(request, seeded, seeded.a, 'A rejects during the race', false),
        variant === 'delete'
          ? deleteRecipient(request, seeded, 'envelope delete', seeded.a.id, false)
          : editorSave(session, seeded, 'omit A', false),
      ]);

      const limited = rateLimited(seeded, { rejectReply, removeReply });

      if (limited) {
        return limited;
      }

      const a = await recipientRow(seeded.a.id);
      const rejection = await auditRowsForRecipient(seeded.envelopeId, AUDIT.REJECTED, seeded.a.id);
      const deletion = await auditRowsForRecipient(seeded.envelopeId, AUDIT.RECIPIENT_DELETED, seeded.a.id);

      const record = {
        envelopeId: seeded.envelopeId,
        variant,
        rejectReply: rejectReply.status,
        removeReply: removeReply.status,
        aExists: a !== null,
        aStatus: a?.signingStatus,
        rejectionRows: rejection.length,
        deletionRows: deletion.length,
      };

      const goneCleanly = a === null && rejection.length === 0 && isClient(rejectReply);
      const rejectedCleanly = a?.signingStatus === SigningStatus.REJECTED && deletion.length === 0;

      return {
        verdict: verdictOf(
          goneCleanly || rejectedCleanly
            ? null
            : `A ${a === null ? 'is gone' : `is ${a.signingStatus}`} with ${rejection.length} rejection and ${deletion.length} deletion row(s)`,
          replyVerdict(rejectReply, a?.signingStatus === SigningStatus.REJECTED, "A's reject"),
          replyVerdict(removeReply, a === null, `the owner's ${variant}`),
        ),
        record,
      };
    };

    await runIterations(`C8-${variant.replace(' ', '-')}`, race(variant));
  });
}

const isClient = (reply: Reply) => reply.status >= 400 && reply.status < 500;

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

test('C9 control: with no rejection the owner still updates and deletes a NOT_SIGNED recipient, and updates a CC', async ({
  request,
}) => {
  test.setTimeout(300_000);

  for (const route of UPDATE_ROUTES) {
    const seeded = await seedEnvelope(request);
    const change = { name: 'B renamed', email: `b-renamed-${seeded.b.id}@test.documenso.com` };

    expectOk(await updateRecipient(request, seeded, route, seeded.b.id, change), `${route}: B is updated`);

    const b = await recipientRow(seeded.b.id);

    expect(b?.name, `${route}: B's name changed`).toBe(change.name);
    expect(b?.email, `${route}: B's email changed`).toBe(change.email);
  }

  for (const route of DELETE_ROUTES) {
    const bBox = uniqueLocalPart('g1-c9-b');
    const seeded = await seedEnvelope(request, { emails: { b: addressFor(bBox) } });

    expectOk(await deleteRecipient(request, seeded, route, seeded.b.id), `${route}: B is deleted`);
    expect(await recipientRow(seeded.b.id), `${route}: B is gone`).toBeNull();
    await expect
      .poll(async () => (await removedEmailJobsFor(seeded.b.email)).length, {
        message: `${route}: a recipient-removed email job for B`,
        timeout: 30_000,
      })
      .toBe(1);
  }

  const withCc = await seedEnvelope(request, { cc: true });

  if (!withCc.cc) {
    throw new Error('No CC recipient seeded');
  }

  expectOk(
    await updateRecipient(request, withCc, 'envelope update-many', withCc.cc.id, {
      name: 'CC renamed',
      email: `cc-renamed-${withCc.cc.id}@test.documenso.com`,
    }),
    'the CC recipient is updated',
  );
  expect((await recipientRow(withCc.cc.id))?.name).toBe('CC renamed');
});
