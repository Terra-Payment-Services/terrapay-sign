/**
 * G1 round 7, C36: no recipient mutation erases the fields of a recipient who
 * has interacted, whatever that recipient's role is now.
 *
 * | Criterion | Test                                                                                |
 * | --------- | ----------------------------------------------------------------------------------- |
 * | C36 (a)   | C36 recipient set-list omitting B (V2 envelope.recipient.set / V1 recipient.setDocumentRecipients) |
 * | C36 (b)   | C36 recipient set-list submitting B as VIEWER (same two routes)                       |
 * | C36 (c)   | C36 recipient deletion of B (API v2 /envelope/recipient/delete / V1 recipient.deleteDocumentRecipient) |
 * | C36 (d)   | C36 recipient update of B to VIEWER (API v2 /envelope/recipient/update-many)          |
 * | C36 ctrl  | C36 control: a CC who never interacted can be removed / switched to VIEWER (2xx)      |
 *
 * Setup as in C35, through real routes only. The seed's signer B (the seed
 * attaches extra fields to B) holds a SIGNATURE field and an optional TEXT
 * field; the seed's signer A stays pending, so the envelope stays PENDING. B
 * signs its SIGNATURE field without completing (NOT_SIGNED, one inserted field
 * with its signature), and an administrator changes B to CC through
 * admin.recipient.update, which keeps B's fields. The owner then tries one
 * mutation per test. Each must be refused with a 4xx, not a 5xx, and leave B,
 * B's inserted SIGNATURE field with its signature, and B's TEXT field in place.
 *
 * The control needs a CC that is NOT_SIGNED and never interacted. A CC added
 * at send time is marked SIGNED by the send, so the control makes signer A a
 * CC through the same admin route instead; A has inserted nothing. Removing A
 * and switching A to VIEWER must both answer 2xx.
 *
 * The administrator works in a browser context of its own so that the admin
 * and owner sessions do not share cookies.
 */
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type Browser, expect, test } from '@playwright/test';
import { FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import {
  adminSession,
  envelopeRow,
  expectOk,
  expectRefused,
  keepRecord,
  type Reply,
  type Seeded,
  seedEnvelope,
  sessionFor,
  signV2,
  trpcRaw,
  v2Post,
} from '../fixtures/reject-seal';

test.describe.configure({ mode: 'default' });

/** Changes `recipientId` to CC through admin.recipient.update, from a separate browser context. */
const adminMakeCc = async (browser: Browser, recipientId: number) => {
  const context = await browser.newContext();

  try {
    const admin = await adminSession(await context.newPage());

    return await trpcRaw(admin, 'admin.recipient.update', { id: recipientId, role: 'CC' });
  } finally {
    await context.close();
  }
};

/** C35's setup: B inserted its SIGNATURE field, did not complete, and is now a CC. Returns B's TEXT field id. */
const seedInteractedCc = async (browser: Browser, request: APIRequestContext) => {
  const seeded = await seedEnvelope(request, {
    bFields: [{ type: FieldType.TEXT, fieldMeta: { type: 'text', required: false, label: 'Optional note' } }],
  });
  const text = seeded.bExtra.find((field) => field.type === FieldType.TEXT);

  if (!text) {
    throw new Error('The seed gave B no optional TEXT field');
  }

  expectOk(await signV2(request, seeded.b), 'B inserts its SIGNATURE field');
  expectOk(await adminMakeCc(browser, seeded.b.id), "the administrator's change of B to CC");

  const b = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.b.id } });
  const signature = await prisma.signature.findFirst({ where: { fieldId: seeded.b.fieldId } });

  expect(b.role, 'premise: B is now a CC').toBe(RecipientRole.CC);
  expect(b.signingStatus, 'premise: B has not completed').toBe(SigningStatus.NOT_SIGNED);
  expect(
    (await prisma.field.findUniqueOrThrow({ where: { id: seeded.b.fieldId } })).inserted,
    "premise: B's SIGNATURE field is inserted",
  ).toBe(true);
  expect(signature, "premise: B's SIGNATURE field has its signature").not.toBeNull();
  expect(
    (await prisma.field.findUniqueOrThrow({ where: { id: text.id } })).inserted,
    "premise: B's TEXT field is not inserted",
  ).toBe(false);
  expect((await envelopeRow(seeded)).status, 'premise: the envelope is PENDING').toBe('PENDING');

  return { seeded, textFieldId: text.id, signatureId: signature?.id };
};

type SetRoute = 'V2 envelope.recipient.set' | 'V1 recipient.setDocumentRecipients';

/** The editor's whole recipient list, with `recipientId` left out or given `role`. */
const recipientSetList = async (
  session: APIRequestContext,
  route: SetRoute,
  seeded: Seeded,
  recipientId: number,
  change: 'omit' | 'VIEWER',
) => {
  const rows = await prisma.recipient.findMany({ where: { envelopeId: seeded.envelopeId }, orderBy: { id: 'asc' } });
  const recipients = rows
    .filter((row) => !(change === 'omit' && row.id === recipientId))
    .map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: change === 'VIEWER' && row.id === recipientId ? RecipientRole.VIEWER : row.role,
      ...(row.signingOrder !== null ? { signingOrder: row.signingOrder } : {}),
    }));

  if (route === 'V2 envelope.recipient.set') {
    return await trpcRaw(
      session,
      'envelope.recipient.set',
      { envelopeId: seeded.envelopeId, envelopeType: 'DOCUMENT', recipients },
      { teamId: seeded.teamId },
    );
  }

  return await trpcRaw(
    session,
    'recipient.setDocumentRecipients',
    { documentId: seeded.documentId, recipients },
    { teamId: seeded.teamId },
  );
};

type DeleteRoute = 'API v2 /envelope/recipient/delete' | 'V1 recipient.deleteDocumentRecipient';

const deleteRecipient = async (
  request: APIRequestContext,
  session: APIRequestContext,
  route: DeleteRoute,
  seeded: Seeded,
  recipientId: number,
) => {
  if (route === 'API v2 /envelope/recipient/delete') {
    return await v2Post(request, seeded.apiToken, '/envelope/recipient/delete', { recipientId });
  }

  return await trpcRaw(session, 'recipient.deleteDocumentRecipient', { recipientId }, { teamId: seeded.teamId });
};

const updateToViewer = async (request: APIRequestContext, seeded: Seeded, recipientId: number) =>
  await v2Post(request, seeded.apiToken, '/envelope/recipient/update-many', {
    envelopeId: seeded.envelopeId,
    data: [{ id: recipientId, role: RecipientRole.VIEWER }],
  });

type Case = { name: string; label: string; attempt: (ctx: Ctx) => Promise<Reply> };
type Ctx = { request: APIRequestContext; session: APIRequestContext; seeded: Seeded; recipientId: number };

const SET_ROUTES: SetRoute[] = ['V2 envelope.recipient.set', 'V1 recipient.setDocumentRecipients'];
const DELETE_ROUTES: DeleteRoute[] = ['API v2 /envelope/recipient/delete', 'V1 recipient.deleteDocumentRecipient'];

const CASES: Case[] = [
  ...SET_ROUTES.map((route) => ({
    name: `(a) recipient set-list omitting B (${route})`,
    label: `a-${route}`,
    attempt: async ({ session, seeded, recipientId }: Ctx) =>
      await recipientSetList(session, route, seeded, recipientId, 'omit'),
  })),
  ...SET_ROUTES.map((route) => ({
    name: `(b) recipient set-list submitting B as VIEWER (${route})`,
    label: `b-${route}`,
    attempt: async ({ session, seeded, recipientId }: Ctx) =>
      await recipientSetList(session, route, seeded, recipientId, 'VIEWER'),
  })),
  ...DELETE_ROUTES.map((route) => ({
    name: `(c) recipient deletion of B (${route})`,
    label: `c-${route}`,
    attempt: async ({ request, session, seeded, recipientId }: Ctx) =>
      await deleteRecipient(request, session, route, seeded, recipientId),
  })),
  {
    name: '(d) recipient update of B to VIEWER (API v2 /envelope/recipient/update-many)',
    label: 'd-update-many',
    attempt: async ({ request, seeded, recipientId }: Ctx) => await updateToViewer(request, seeded, recipientId),
  },
];

for (const testCase of CASES) {
  test(`C36 ${testCase.name} is refused and B's fields survive`, async ({ browser, page, request }) => {
    test.setTimeout(120_000);

    const { seeded, textFieldId, signatureId } = await seedInteractedCc(browser, request);
    const session = await sessionFor(page, seeded.userEmail);

    const reply = await testCase.attempt({ request, session, seeded, recipientId: seeded.b.id });

    const b = await prisma.recipient.findUnique({ where: { id: seeded.b.id } });
    const signatureField = await prisma.field.findUnique({ where: { id: seeded.b.fieldId } });
    const signature = signatureId ? await prisma.signature.findUnique({ where: { id: signatureId } }) : null;
    const text = await prisma.field.findUnique({ where: { id: textFieldId } });

    await keepRecord(`C36-${testCase.label.replace(/[^a-z0-9]+/gi, '-')}.json`, {
      case: testCase.name,
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 400),
      bExists: b !== null,
      bRole: b?.role,
      signatureFieldExists: signatureField !== null,
      signatureFieldInserted: signatureField?.inserted,
      signatureExists: signature !== null,
      textFieldExists: text !== null,
    });

    expectRefused(reply, `${testCase.name}`);
    expect.soft(b, 'B still exists').not.toBeNull();
    expect.soft(signatureField?.inserted, "B's inserted SIGNATURE field still exists").toBe(true);
    expect.soft(signature, "B's signature still exists").not.toBeNull();
    expect.soft(text, "B's TEXT field still exists").not.toBeNull();
  });
}

for (const action of ['removed through envelope.recipient.set', 'switched to VIEWER through update-many'] as const) {
  test(`C36 control: a CC who never interacted can be ${action}`, async ({ browser, page, request }) => {
    test.setTimeout(120_000);

    const seeded = await seedEnvelope(request);

    expectOk(await adminMakeCc(browser, seeded.a.id), "the administrator's change of A to CC");

    const a = await prisma.recipient.findUniqueOrThrow({ where: { id: seeded.a.id } });

    expect(a.role, 'premise: A is a CC').toBe(RecipientRole.CC);
    expect(a.signingStatus, 'premise: A is NOT_SIGNED').toBe(SigningStatus.NOT_SIGNED);
    expect(
      await prisma.field.count({ where: { recipientId: seeded.a.id, inserted: true } }),
      'premise: A has inserted nothing',
    ).toBe(0);

    const session = await sessionFor(page, seeded.userEmail);
    const reply =
      action === 'removed through envelope.recipient.set'
        ? await recipientSetList(session, 'V2 envelope.recipient.set', seeded, seeded.a.id, 'omit')
        : await updateToViewer(request, seeded, seeded.a.id);

    const after = await prisma.recipient.findUnique({ where: { id: seeded.a.id } });

    await keepRecord('C36-control.json', {
      action,
      envelopeId: seeded.envelopeId,
      reply: reply.status,
      body: reply.body.slice(0, 400),
      aAfter: after ? { role: after.role } : null,
    });

    expectOk(reply, `the control: A ${action}`);

    if (action === 'removed through envelope.recipient.set') {
      expect.soft(after, 'A is gone').toBeNull();
    } else {
      expect.soft(after?.role, 'A is a VIEWER').toBe(RecipientRole.VIEWER);
    }
  });
}
