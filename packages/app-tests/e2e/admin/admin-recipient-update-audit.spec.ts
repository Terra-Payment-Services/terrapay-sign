/**
 * An admin's recipient update writes a RECIPIENT_UPDATED audit entry. Written from the specification alone.
 *
 * | Test                                                                   | Criterion |
 * | ---------------------------------------------------------------------- | --------- |
 * | an email change writes one entry with an EMAIL diff and the admin as actor | C1    |
 * | name, role and combined changes write one entry each with all diffs     | C2        |
 * | an update that changes nothing writes no entry                          | C3        |
 * | a refused update on a signed or rejected recipient writes no entry      | C4        |
 * | two concurrent updates write two chained entries                        | C5        |
 * | two updates both blocked on the envelope lock still chain               | C5b       |
 * | the owner's document audit log lists the entry                          | C6        |
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { ReadStatus, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';
import { nanoid } from 'nanoid';

import { waitForWaiters, withLock } from '../fixtures/lock-barrier';
import { pause } from '../fixtures/reject-seal';

const baseUrl = NEXT_PUBLIC_WEBAPP_URL();

type Change = { type: string; from: string; to: string };

const signIn = async (email: string): Promise<APIRequestContext> => {
  const context = await request.newContext({ baseURL: baseUrl });
  const { csrfToken } = await (await context.get('/api/auth/csrf')).json();
  const response = await context.post('/api/auth/email-password/authorize', {
    data: { email, password: 'password', csrfToken },
  });

  expect(response.ok()).toBe(true);

  return context;
};

const seedScenario = async (recipientState: Partial<{ signingStatus: SigningStatus; signedAt: Date }> = {}) => {
  const { user: owner, team } = await seedUser();
  const { user: admin } = await seedUser({ isAdmin: true });
  const envelope = await seedPendingDocument(owner, team.id, []);
  const tag = nanoid(8).toLowerCase();

  const recipient = await prisma.recipient.create({
    data: {
      email: `old-${tag}@test.documenso.com`,
      name: `Old Name ${tag}`,
      role: RecipientRole.SIGNER,
      token: nanoid(),
      readStatus: ReadStatus.NOT_OPENED,
      sendStatus: SendStatus.SENT,
      signingStatus: SigningStatus.NOT_SIGNED,
      envelopeId: envelope.id,
      ...recipientState,
    },
  });

  return { owner, admin, team, envelope, recipient, tag };
};

const updateAsAdmin = (
  context: APIRequestContext,
  input: { id: number; name?: string; email?: string; role?: RecipientRole },
) =>
  context.post('/api/trpc/admin.recipient.update', {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });

const recipientEntries = (envelopeId: string) =>
  prisma.documentAuditLog.findMany({
    where: { envelopeId, type: 'RECIPIENT_UPDATED' },
    orderBy: { createdAt: 'asc' },
  });

const changesOf = (entry: { data: unknown }) => (entry.data as { changes: Change[] }).changes;

test.describe.configure({ mode: 'default' });

test('C1: an email change writes one RECIPIENT_UPDATED entry with an EMAIL diff and the admin as actor', async () => {
  const { admin, envelope, recipient, tag } = await seedScenario();
  const newEmail = `new-${tag}@test.documenso.com`;
  const context = await signIn(admin.email);

  const response = await updateAsAdmin(context, { id: recipient.id, email: newEmail });

  expect(response.ok()).toBe(true);
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).email).toBe(newEmail);

  const entries = await recipientEntries(envelope.id);

  expect(entries).toHaveLength(1);
  expect(changesOf(entries[0])).toEqual([{ type: 'EMAIL', from: recipient.email, to: newEmail }]);
  expect((entries[0].data as { recipientId: number }).recipientId).toBe(recipient.id);
  expect(entries[0].userId).toBe(admin.id);
  expect(entries[0].email).toBe(admin.email);

  await context.dispose();
});

test('C2: name and role changes write one entry each, and a combined change writes one entry with every diff', async () => {
  const { admin, envelope, recipient, tag } = await seedScenario();
  const context = await signIn(admin.email);

  expect((await updateAsAdmin(context, { id: recipient.id, name: `New Name ${tag}` })).ok()).toBe(true);

  let entries = await recipientEntries(envelope.id);

  expect(entries).toHaveLength(1);
  expect(changesOf(entries[0])).toEqual([{ type: 'NAME', from: recipient.name, to: `New Name ${tag}` }]);

  expect((await updateAsAdmin(context, { id: recipient.id, role: RecipientRole.APPROVER })).ok()).toBe(true);

  entries = await recipientEntries(envelope.id);

  expect(entries).toHaveLength(2);
  expect(changesOf(entries[1])).toEqual([{ type: 'ROLE', from: 'SIGNER', to: 'APPROVER' }]);

  const combinedEmail = `combined-${tag}@test.documenso.com`;

  expect(
    (
      await updateAsAdmin(context, {
        id: recipient.id,
        name: `Combined ${tag}`,
        email: combinedEmail,
        role: RecipientRole.VIEWER,
      })
    ).ok(),
  ).toBe(true);

  entries = await recipientEntries(envelope.id);

  expect(entries).toHaveLength(3);
  expect(changesOf(entries[2])).toEqual(
    expect.arrayContaining([
      { type: 'NAME', from: `New Name ${tag}`, to: `Combined ${tag}` },
      { type: 'EMAIL', from: recipient.email, to: combinedEmail },
      { type: 'ROLE', from: 'APPROVER', to: 'VIEWER' },
    ]),
  );
  expect(changesOf(entries[2])).toHaveLength(3);

  await context.dispose();
});

test('C3: an update that changes nothing writes no entry', async () => {
  const { admin, envelope, recipient } = await seedScenario();
  const context = await signIn(admin.email);

  const response = await updateAsAdmin(context, {
    id: recipient.id,
    name: recipient.name,
    email: recipient.email,
    role: RecipientRole.SIGNER,
  });

  expect(response.ok()).toBe(true);
  expect(await recipientEntries(envelope.id)).toHaveLength(0);

  await context.dispose();
});

for (const [label, state] of [
  ['signed', { signingStatus: SigningStatus.SIGNED, signedAt: new Date() }],
  ['rejected', { signingStatus: SigningStatus.REJECTED, signedAt: new Date() }],
] as const) {
  test(`C4: a refused update on a ${label} recipient writes no entry and leaves the recipient unchanged`, async () => {
    const { admin, envelope, recipient, tag } = await seedScenario(state);
    const context = await signIn(admin.email);

    const response = await updateAsAdmin(context, {
      id: recipient.id,
      name: `Changed ${tag}`,
      email: `changed-${tag}@test.documenso.com`,
      role: RecipientRole.APPROVER,
    });

    expect(response.ok()).toBe(false);

    const after = await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

    expect(after.email).toBe(recipient.email);
    expect(after.name).toBe(recipient.name);
    expect(after.role).toBe(RecipientRole.SIGNER);
    expect(await recipientEntries(envelope.id)).toHaveLength(0);

    await context.dispose();
  });
}

test('C5: two concurrent updates to one recipient write two chained entries ending at the last one', async () => {
  const { admin, envelope, recipient, tag } = await seedScenario();
  const emailA = `a-${tag}@test.documenso.com`;
  const emailB = `b-${tag}@test.documenso.com`;
  const contextA = await signIn(admin.email);
  const contextB = await signIn(admin.email);

  const [responseA, responseB] = await Promise.all([
    updateAsAdmin(contextA, { id: recipient.id, email: emailA }),
    updateAsAdmin(contextB, { id: recipient.id, email: emailB }),
  ]);

  expect(responseA.ok()).toBe(true);
  expect(responseB.ok()).toBe(true);

  const entries = await recipientEntries(envelope.id);

  expect(entries).toHaveLength(2);

  const [first] = changesOf(entries[0]);
  const [second] = changesOf(entries[1]);

  expect(first.from).toBe(recipient.email);
  expect(second.from).toBe(first.to);
  expect([emailA, emailB].sort()).toEqual([first.to, second.to].sort());
  expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).email).toBe(second.to);

  await contextA.dispose();
  await contextB.dispose();
});

// Each round holds the envelope row lock in a test transaction, starts two updates 100 ms apart (the later one is
// listed first in rounds with an odd index), waits until two backends are blocked behind the holder (pg_blocking_pids), then
// releases. Entries stamped from transaction start can then disagree with the order in which the updates applied.
for (const round of [0, 1, 2, 3]) {
  test(`C5b round ${round}: two updates both blocked on the envelope lock write chained entries`, async () => {
    const { admin, envelope, recipient, tag } = await seedScenario();
    const emails = [`a-${tag}@test.documenso.com`, `b-${tag}@test.documenso.com`];
    const contexts = [await signIn(admin.email), await signIn(admin.email)];
    const order = round % 2 === 0 ? [0, 1] : [1, 0];

    const pending = await withLock(
      (tx) => tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelope.id} FOR NO KEY UPDATE`,
      async (pid) => {
        const requests: Promise<{ ok: () => boolean }>[] = [];

        for (const index of order) {
          requests.push(updateAsAdmin(contexts[index], { id: recipient.id, email: emails[index] }));
          await pause(100);
        }

        expect(await waitForWaiters(pid, 2, 10_000)).toBeGreaterThanOrEqual(2);

        return requests;
      },
    );

    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.ok())).toEqual([true, true]);

    const entries = await prisma.documentAuditLog.findMany({
      where: { envelopeId: envelope.id, type: 'RECIPIENT_UPDATED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    expect(entries).toHaveLength(2);

    const [first] = changesOf(entries[0]);
    const [second] = changesOf(entries[1]);

    expect(first.from).toBe(recipient.email);
    expect(second.from).toBe(first.to);
    expect([...emails].sort()).toEqual([first.to, second.to].sort());
    expect((await prisma.recipient.findUniqueOrThrow({ where: { id: recipient.id } })).email).toBe(second.to);

    await Promise.all(contexts.map((context) => context.dispose()));
  });
}

test("C6: the owner's document audit log lists the entry", async () => {
  const { owner, admin, team, envelope, recipient, tag } = await seedScenario();
  const newEmail = `visible-${tag}@test.documenso.com`;
  const adminContext = await signIn(admin.email);

  expect((await updateAsAdmin(adminContext, { id: recipient.id, email: newEmail })).ok()).toBe(true);

  const ownerContext = await signIn(owner.email);
  const input = encodeURIComponent(
    JSON.stringify({ json: { documentId: mapSecondaryIdToDocumentId(envelope.secondaryId), perPage: 100 } }),
  );
  const response = await ownerContext.get(`/api/trpc/document.auditLog.find?input=${input}`, {
    headers: { 'x-team-id': team.id.toString() },
  });

  expect(response.ok()).toBe(true);

  const body = await response.json();
  const rows: { type: string; data: { changes: Change[] } }[] = body.result.data.json.data;
  const listed = rows.filter((row) => row.type === 'RECIPIENT_UPDATED');

  expect(listed).toHaveLength(1);
  expect(listed[0].data.changes).toEqual([{ type: 'EMAIL', from: recipient.email, to: newEmail }]);

  await adminContext.dispose();
  await ownerContext.dispose();
});
