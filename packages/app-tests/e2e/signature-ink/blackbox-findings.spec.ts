/**
 * Findings of the G4 black-box pass (G4 spec, "Round after the black-box pass", C105 to C107).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md) and the black-box
 * report (G4/blackbox/run/signature-verification-g4.md, G4-01, G4-03 and G4-05) before any fix, without reading
 * the sign handlers. Every envelope is seeded here; none of the black-box fixture's rows are used. Sessions are
 * seeded rows with a signed cookie, so no test spends the instance-wide sign-in limit.
 *
 * | Criterion | Test                                                                                        |
 * | --------- | ------------------------------------------------------------------------------------------- |
 * | C105      | C105 <route>: a typed signature with a control character inside is refused with 400          |
 * | C105      | C105 signup: a typed signature with NUL inside is refused and creates no user                |
 * | C105b     | C105b <route>: a Cc character at either end of a typed signature is refused with 400         |
 * | C105c     | C105c direct template V<n>: text, NAME and optional text values are trimmed as before c71141c44 |
 * | C106      | C106 <envelope> waiting page: 200 with the waiting content for every visitor                 |
 * | C107      | C107 the API certificate of a pending envelope answers 4xx; a completed one answers 200      |
 *
 * C105's routes are the ones that store a typed signature: profile.updateProfile, signup, V2
 * envelope.field.sign, V1 field.signFieldWithToken and template.createDocumentFromDirectTemplate (V1 and V2
 * templates). The embeds send through these same procedures (field.signFieldWithToken and
 * template.createDocumentFromDirectTemplate), so they are covered by the route cases. Each refusal must be 400
 * with an AppError code, write nothing, and carry no database text ("prisma" or "SQLSTATE"); a valid value on the
 * same field, template or profile must succeed afterwards. Signup is limited to 3 per IP per 3 hours, so its case
 * sends one refused value (NUL) and one valid control, and fails as a test defect on a 429.
 */
import { FIELD_META_DEFAULT_VALUES } from '@documenso/lib/types/field-meta';
import { prisma } from '@documenso/prisma';
import { seedOrganisationMembers } from '@documenso/prisma/seed/organisations';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import { keepRecord, type Reply } from '../fixtures/reject-seal';
import {
  API_V2,
  createG4Owner,
  errorOf,
  expectSignatureAccepted,
  fieldAuditRowsOf,
  fieldState,
  type G4Owner,
  type G4Seeded,
  SESSION_COOKIE,
  seedG4DirectTemplate,
  seedG4Envelope,
  seedOneSigner,
  seedSessionCookie,
  signSignature,
  submitDirectTemplate,
  teamRowCounts,
  trpcAsUser,
  trpcWithDates,
  uniqueStamp,
  validInkedDataUrl,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const CONTROL_NAME = 'Control Signer';

/** Typed values with a Unicode Cc control character inside, not alone (spec C105; black-box G4-01). */
const CONTROL_VALUES: Record<string, string> = {
  'U+0000': 'G4\u0000Mark',
  'U+0007': 'G4\u0007Mark',
  'U+009F': 'G4\u009FMark',
};

const DATABASE_TEXT = /prisma|sqlstate/i;

/** C105's refusal: 400, an AppError code, and no database text in the body. */
const expectControlRefusal = (reply: Reply, what: string) => {
  expect(reply.status, `${what}: a 429 from the rate limiter is a test defect, not a result`).not.toBe(429);
  expect.soft(reply.status, `${what}: answers 400, got ${reply.status} ${reply.body.slice(0, 200)}`).toBe(400);
  expect.soft(errorOf(reply).code, `${what}: the body carries an AppError code`).toBeTruthy();
  expect.soft(DATABASE_TEXT.test(reply.body), `${what}: the body carries no database text`).toBe(false);
};

// ---------------------------------------------------------------------------
// C105 field routes
// ---------------------------------------------------------------------------

for (const version of [1, 2] as const) {
  const route = version === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign';

  for (const [name, value] of Object.entries(CONTROL_VALUES)) {
    test(`C105 ${route}: a typed signature with ${name} inside is refused with 400`, async ({ request }) => {
      const seeded = await seedOneSigner(version);
      const field = seeded.r.s1.fields.sig;
      const before = await fieldState(field.id);
      const auditBefore = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;

      expect(value.length, 'premise: the control character sits inside the value').toBe(7);

      const reply = await signSignature(request, seeded, seeded.r.s1.token, field.id, value, { isBase64: false });

      await keepRecord(`C105-v${version}-${name}.json`, { status: reply.status, body: reply.body.slice(0, 2000) });

      expectControlRefusal(reply, `${route} ${name}`);
      expect
        .soft(await fieldState(field.id), `${route} ${name}: the field and its Signature row are unchanged`)
        .toEqual(before);
      expect
        .soft((await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length, `${route} ${name}: no audit row`)
        .toBe(auditBefore);

      const control = await signSignature(request, seeded, seeded.r.s1.token, field.id, CONTROL_NAME);

      await expectSignatureAccepted(control, seeded, field, { typed: CONTROL_NAME }, `${route} ${name}: control`);
    });
  }
}

// ---------------------------------------------------------------------------
// C105 direct template
// ---------------------------------------------------------------------------

for (const version of [1, 2] as const) {
  for (const [name, value] of Object.entries(CONTROL_VALUES)) {
    test(`C105 direct template V${version}: a typed signature with ${name} inside is refused with 400`, async ({
      request,
    }) => {
      const template = await seedG4DirectTemplate(version);
      const rowsBefore = await teamRowCounts(template.owner.team.id);
      const reply = await submitDirectTemplate(request, template, { value, isBase64: false });
      const rowsAfter = await teamRowCounts(template.owner.team.id);

      await keepRecord(`C105-dt-v${version}-${name}.json`, {
        status: reply.status,
        body: reply.body.slice(0, 2000),
        rowsBefore,
        rowsAfter,
      });

      expectControlRefusal(reply, `direct template V${version} ${name}`);
      expect
        .soft(rowsAfter, `direct template V${version} ${name}: no Envelope, Recipient, Field or Signature row`)
        .toEqual(rowsBefore);

      const control = await submitDirectTemplate(request, template, { value: CONTROL_NAME, isBase64: false });

      expect(control.status, `direct template V${version} ${name}: a valid submission afterwards`).toBe(200);
    });
  }
}

// ---------------------------------------------------------------------------
// C105 profile
// ---------------------------------------------------------------------------

for (const [name, value] of Object.entries(CONTROL_VALUES)) {
  test(`C105 profile.updateProfile: a typed signature with ${name} inside is refused with 400`, async ({ request }) => {
    const owner = await createG4Owner();
    const cookie = await seedSessionCookie(owner.user.id);
    const userName = owner.user.name ?? 'G4 Profile';
    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const reply = await trpcAsUser(request, 'profile.updateProfile', { name: userName, signature: value }, { cookie });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });

    await keepRecord(`C105-profile-${name}.json`, { status: reply.status, body: reply.body.slice(0, 2000) });

    expectControlRefusal(reply, `profile ${name}`);
    expect
      .soft({ name: after.name, signature: after.signature }, `profile ${name}: the user row is unchanged`)
      .toEqual({ name: before.name, signature: before.signature });

    const control = await trpcAsUser(
      request,
      'profile.updateProfile',
      { name: userName, signature: CONTROL_NAME },
      { cookie },
    );
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });

    expect(control.status, `profile ${name}: a valid typed signature afterwards answers 200`).toBe(200);
    expect(saved.signature, `profile ${name}: the valid signature is stored`).toBe(CONTROL_NAME);
  });
}

// ---------------------------------------------------------------------------
// C105 signup
// ---------------------------------------------------------------------------

test('C105 signup: a typed signature with NUL inside is refused and creates no user', async ({ request }) => {
  const signup = async (email: string, signature: string) => {
    const res = await request.post(`${WEBAPP_BASE_URL}/api/auth/email-password/signup`, {
      headers: { 'content-type': 'application/json' },
      data: { name: 'G4 Signup', email, password: 'G4-signup-Password-1!', signature },
    });

    return { status: res.status(), body: await res.text(), retryAfterMs: null } satisfies Reply;
  };

  const refusedEmail = `g4-c105-nul-${uniqueStamp()}@test.documenso.com`;
  const refused = await signup(refusedEmail, CONTROL_VALUES['U+0000']);

  await keepRecord('C105-signup-U+0000.json', { status: refused.status, body: refused.body.slice(0, 2000) });

  expect(
    refused.status,
    'test defect, not a result: signup answered 429 (3 per IP per 3 hours); run this case in a fresh window',
  ).not.toBe(429);
  expectControlRefusal(refused, 'signup U+0000');
  expect.soft(await prisma.user.count({ where: { email: refusedEmail } }), 'signup U+0000: no user is created').toBe(0);

  const controlEmail = `g4-c105-ok-${uniqueStamp()}@test.documenso.com`;
  const control = await signup(controlEmail, CONTROL_NAME);

  expect(control.status, 'test defect, not a result: the control signup answered 429').not.toBe(429);
  // The signup route answers 201 Created (C34).
  expect(control.status, `signup control: a valid typed signature succeeds (${control.body.slice(0, 200)})`).toBe(201);
  expect(await prisma.user.count({ where: { email: controlEmail } }), 'signup control: the user exists').toBe(1);
});

// ---------------------------------------------------------------------------
// C105b: control characters at either end (G4 spec, "Round after Codex r5")
//
// The rule is checked on the value as received, before any trimming. U+0009 to U+000D are removed by
// String.prototype.trim, so at an end they were accepted. U+0085 is not removed by trim and is the guard.
// ---------------------------------------------------------------------------

const EDGE_VALUES: Record<string, string> = {
  'leading U+0009': '\u0009Alice',
  'trailing U+000A': 'Alice\u000A',
  'trailing U+000D': 'Alice\u000D',
  'leading U+000B': '\u000BAlice',
  'trailing U+000C': 'Alice\u000C',
  'trailing U+0085': 'Alice\u0085',
};

const SPACED_VALUE = '  Alice  ';
const SPACED_STORED = 'Alice';

const caseSlug = (name: string) => name.replace(/[^a-z0-9+]+/gi, '-');

for (const version of [1, 2] as const) {
  const route = version === 1 ? 'V1 field.signFieldWithToken' : 'V2 envelope.field.sign';

  for (const [name, value] of Object.entries(EDGE_VALUES)) {
    test(`C105b ${route}: a typed signature with a ${name} is refused with 400`, async ({ request }) => {
      const seeded = await seedOneSigner(version);
      const field = seeded.r.s1.fields.sig;
      const before = await fieldState(field.id);
      const auditBefore = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;
      const reply = await signSignature(request, seeded, seeded.r.s1.token, field.id, value, { isBase64: false });

      await keepRecord(`C105b-v${version}-${caseSlug(name)}.json`, {
        status: reply.status,
        body: reply.body.slice(0, 2000),
      });

      expectControlRefusal(reply, `${route} ${name}`);
      expect
        .soft(await fieldState(field.id), `${route} ${name}: the field and its Signature row are unchanged`)
        .toEqual(before);
      expect
        .soft((await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length, `${route} ${name}: no audit row`)
        .toBe(auditBefore);

      const control = await signSignature(request, seeded, seeded.r.s1.token, field.id, CONTROL_NAME);

      await expectSignatureAccepted(control, seeded, field, { typed: CONTROL_NAME }, `${route} ${name}: control`);
    });
  }

  test(`C105b ${route}: a typed signature with plain spaces at both ends is accepted and stored trimmed`, async ({
    request,
  }) => {
    const seeded = await seedOneSigner(version);
    const field = seeded.r.s1.fields.sig;
    const reply = await signSignature(request, seeded, seeded.r.s1.token, field.id, SPACED_VALUE, { isBase64: false });

    await keepRecord(`C105b-v${version}-spaces.json`, { status: reply.status, body: reply.body.slice(0, 2000) });

    await expectSignatureAccepted(reply, seeded, field, { typed: SPACED_STORED }, `${route} spaces`);
  });
}

for (const version of [1, 2] as const) {
  for (const [name, value] of Object.entries(EDGE_VALUES)) {
    test(`C105b direct template V${version}: a typed signature with a ${name} is refused with 400`, async ({
      request,
    }) => {
      const template = await seedG4DirectTemplate(version);
      const rowsBefore = await teamRowCounts(template.owner.team.id);
      const reply = await submitDirectTemplate(request, template, { value, isBase64: false });
      const rowsAfter = await teamRowCounts(template.owner.team.id);

      await keepRecord(`C105b-dt-v${version}-${caseSlug(name)}.json`, {
        status: reply.status,
        body: reply.body.slice(0, 2000),
        rowsBefore,
        rowsAfter,
      });

      expectControlRefusal(reply, `direct template V${version} ${name}`);
      expect
        .soft(rowsAfter, `direct template V${version} ${name}: no Envelope, Recipient, Field or Signature row`)
        .toEqual(rowsBefore);

      const control = await submitDirectTemplate(request, template, { value: CONTROL_NAME, isBase64: false });

      expect(control.status, `direct template V${version} ${name}: a valid submission afterwards`).toBe(200);
    });
  }

  test(`C105b direct template V${version}: a typed signature with plain spaces at both ends is accepted and stored trimmed`, async ({
    request,
  }) => {
    const template = await seedG4DirectTemplate(version);
    const email = `g4-c105b-${uniqueStamp()}@test.documenso.com`;
    const reply = await submitDirectTemplate(request, template, { value: SPACED_VALUE, isBase64: false }, { email });
    const stored = await prisma.signature.findMany({ where: { recipient: { email } } });

    await keepRecord(`C105b-dt-v${version}-spaces.json`, {
      status: reply.status,
      body: reply.body.slice(0, 2000),
      stored: stored.map((row) => row.typedSignature),
    });

    expect(reply.status, `direct template V${version} spaces: answers 200 (${reply.body.slice(0, 200)})`).toBe(200);
    expect(
      stored.map((row) => row.typedSignature),
      `direct template V${version} spaces: stored trimmed`,
    ).toEqual([SPACED_STORED]);
  });
}

for (const [name, value] of Object.entries(EDGE_VALUES)) {
  test(`C105b profile.updateProfile: a typed signature with a ${name} is refused with 400`, async ({ request }) => {
    const owner = await createG4Owner();
    const cookie = await seedSessionCookie(owner.user.id);
    const userName = owner.user.name ?? 'G4 Profile';
    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const reply = await trpcAsUser(request, 'profile.updateProfile', { name: userName, signature: value }, { cookie });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });

    await keepRecord(`C105b-profile-${caseSlug(name)}.json`, { status: reply.status, body: reply.body.slice(0, 2000) });

    expectControlRefusal(reply, `profile ${name}`);
    expect
      .soft({ name: after.name, signature: after.signature }, `profile ${name}: the user row is unchanged`)
      .toEqual({ name: before.name, signature: before.signature });

    const control = await trpcAsUser(
      request,
      'profile.updateProfile',
      { name: userName, signature: CONTROL_NAME },
      { cookie },
    );
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });

    expect(control.status, `profile ${name}: a valid typed signature afterwards answers 200`).toBe(200);
    expect(saved.signature, `profile ${name}: the valid signature is stored`).toBe(CONTROL_NAME);
  });
}

test('C105b profile.updateProfile: a typed signature with plain spaces at both ends is accepted and stored trimmed', async ({
  request,
}) => {
  const owner = await createG4Owner();
  const cookie = await seedSessionCookie(owner.user.id);
  const userName = owner.user.name ?? 'G4 Profile';
  const reply = await trpcAsUser(
    request,
    'profile.updateProfile',
    { name: userName, signature: SPACED_VALUE },
    { cookie },
  );
  const saved = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });

  await keepRecord('C105b-profile-spaces.json', {
    status: reply.status,
    body: reply.body.slice(0, 2000),
    stored: saved.signature,
  });

  expect(reply.status, `profile spaces: answers 200 (${reply.body.slice(0, 200)})`).toBe(200);
  expect(saved.signature, 'profile spaces: stored trimmed').toBe(SPACED_STORED);
});

// ---------------------------------------------------------------------------
// C106
// ---------------------------------------------------------------------------

const WAITING_TEXT = 'Waiting for Your Turn';

type WaitingCase = { label: string; seed: (owner: G4Owner) => Promise<{ seeded: G4Seeded; waitingToken: string }> };

const WAITING_CASES: WaitingCase[] = [
  {
    label: 'V2 sequential, signer 2',
    seed: async (owner) => {
      const seeded = await seedG4Envelope({
        internalVersion: 2,
        owner,
        signingOrder: 'SEQUENTIAL',
        recipients: [
          { key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
          { key: 's2', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
        ],
      });

      return { seeded, waitingToken: seeded.r.s2.token };
    },
  },
  {
    label: 'V2 after an assistant, the first signer',
    seed: async (owner) => {
      const seeded = await seedG4Envelope({
        internalVersion: 2,
        owner,
        signingOrder: 'SEQUENTIAL',
        recipients: [
          { key: 'asst', signingOrder: 1, role: RecipientRole.ASSISTANT, fields: [] },
          { key: 's1', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
          { key: 's2', signingOrder: 3, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
        ],
      });

      return { seeded, waitingToken: seeded.r.s1.token };
    },
  },
  {
    label: 'V1 sequential, signer 2',
    seed: async (owner) => {
      const seeded = await seedG4Envelope({
        internalVersion: 1,
        owner,
        signingOrder: 'SEQUENTIAL',
        recipients: [
          { key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
          { key: 's2', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
        ],
      });

      return { seeded, waitingToken: seeded.r.s2.token };
    },
  },
];

const getPage = async (request: APIRequestContext, url: string, cookie: string | null) => {
  const res = await request.get(url, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
    maxRedirects: 0,
  });

  return { status: res.status(), location: res.headers().location ?? null, body: await res.text() };
};

for (const waiting of WAITING_CASES) {
  test(`C106 ${waiting.label} waiting page: 200 with the waiting content for every visitor`, async ({ request }) => {
    const owner = await createG4Owner();
    const { seeded, waitingToken } = await waiting.seed(owner);
    const [member] = await seedOrganisationMembers({
      members: [
        { name: 'G4 Member', email: `g4-c106-m-${uniqueStamp()}@test.documenso.com`, organisationRole: 'MEMBER' },
      ],
      organisationId: owner.organisation.id,
    });
    const outsider = await createG4Owner();
    const savedSigner = await createG4Owner();

    await prisma.user.update({ where: { id: savedSigner.user.id }, data: { signature: validInkedDataUrl() } });

    const signLink = await getPage(request, `${WEBAPP_BASE_URL}/sign/${waitingToken}`, null);

    expect(
      signLink.location ?? '',
      `premise: signed out, the signing link redirects to its waiting page (${signLink.status})`,
    ).toContain(`/sign/${waitingToken}/waiting`);

    const visitors: Array<{ who: string; userId: number | null }> = [
      { who: 'signed out', userId: null },
      { who: 'the envelope owner', userId: owner.user.id },
      { who: 'an organisation member', userId: member.id },
      { who: 'an owner of another organisation', userId: outsider.user.id },
      { who: 'an outside user with a saved signature', userId: savedSigner.user.id },
    ];
    const results: Array<Record<string, unknown>> = [];

    for (const visitor of visitors) {
      const cookie = visitor.userId === null ? null : await seedSessionCookie(visitor.userId);
      const page = await getPage(request, `${WEBAPP_BASE_URL}/sign/${waitingToken}/waiting`, cookie);

      results.push({
        who: visitor.who,
        status: page.status,
        location: page.location,
        waiting: page.body.includes(WAITING_TEXT),
      });

      expect.soft(page.status, `${waiting.label}, ${visitor.who}: the waiting page answers 200`).toBe(200);
      expect
        .soft(page.body.includes(WAITING_TEXT), `${waiting.label}, ${visitor.who}: the page shows "${WAITING_TEXT}"`)
        .toBe(true);
    }

    await keepRecord(`C106-${waiting.label.replace(/[^a-z0-9]+/gi, '-')}.json`, {
      envelopeId: seeded.envelopeId,
      results,
    });
  });
}

// ---------------------------------------------------------------------------
// C107
// ---------------------------------------------------------------------------

const certificate = async (request: APIRequestContext, seeded: G4Seeded) => {
  const res = await request.get(`${API_V2}/envelope/${seeded.envelopeId}/certificate/download`, {
    headers: { Authorization: `Bearer ${seeded.owner.apiToken}` },
  });
  const body = await res.body();

  return {
    status: res.status(),
    isPdf: body.subarray(0, 5).toString('latin1') === '%PDF-',
    text: body.toString('utf8'),
  };
};

test('C107 the API certificate of a pending envelope answers 4xx; a completed one answers 200', async ({ request }) => {
  const owner = await createG4Owner();
  const pending = await seedOneSigner(2, { owner });
  const completed = await seedG4Envelope({
    internalVersion: 2,
    owner,
    status: DocumentStatus.COMPLETED,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        sendStatus: 'SENT',
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
    ],
  });

  await prisma.envelope.update({ where: { id: completed.envelopeId }, data: { completedAt: new Date() } });
  await prisma.signature.create({
    data: { fieldId: completed.r.s1.fields.sig.id, recipientId: completed.r.s1.id, typedSignature: CONTROL_NAME },
  });

  const pendingReply = await certificate(request, pending);
  const completedReply = await certificate(request, completed);

  await keepRecord('C107.json', {
    pending: { status: pendingReply.status, body: pendingReply.isPdf ? '<PDF>' : pendingReply.text.slice(0, 500) },
    completed: { status: completedReply.status, isPdf: completedReply.isPdf },
  });

  expect(pendingReply.status, 'premise: the rate limiter did not answer').not.toBe(429);
  expect.soft(pendingReply.status, `pending: answers 4xx, not ${pendingReply.status}`).toBeGreaterThanOrEqual(400);
  expect.soft(pendingReply.status, `pending: answers 4xx, not ${pendingReply.status}`).toBeLessThan(500);
  expect.soft(pendingReply.isPdf, 'pending: no PDF is served').toBe(false);
  expect.soft(pendingReply.text, 'pending: the body names DOCUMENT_NOT_COMPLETE').toContain('DOCUMENT_NOT_COMPLETE');
  expect.soft(completedReply.status, 'completed control: answers 200').toBe(200);
  expect.soft(completedReply.isPdf, 'completed control: the body is a PDF').toBe(true);
});

// ---------------------------------------------------------------------------
// C105c: non-signature values on the direct template are still trimmed (G4 spec, "Round after Codex r6")
//
// The direct template shares its signedFieldValues element schema with V1 field.signFieldWithToken, which no
// longer trims (C105b). A TEXT or NAME value must still be stored trimmed, the NAME value must give the
// recipient name trimmed, and on V2 a whitespace-only optional text must not count as inserted.
// ---------------------------------------------------------------------------

/**
 * Adds one field of each type given to the direct recipient of the template and returns their ids in order. Only
 * the fields a case sends are seeded: a NAME field has no `required: false` and is refused when left unsent.
 */
const seedDirectExtraFields = async (
  template: Awaited<ReturnType<typeof seedG4DirectTemplate>>,
  types: FieldType[],
) => {
  const ids: number[] = [];

  for (const [row, type] of types.entries()) {
    const created = await prisma.field.create({
      data: {
        envelopeId: template.envelopeId,
        envelopeItemId: template.itemId,
        recipientId: template.directRecipientId,
        type,
        page: 1,
        positionX: 8 + (row % 3) * 30,
        positionY: 30 + Math.floor(row / 3) * 11,
        width: 24,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta: FIELD_META_DEFAULT_VALUES[type] as never,
      },
    });

    ids.push(created.id);
  }

  return ids;
};

const submitDirectTemplateValues = async (
  request: APIRequestContext,
  template: Awaited<ReturnType<typeof seedG4DirectTemplate>>,
  email: string,
  values: { fieldId: number; value: string }[],
  directRecipientName = 'Direct Signer',
) => {
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: template.envelopeId } });

  return await trpcWithDates(
    request,
    'template.createDocumentFromDirectTemplate',
    {
      directRecipientName,
      directRecipientEmail: email,
      directTemplateToken: template.directToken,
      signedFieldValues: [
        { token: '', fieldId: template.sigFieldId, value: CONTROL_NAME, isBase64: false },
        ...values.map((entry) => ({ token: '', fieldId: entry.fieldId, value: entry.value, isBase64: false })),
      ],
      templateUpdatedAt: envelope.updatedAt.toISOString(),
    },
    ['templateUpdatedAt'],
  );
};

/** The new document's fields and recipient for the direct recipient who signed with `email`, by field type. */
const directResult = async (email: string) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: { email, envelope: { type: 'DOCUMENT' } },
    include: { fields: { orderBy: { id: 'asc' } } },
  });

  return {
    recipientName: recipient.name,
    fields: recipient.fields
      .filter((field) => field.type !== FieldType.SIGNATURE)
      .map((field) => ({ type: field.type, inserted: field.inserted, customText: field.customText })),
  };
};

for (const version of [1, 2] as const) {
  test(`C105c direct template V${version}: a text field sent as "  Hello  " is stored as "Hello"`, async ({
    request,
  }) => {
    const template = await seedG4DirectTemplate(version);
    const [textId] = await seedDirectExtraFields(template, [FieldType.TEXT]);
    const email = `g4-c105c-${uniqueStamp()}@test.documenso.com`;
    const reply = await submitDirectTemplateValues(request, template, email, [{ fieldId: textId, value: '  Hello  ' }]);
    const stored = reply.status === 200 ? await directResult(email) : null;

    await keepRecord(`C105c-dt-v${version}-text.json`, {
      status: reply.status,
      body: reply.body.slice(0, 2000),
      stored,
    });

    expect(reply.status, `direct template V${version} text: answers 200 (${reply.body.slice(0, 200)})`).toBe(200);
    expect(
      stored?.fields.find((field) => field.type === FieldType.TEXT && field.customText.includes('Hello')),
      `direct template V${version} text: stored trimmed and inserted (${JSON.stringify(stored)})`,
    ).toEqual({ type: FieldType.TEXT, inserted: true, customText: 'Hello' });
  });

  test(`C105c direct template V${version}: a NAME field sent as "  Dana Direct  " is stored as "Dana Direct"`, async ({
    request,
  }) => {
    const template = await seedG4DirectTemplate(version);
    const [nameId] = await seedDirectExtraFields(template, [FieldType.NAME]);
    const email = `g4-c105c-${uniqueStamp()}@test.documenso.com`;
    const reply = await submitDirectTemplateValues(request, template, email, [
      { fieldId: nameId, value: '  Dana Direct  ' },
    ]);
    const stored = reply.status === 200 ? await directResult(email) : null;

    await keepRecord(`C105c-dt-v${version}-name.json`, {
      status: reply.status,
      body: reply.body.slice(0, 2000),
      stored,
    });

    expect(reply.status, `direct template V${version} name: answers 200 (${reply.body.slice(0, 200)})`).toBe(200);
    expect(
      stored?.fields.find((field) => field.type === FieldType.NAME),
      `direct template V${version} name: stored trimmed and inserted (${JSON.stringify(stored)})`,
    ).toEqual({ type: FieldType.NAME, inserted: true, customText: 'Dana Direct' });
    // Observed on c71141c44 with directRecipientName given ("Direct Signer", "" and omitted): the recipient name is
    // the one sent, not the NAME value, so it is recorded above and not asserted.
  });

  test(`C105c direct template V${version}: the signature field with a leading U+0009 is still refused with 400`, async ({
    request,
  }) => {
    const template = await seedG4DirectTemplate(version);
    const [textId] = await seedDirectExtraFields(template, [FieldType.TEXT]);
    const email = `g4-c105c-${uniqueStamp()}@test.documenso.com`;
    const rowsBefore = await teamRowCounts(template.owner.team.id);
    const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: template.envelopeId } });
    const reply = await trpcWithDates(
      request,
      'template.createDocumentFromDirectTemplate',
      {
        directRecipientName: 'Direct Signer',
        directRecipientEmail: email,
        directTemplateToken: template.directToken,
        signedFieldValues: [
          { token: '', fieldId: template.sigFieldId, value: '\u0009Alice', isBase64: false },
          { token: '', fieldId: textId, value: '  Hello  ', isBase64: false },
        ],
        templateUpdatedAt: envelope.updatedAt.toISOString(),
      },
      ['templateUpdatedAt'],
    );
    const rowsAfter = await teamRowCounts(template.owner.team.id);

    await keepRecord(`C105c-dt-v${version}-signature-guard.json`, {
      status: reply.status,
      body: reply.body.slice(0, 2000),
      rowsBefore,
      rowsAfter,
    });

    expectControlRefusal(reply, `direct template V${version} signature guard`);
    expect.soft(rowsAfter, `direct template V${version} signature guard: nothing written`).toEqual(rowsBefore);
  });
}

test('C105c direct template V2: an optional text field sent as "   " is stored not inserted with empty text', async ({
  request,
}) => {
  const template = await seedG4DirectTemplate(2);
  const [optionalId] = await seedDirectExtraFields(template, [FieldType.TEXT]);
  const email = `g4-c105c-${uniqueStamp()}@test.documenso.com`;
  const reply = await submitDirectTemplateValues(request, template, email, [{ fieldId: optionalId, value: '   ' }]);
  const stored = reply.status === 200 ? await directResult(email) : null;

  await keepRecord('C105c-dt-v2-optional-blank.json', {
    status: reply.status,
    body: reply.body.slice(0, 2000),
    stored,
  });

  expect(reply.status, `direct template V2 optional blank: answers 200 (${reply.body.slice(0, 200)})`).toBe(200);
  expect(
    stored?.fields.find((field) => field.type === FieldType.TEXT),
    `direct template V2 optional blank: stored not inserted (${JSON.stringify(stored)})`,
  ).toEqual({ type: FieldType.TEXT, inserted: false, customText: '' });
});
