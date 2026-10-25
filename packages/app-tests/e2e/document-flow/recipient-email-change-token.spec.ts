/**
 * #150: changing a recipient's email after sending rotates the signing token,
 * so the old holder's link dies and nothing it does is recorded as the
 * replacement's.
 *
 * | Criterion | Test                                                                                     |
 * | --------- | ---------------------------------------------------------------------------------------- |
 * | C1        | C1 <writer>: the old link answers as an unknown token does                                |
 * | C2        | C2 <writer>: an attempt through the old link records nothing                              |
 * | C3        | C3 <writer>: the replacement starts fresh, is mailed on resend and acts as itself         |
 * | C4        | C4 <writer>: a name-only change / a case-only email change keeps the token                |
 * | C5        | C5 <writer>: an interacted recipient's email change is refused with the existing message  |
 * | C5a       | C5a W3: a role / name change of a recipient with an inserted field keeps the override     |
 * | C6        | C6 the old holder's field insert races the owner's email change: one outcome, never both  |
 * | C8        | C8 next-signer dictation: a new address rotates the token, the same address keeps it     |
 *
 * Writers: W1 is tRPC envelope.recipient.set (setDocumentRecipients), W2 is
 * API v1 PATCH /documents/{id}/recipients/{recipientId} (updateEnvelopeRecipients;
 * C5 also drives it through API v2 update-many, whose refusal body carries the
 * message), and W3 is tRPC admin.recipient.update as a seeded administrator.
 *
 * Setup is through real routes: seedEnvelope sends a PENDING envelope with
 * signers A and B through API v2. The old holder is B at an address of its own
 * (a unique Inbucket mailbox), who opens its link before the change. Every
 * assertion reads the response, the database or the mail catcher.
 *
 * "Answers as an unknown token does" compares each old-link answer (the
 * signing page, envelope.field.sign, recipient.completeDocumentWithToken and
 * recipient.rejectDocumentWithToken) with the answer for a token that never
 * existed: the same status, the same error code and the same error message.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { ReadStatus, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';

import {
  AUDIT,
  adminSession,
  complete,
  dataOf,
  expectOk,
  expectRefused,
  fieldAuditRows,
  isClientError,
  isSuccess,
  keepRecord,
  type Outcome,
  pause,
  QUIET_WINDOW_MS,
  RATE_LIMITED,
  type Reply,
  rateLimited,
  recipientRow,
  reject,
  runIterations,
  type Seeded,
  type Signer,
  seedEnvelope,
  send,
  sessionFor,
  signV2,
  trpcRaw,
  v2Post,
  WEBAPP_BASE_URL,
} from '../fixtures/reject-seal';
import {
  addressFor,
  INBUCKET_URL,
  jsonHeaders,
  readMailbox,
  uniqueLocalPart,
  V1_URL,
  v1Resend,
  waitForMail,
} from '../fixtures/send-path';

test.describe.configure({ mode: 'default' });

const INTERACTED_MESSAGE = 'Cannot modify a recipient who has already interacted with the document';
const ADMIN_SIGNED_MESSAGE = 'Cannot update a recipient that has already signed or rejected.';

type Patch = { email?: string; name?: string; role?: RecipientRole };
type Ctx = { page: Page; request: APIRequestContext; seeded: Seeded };
type Writer = { id: string; label: string; change: (ctx: Ctx, recipientId: number, patch: Patch) => Promise<Reply> };

const W1: Writer = {
  id: 'W1',
  label: 'W1 tRPC envelope.recipient.set',
  change: async ({ page, seeded }, recipientId, patch) => {
    const session = await sessionFor(page, seeded.userEmail);
    const rows = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } });
    const recipients = rows.map((row) => ({
      id: row.id,
      email: row.id === recipientId ? (patch.email ?? row.email) : row.email,
      name: row.id === recipientId ? (patch.name ?? row.name) : row.name,
      role: row.role,
      ...(row.signingOrder !== null ? { signingOrder: row.signingOrder } : {}),
    }));

    return await trpcRaw(
      session,
      'envelope.recipient.set',
      { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', recipients },
      { teamId: seeded.teamId },
    );
  },
};

const W2: Writer = {
  id: 'W2',
  label: 'W2 API v1 PATCH recipient',
  change: async ({ request, seeded }, recipientId, patch) =>
    await send(
      async () =>
        await request.patch(`${V1_URL}/documents/${seeded.documentId}/recipients/${recipientId}`, {
          headers: jsonHeaders(seeded.apiToken),
          data: patch,
        }),
      'API v1 PATCH recipient',
      true,
    ),
};

const W2_V2: Writer = {
  id: 'W2v2',
  label: 'W2 API v2 update-many',
  change: async ({ request, seeded }, recipientId, patch) =>
    await v2Post(request, seeded.apiToken, '/envelope/recipient/update-many', {
      envelopeId: seeded.envelopeId,
      data: [{ id: recipientId, ...patch }],
    }),
};

const W3: Writer = {
  id: 'W3',
  label: 'W3 tRPC admin.recipient.update',
  change: async ({ page }, recipientId, patch) =>
    await trpcRaw(await adminSession(page), 'admin.recipient.update', { id: recipientId, ...patch }),
};

const CHANGE_WRITERS = [W1, W2, W3];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A sent envelope whose signer B sits at its own mailbox, with B's link opened and the invitation delivered. */
const seedOldHolder = async (request: APIRequestContext) => {
  const oldLocal = uniqueLocalPart('old');
  const newLocal = uniqueLocalPart('new');
  const seeded = await seedEnvelope(request, { emails: { b: addressFor(oldLocal) } });

  await waitForMail(request, oldLocal, 1);

  return { seeded, oldLocal, newLocal, newEmail: addressFor(newLocal) };
};

/** The old holder opens the signing page, which marks the recipient OPENED. */
const openLink = async (request: APIRequestContext, token: string) =>
  await request.get(`${WEBAPP_BASE_URL}/sign/${token}`, { maxRedirects: 0 });

const opensLink = async (request: APIRequestContext, seeded: Seeded) => {
  await openLink(request, seeded.b.token);

  await expect
    .poll(async () => (await recipientRow(seeded.b.id))?.readStatus, { message: 'premise: B opened its link' })
    .toBe(ReadStatus.OPENED);

  expect((await recipientRow(seeded.b.id))?.sendStatus, 'premise: B was sent the invitation').toBe(SendStatus.SENT);
};

const unknownToken = () => `unknown${Math.random().toString(36).slice(2, 12)}${Date.now()}`;

const findMessage = (value: unknown): string => {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'message' && typeof inner === 'string') {
        return inner;
      }

      const found = findMessage(inner);

      if (found) {
        return found;
      }
    }
  }

  return '';
};

/** The error code in a tRPC error reply (the AppError code, else the tRPC code), or '' when there is none. */
const codeOf = (reply: Reply) => {
  try {
    const data = (JSON.parse(reply.body) as { error?: { json?: { data?: Record<string, unknown> } } }).error?.json
      ?.data;
    const appError = data?.appError as { code?: unknown } | undefined;
    const code = appError?.code ?? data?.code;

    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
};

/** The error message in a reply with the token masked, so two tokens' answers compare. */
const messageOf = (reply: Reply, token: string) => {
  try {
    return findMessage(JSON.parse(reply.body)).split(token).join('<token>');
  } catch {
    return reply.body.split(token).join('<token>').slice(0, 300);
  }
};

type Attempts = { page: number; field: Reply; complete: Reply; reject: Reply };

/** Every action the signing page offers, through `token` as `signer` (B unless stated). */
const actThrough = async (
  request: APIRequestContext,
  seeded: Seeded,
  token: string,
  signer: Signer = seeded.b,
): Promise<Attempts> => {
  const as = { ...signer, token };

  return {
    page: (await openLink(request, token)).status(),
    field: await signV2(request, as),
    complete: await complete(request, seeded, as),
    reject: await reject(request, seeded, as, 'old holder rejects'),
  };
};

const UNKNOWN_TOKEN_STATUS = 404;
const UNKNOWN_TOKEN_CODE = 'NOT_FOUND';

/**
 * The old token's answers equal the never-issued control token's on every endpoint: the same HTTP status, the
 * same error code and the same message. The control is pinned to 404 NOT_FOUND so a broken control cannot pass.
 */
const expectAnswersAsUnknown = (old: Attempts, oldToken: string, unknown: Attempts, stranger: string) => {
  expect(unknown.page, 'premise: an unknown token shows the not-found page').toBe(UNKNOWN_TOKEN_STATUS);
  expect.soft(old.page, 'the old signing page is not found, as for an unknown token').toBe(unknown.page);

  for (const action of ['field', 'complete', 'reject'] as const) {
    expect(unknown[action].status, `premise: an unknown token on ${action} answers 404`).toBe(UNKNOWN_TOKEN_STATUS);
    expect(codeOf(unknown[action]), `premise: an unknown token on ${action} answers NOT_FOUND`).toBe(
      UNKNOWN_TOKEN_CODE,
    );
    expect.soft(old[action].status, `old link, ${action}: the status of an unknown token`).toBe(unknown[action].status);
    expect
      .soft(codeOf(old[action]), `old link, ${action}: the error code of an unknown token`)
      .toBe(codeOf(unknown[action]));
    expect
      .soft(messageOf(old[action], oldToken), `old link, ${action}: the message of an unknown token`)
      .toBe(messageOf(unknown[action], stranger));
  }
};

const auditCount = async (seeded: Seeded) =>
  await prisma.documentAuditLog.count({ where: { envelopeId: seeded.envelopeId } });

const tokenRow = async (id: number) => await prisma.recipient.findUniqueOrThrow({ where: { id } });

/** The body of the newest message in a mailbox, read with Node's fetch so no trace carries the sender. */
const newestMailBody = async (localPart: string) => {
  const list = (await (await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}`)).json()) as Array<{ id: string }>;
  const last = list[list.length - 1];
  const message = (await (await fetch(`${INBUCKET_URL}/api/v1/mailbox/${localPart}/${last.id}`)).json()) as {
    body?: { text?: string; html?: string };
  };

  return `${message.body?.text ?? ''}\n${message.body?.html ?? ''}`;
};

// ---------------------------------------------------------------------------
// C1, C2, C3
// ---------------------------------------------------------------------------

for (const writer of CHANGE_WRITERS) {
  test(`C1 ${writer.label}: the old link answers as an unknown token does`, async ({ page, request }) => {
    test.setTimeout(180_000);

    const { seeded, newEmail } = await seedOldHolder(request);
    const oldToken = seeded.b.token;

    await opensLink(request, seeded);

    const reply = await writer.change({ page, request, seeded }, seeded.b.id, { email: newEmail });
    const after = await tokenRow(seeded.b.id);

    const stranger = unknownToken();
    const unknown = await actThrough(request, seeded, stranger);
    const old = await actThrough(request, seeded, oldToken);

    await keepRecord(`C1-${writer.id}.json`, {
      writer: writer.label,
      envelopeId: seeded.envelopeId,
      change: { status: reply.status, body: reply.body.slice(0, 300) },
      tokenChanged: after.token !== oldToken,
      emailAfter: after.email,
      unknownAnswers: {
        page: unknown.page,
        field: unknown.field.status,
        complete: unknown.complete.status,
        reject: unknown.reject.status,
      },
      oldAnswers: { page: old.page, field: old.field.status, complete: old.complete.status, reject: old.reject.status },
    });

    expectOk(reply, `${writer.label} changing B's email`);
    expect(after.email, 'the email was changed').toBe(newEmail);
    expect.soft(after.token, 'the token is a new value').not.toBe(oldToken);
    expect.soft(after.token.length, 'the new token is not empty').toBeGreaterThan(0);

    expectAnswersAsUnknown(old, oldToken, unknown, stranger);
  });

  test(`C2 ${writer.label}: an attempt through the old link records nothing`, async ({ page, request }) => {
    test.setTimeout(180_000);

    const { seeded, oldLocal, newLocal, newEmail } = await seedOldHolder(request);
    const oldToken = seeded.b.token;

    await opensLink(request, seeded);

    const reply = await writer.change({ page, request, seeded }, seeded.b.id, { email: newEmail });

    expectOk(reply, `${writer.label} changing B's email`);

    const before = await tokenRow(seeded.b.id);
    const auditsBefore = await auditCount(seeded);
    const oldMailBefore = (await readMailbox(request, oldLocal)).length;

    const attempts = await actThrough(request, seeded, oldToken);

    await pause(QUIET_WINDOW_MS);

    const field = await prisma.field.findUniqueOrThrow({
      where: { id: seeded.b.fieldId },
      include: { signature: true },
    });
    const row = await tokenRow(seeded.b.id);

    await keepRecord(`C2-${writer.id}.json`, {
      writer: writer.label,
      envelopeId: seeded.envelopeId,
      attempts: {
        page: attempts.page,
        field: attempts.field.status,
        complete: attempts.complete.status,
        reject: attempts.reject.status,
      },
      fieldInserted: field.inserted,
      signature: field.signature !== null,
      auditsBefore,
      auditsAfter: await auditCount(seeded),
      signingStatus: row.signingStatus,
      readStatus: row.readStatus,
      sendStatus: row.sendStatus,
    });

    expect.soft(field.inserted, 'no field value was written for the old holder').toBe(false);
    expect.soft(field.signature, 'no signature was written').toBeNull();
    expect
      .soft(
        await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, seeded.b.fieldSecondaryId),
        'no field audit row',
      )
      .toHaveLength(0);
    expect.soft(await auditCount(seeded), 'no audit log entry of any kind').toBe(auditsBefore);
    expect.soft(row.signingStatus, 'no signing status change').toBe(before.signingStatus);
    expect.soft(row.signingStatus, 'B has neither signed nor rejected').toBe(SigningStatus.NOT_SIGNED);
    expect.soft(row.readStatus, 'no read status change').toBe(before.readStatus);
    expect.soft(row.sendStatus, 'no send status change').toBe(before.sendStatus);
    expect.soft((await readMailbox(request, oldLocal)).length, 'no email to the old address').toBe(oldMailBefore);
    expect.soft(await readMailbox(request, newLocal), 'no email to the new address').toHaveLength(0);
  });

  test(`C3 ${writer.label}: the replacement starts fresh, is mailed on resend and acts as itself`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);

    const { seeded, newLocal, newEmail } = await seedOldHolder(request);
    const oldToken = seeded.b.token;

    await opensLink(request, seeded);

    const reply = await writer.change({ page, request, seeded }, seeded.b.id, { email: newEmail });

    expectOk(reply, `${writer.label} changing B's email`);

    const fresh = await tokenRow(seeded.b.id);

    expect.soft(fresh.token, 'the token is a new value').not.toBe(oldToken);
    expect.soft(fresh.sendStatus, 'sendStatus is NOT_SENT').toBe(SendStatus.NOT_SENT);
    expect.soft(fresh.readStatus, 'readStatus is NOT_OPENED').toBe(ReadStatus.NOT_OPENED);

    const resend = await v1Resend(request, seeded.apiToken, seeded.documentId, [seeded.b.id]);

    expect(resend.status(), `the resend: ${await resend.text()}`).toBe(200);

    const mail = await waitForMail(request, newLocal, 1);
    const body = await newestMailBody(newLocal);
    const current = await tokenRow(seeded.b.id);

    expect(mail[0].to.join(' '), 'the email went to the new address').toContain(newLocal);
    expect.soft(body, 'the email carries the new token').toContain(`/sign/${current.token}`);
    expect.soft(body, 'the email does not carry the old token').not.toContain(oldToken);

    const acted = await signV2(request, { ...seeded.b, token: current.token });

    expectOk(acted, 'acting through the new link');

    const rows = await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, seeded.b.fieldSecondaryId);

    await keepRecord(`C3-${writer.id}.json`, {
      writer: writer.label,
      envelopeId: seeded.envelopeId,
      tokenChanged: fresh.token !== oldToken,
      sendStatus: fresh.sendStatus,
      readStatus: fresh.readStatus,
      mailSubjects: mail.map((message) => message.subject),
      fieldAuditEmails: rows.map((row) => row.email),
    });

    expect(rows, 'one field insert recorded').toHaveLength(1);
    expect.soft(rows[0]?.email, 'recorded under the new email').toBe(newEmail);
    expect.soft(dataOf(rows[0]).recipientId, 'recorded against the recipient row').toBe(seeded.b.id);
  });
}

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

for (const writer of CHANGE_WRITERS) {
  const cases = [
    { name: 'a name-only change', patch: (): Patch => ({ name: 'Renamed Signer' }), tag: 'name' },
    {
      name: 'a case-only email change',
      patch: (email: string): Patch => ({ email: email.toUpperCase() }),
      tag: 'case',
    },
  ];

  for (const testCase of cases) {
    test(`C4 ${writer.label}: ${testCase.name} keeps the token and the link`, async ({ page, request }) => {
      test.setTimeout(180_000);

      const seeded = await seedEnvelope(request);
      const before = await tokenRow(seeded.b.id);

      const reply = await writer.change({ page, request, seeded }, seeded.b.id, testCase.patch(before.email));
      const after = await tokenRow(seeded.b.id);
      const linkStatus = (await openLink(request, before.token)).status();
      const acted = await signV2(request, seeded.b);

      await keepRecord(`C4-${writer.id}-${testCase.tag}.json`, {
        writer: writer.label,
        envelopeId: seeded.envelopeId,
        change: { status: reply.status, body: reply.body.slice(0, 300) },
        tokenKept: after.token === before.token,
        nameAfter: after.name,
        emailAfter: after.email,
        linkStatus,
        acted: acted.status,
      });

      expectOk(reply, `${writer.label}: ${testCase.name}`);
      expect.soft(after.token, 'the token is kept').toBe(before.token);
      expect.soft(after.email.toLowerCase(), 'the address is the same one').toBe(before.email.toLowerCase());

      if (testCase.tag === 'name') {
        expect.soft(after.name, 'the name changed').toBe('Renamed Signer');
      }

      expect.soft(linkStatus, 'the existing link still opens').toBe(200);
      expectOk(acted, 'the existing link still signs');
      expect((await tokenRow(seeded.b.id)).signingStatus, 'B is still a live signer').toBe(SigningStatus.NOT_SIGNED);
      expect(before.role).toBe(RecipientRole.SIGNER);
    });
  }
}

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

type Interaction = 'inserted a field' | 'signed' | 'rejected';

const interact = async (request: APIRequestContext, seeded: Seeded, how: Interaction) => {
  if (how === 'rejected') {
    expectOk(await reject(request, seeded, seeded.b, 'B rejects before the change'), 'B rejects');
    return;
  }

  expectOk(await signV2(request, seeded.b), 'B inserts its field');

  if (how === 'signed') {
    expectOk(await complete(request, seeded, seeded.b), 'B completes');
  }
};

const C5_CASES: Array<{ writer: Writer; how: Interaction; message: string }> = [
  { writer: W1, how: 'inserted a field', message: INTERACTED_MESSAGE },
  { writer: W2_V2, how: 'inserted a field', message: INTERACTED_MESSAGE },
  { writer: W3, how: 'inserted a field', message: ADMIN_SIGNED_MESSAGE },
  { writer: W3, how: 'signed', message: ADMIN_SIGNED_MESSAGE },
  { writer: W3, how: 'rejected', message: ADMIN_SIGNED_MESSAGE },
];

for (const { writer, how, message } of C5_CASES) {
  test(`C5 ${writer.label}: a recipient who ${how} cannot have the email changed`, async ({ page, request }) => {
    test.setTimeout(180_000);

    const { seeded, newEmail } = await seedOldHolder(request);

    await interact(request, seeded, how);

    const before = await tokenRow(seeded.b.id);
    const reply = await writer.change({ page, request, seeded }, seeded.b.id, { email: newEmail });
    const after = await tokenRow(seeded.b.id);

    await keepRecord(`C5-${writer.id}-${how.replace(/ /g, '-')}.json`, {
      writer: writer.label,
      how,
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 400),
      emailBefore: before.email,
      emailAfter: after.email,
      tokenKept: after.token === before.token,
    });

    expectRefused(reply, `${writer.label} after the recipient ${how}`);
    expect.soft(reply.body, 'the existing refusal message').toContain(message);
    expect.soft(after.email, 'the email is unchanged').toBe(before.email);
    expect.soft(after.token, 'the token is unchanged').toBe(before.token);
  });
}

// ---------------------------------------------------------------------------
// C5a
// ---------------------------------------------------------------------------

// "Unchanged email" is covered both ways: the role case omits the email, the name case sends the same address
// upper-cased, which compares equal case-insensitively.
const C5A_CASES: Array<{ name: string; tag: string; edit: (email: string) => Patch }> = [
  { name: 'a role change to CC, no email in the request', tag: 'role', edit: () => ({ role: RecipientRole.CC }) },
  {
    name: 'a name change, the same email upper-cased',
    tag: 'name',
    edit: (email) => ({ name: 'Admin Renamed', email: email.toUpperCase() }),
  },
];

for (const testCase of C5A_CASES) {
  test(`C5a ${W3.label}: ${testCase.name} for a recipient with an inserted field succeeds and keeps the token; with a new email it is refused`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const { seeded, newEmail } = await seedOldHolder(request);

    await interact(request, seeded, 'inserted a field');

    const before = await tokenRow(seeded.b.id);
    const edit = testCase.edit(before.email);
    const allowed = await W3.change({ page, request, seeded }, seeded.b.id, edit);
    const afterAllowed = await tokenRow(seeded.b.id);
    const refused = await W3.change({ page, request, seeded }, seeded.b.id, { ...edit, email: newEmail });
    const afterRefused = await tokenRow(seeded.b.id);

    await keepRecord(`C5a-W3-${testCase.tag}.json`, {
      writer: W3.label,
      envelopeId: seeded.envelopeId,
      allowed: { status: allowed.status, body: allowed.body.slice(0, 300) },
      refused: { status: refused.status, body: refused.body.slice(0, 400) },
      tokenKeptByAllowed: afterAllowed.token === before.token,
      roleAfterAllowed: afterAllowed.role,
      nameAfterAllowed: afterAllowed.name,
      emailAfterRefused: afterRefused.email,
      tokenKeptByRefused: afterRefused.token === afterAllowed.token,
    });

    expectOk(allowed, `${W3.label}: ${testCase.name}`);
    expect.soft(afterAllowed.token === before.token, 'the permitted edit keeps the token').toBe(true);
    expect
      .soft(afterAllowed.email.toLowerCase(), 'the permitted edit keeps the address')
      .toBe(before.email.toLowerCase());

    if (testCase.tag === 'role') {
      expect.soft(afterAllowed.role, 'the role changed').toBe(RecipientRole.CC);
    } else {
      expect.soft(afterAllowed.name, 'the name changed').toBe('Admin Renamed');
    }

    expect
      .soft(refused.status, `the same edit with a new email is refused: ${refused.body.slice(0, 300)}`)
      .not.toBe(RATE_LIMITED);
    expect
      .soft(isClientError(refused), `the same edit with a new email is refused with a 4xx: ${refused.status}`)
      .toBe(true);
    expect.soft(refused.body, 'the existing admin refusal message').toContain(ADMIN_SIGNED_MESSAGE);
    expect.soft(afterRefused.email, 'the refused edit leaves the email').toBe(afterAllowed.email);
    expect.soft(afterRefused.token === afterAllowed.token, 'the refused edit leaves the token').toBe(true);
    expect.soft(afterRefused.role, 'the refused edit leaves the role').toBe(afterAllowed.role);
    expect.soft(afterRefused.name, 'the refused edit leaves the name').toBe(afterAllowed.name);
  });
}

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

test('C6 the old holder inserting a field races the owner changing the email: one outcome, never both', async ({
  request,
}) => {
  test.setTimeout(900_000);

  // The change goes through API v1's token lookup first, so with no delay the insert tends to win. The insert is
  // held back by a growing number of milliseconds so that some iterations let the change commit first.
  const insertDelaysMs = [0, 20, 40, 60, 80, 100, 130, 160];
  let started = 0;

  await runIterations(
    'C6',
    async (): Promise<Outcome> => {
      const { seeded, newEmail } = await seedOldHolder(request);
      const oldToken = seeded.b.token;
      const insertDelayMs = insertDelaysMs[started++ % insertDelaysMs.length];

      const [insert, change] = await Promise.all([
        pause(insertDelayMs).then(async () => await signV2(request, seeded.b, undefined, false)),
        send(
          async () =>
            await request.patch(`${V1_URL}/documents/${seeded.documentId}/recipients/${seeded.b.id}`, {
              headers: jsonHeaders(seeded.apiToken),
              data: { email: newEmail },
            }),
          'API v1 PATCH recipient',
          false,
        ),
      ]);

      const limited = rateLimited(seeded, { insert, change });

      if (limited) {
        return limited;
      }

      const row = await tokenRow(seeded.b.id);
      const field = await prisma.field.findUniqueOrThrow({
        where: { id: seeded.b.fieldId },
        include: { signature: true },
      });
      const audits = await fieldAuditRows(seeded.envelopeId, AUDIT.FIELD_INSERTED, seeded.b.fieldSecondaryId);
      const emailChanged = row.email === newEmail;
      const tokenRotated = row.token !== oldToken;
      const inserted = field.inserted;

      const fieldWins = inserted && !emailChanged && isSuccess(insert) && isClientError(change) && audits.length === 1;
      const changeWins =
        emailChanged &&
        tokenRotated &&
        !inserted &&
        field.signature === null &&
        audits.length === 0 &&
        isSuccess(change) &&
        isClientError(insert);

      const verdict =
        fieldWins || changeWins
          ? null
          : `neither allowed outcome: inserted=${inserted} emailChanged=${emailChanged} tokenRotated=${tokenRotated} ` +
            `fieldAudits=${audits.length} insert=${insert.status} change=${change.status}`;

      return {
        verdict,
        record: {
          envelopeId: seeded.envelopeId,
          outcome: fieldWins
            ? 'field inserted, change refused'
            : changeWins
              ? 'change applied, insert refused'
              : 'both or neither',
          insertDelayMs,
          insert: insert.status,
          change: change.status,
          changeBody: change.body.slice(0, 300),
          inserted,
          emailChanged,
          tokenRotated,
          fieldAudits: audits.length,
          rateLimitStatus: RATE_LIMITED,
        },
      };
    },
    insertDelaysMs.length,
  );
});

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

/**
 * A sequential envelope with dictation on. The fixture puts its signer B first (order 1) and A second (order 2),
 * so here the fixture's B is the completer who dictates, and the fixture's A is the recipient being replaced (the
 * spec's "B"). A sits at a mailbox of its own and is marked OPENED first, so readStatus NOT_OPENED afterwards means
 * something.
 */
const seedDictation = async (request: APIRequestContext) => {
  const oldLocal = uniqueLocalPart('dict-old');
  const newLocal = uniqueLocalPart('dict-new');
  const seeded = await seedEnvelope(request, {
    signingOrder: 'SEQUENTIAL',
    allowDictateNextSigner: true,
    emails: { a: addressFor(oldLocal) },
  });
  const rows = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId } });

  expect(rows.find((row) => row.id === seeded.b.id)?.signingOrder, 'premise: the completer is first').toBe(1);
  expect(rows.find((row) => row.id === seeded.a.id)?.signingOrder, 'premise: the replaced recipient is second').toBe(2);

  // Opening the link before the recipient's turn does not mark it OPENED, so the premise
  // is written directly: the replaced recipient had opened an earlier invitation.
  await prisma.recipient.update({ where: { id: seeded.a.id }, data: { readStatus: ReadStatus.OPENED } });

  return { seeded, oldLocal, newLocal, newEmail: addressFor(newLocal) };
};

/** The completer signs its field and completes, dictating `nextSigner`. */
const completeDictating = async (
  request: APIRequestContext,
  seeded: Seeded,
  nextSigner: { email: string; name: string },
) => {
  expectOk(await signV2(request, seeded.b), 'the completer signs its field');
  expectOk(await complete(request, seeded, seeded.b, { nextSigner }), 'the completer completes, dictating');
};

test('C8 dictating a new address: the next signer gets a new token, NOT_OPENED, the old link answers as unknown, the invitation carries the new link', async ({
  request,
}) => {
  test.setTimeout(240_000);

  const { seeded, oldLocal, newLocal, newEmail } = await seedDictation(request);
  const oldToken = seeded.a.token;

  await completeDictating(request, seeded, { email: newEmail, name: 'Dictated Signer' });

  const after = await tokenRow(seeded.a.id);
  const mail = await waitForMail(request, newLocal, 1);
  const body = await newestMailBody(newLocal);

  // The invitation is read before anything acts through the old link: on unfixed code that link still works and
  // would complete the envelope, mailing the dictated address again.
  const stranger = unknownToken();
  const unknown = await actThrough(request, seeded, stranger, seeded.a);
  const old = await actThrough(request, seeded, oldToken, seeded.a);

  await keepRecord('C8-new-address.json', {
    envelopeId: seeded.envelopeId,
    emailAfter: after.email,
    tokenChanged: after.token !== oldToken,
    readStatusAfter: after.readStatus,
    mailTo: mail.map((message) => message.to.join(' ')),
    mailCarriesNewToken: body.includes(`/sign/${after.token}`),
    mailCarriesOldToken: body.includes(oldToken),
    oldMailbox: (await readMailbox(request, oldLocal)).length,
    unknownAnswers: {
      page: unknown.page,
      field: [unknown.field.status, codeOf(unknown.field)],
      complete: [unknown.complete.status, codeOf(unknown.complete)],
      reject: [unknown.reject.status, codeOf(unknown.reject)],
    },
    oldAnswers: {
      page: old.page,
      field: [old.field.status, codeOf(old.field)],
      complete: [old.complete.status, codeOf(old.complete)],
      reject: [old.reject.status, codeOf(old.reject)],
    },
  });

  expect(after.email, 'premise: the dictated address was applied').toBe(newEmail);
  expect.soft(after.token === oldToken, 'the token is a new value').toBe(false);
  expect.soft(after.readStatus, 'readStatus is NOT_OPENED').toBe(ReadStatus.NOT_OPENED);
  expect(mail[0].to.join(' '), 'the invitation went to the dictated address').toContain(newLocal);
  // Booleans rather than the body, so a failure prints no signing token.
  expect.soft(body.includes(`/sign/${after.token}`), 'the invitation carries the current token').toBe(true);
  expect.soft(body.includes(oldToken), 'the invitation does not carry the old token').toBe(false);

  expectAnswersAsUnknown(old, oldToken, unknown, stranger);
});

test('C8 dictating the same address in different case keeps the token and the link', async ({ request }) => {
  test.setTimeout(180_000);

  const { seeded } = await seedDictation(request);
  const before = await tokenRow(seeded.a.id);

  await completeDictating(request, seeded, { email: before.email.toUpperCase(), name: 'Same Person' });

  const after = await tokenRow(seeded.a.id);
  const linkStatus = (await openLink(request, before.token)).status();

  await keepRecord('C8-same-address.json', {
    envelopeId: seeded.envelopeId,
    emailBefore: before.email,
    emailAfter: after.email,
    tokenKept: after.token === before.token,
    linkStatus,
  });

  expect.soft(after.email.toLowerCase(), 'the address is the same one').toBe(before.email.toLowerCase());
  expect.soft(after.token === before.token, 'the token is kept').toBe(true);
  expect.soft(linkStatus, 'the existing link still opens').toBe(200);
  expectOk(await signV2(request, seeded.a), 'the existing link still signs');
});
