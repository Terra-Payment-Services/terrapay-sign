/**
 * The V1 field routes refuse V2 envelopes, and the unmounted
 * multi-sign apply route stays gone.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 8) before any fix, without reading the V1 sign or unsign handlers or
 * the multi-sign query. Every request is unauthenticated with only the
 * recipient token, as a recipient's browser or an embedder sends it.
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C64       | C64 field.signFieldWithToken on a V2 envelope is refused for every field type (signer)  |
 * | C64       | C64 field.signFieldWithToken on a V2 envelope is refused for an assistant's prefill     |
 * | C65       | C65 field.removeSignedFieldWithToken on an inserted V2 field is refused                  |
 * | C66       | C66 getMultiSignDocument refuses a V2 token                                             |
 * | C66       | C66 the multi-sign embed does not offer a V2 envelope for signing                        |
 * | C67       | C67 V1 envelopes: every field type signs and unsigns on the V1 routes as today            |
 * | C67       | C67 V1 envelopes: getMultiSignDocument and the multi-sign embed offer them as today       |
 * | C73       | C73 embeddingPresign.applyMultiSignSignature answers 404                                |
 * | C73       | C73 nothing in packages/trpc or apps imports apply-multi-sign-signature                  |
 *
 * C64's message check: the refusal must name the V2 route, so the message has
 * to mention `envelope.field.sign` or the word "V2" (case-insensitive, as a
 * word). Either wording is accepted. The message is recorded as an annotation;
 * the refusal itself is carried by the 400 INVALID_REQUEST bundle, never by the
 * message alone.
 *
 * 4.0's "the same field can afterwards be signed with a valid value" is checked
 * through the route a V2 envelope belongs on, envelope.field.sign.
 *
 * Premises: every value sent to a V2 envelope is first shown to sign on a V1
 * envelope (C67), so a refusal on V2 cannot come from a value the V1 route
 * would refuse anyway.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { DocumentSigningOrder, FieldType } from '@prisma/client';

import { type Reply, trpcRaw } from '../fixtures/reject-seal';
import {
  describeReply,
  envelopeSnapshot,
  errorOf,
  expect2xx,
  expectCallRefused,
  type FieldSpec,
  fieldAuditRowsOf,
  fieldState,
  type G4Seeded,
  seedG4Envelope,
  seedInserted,
  signV1,
  signV2,
  unsignV1,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const RADIO_META = {
  type: 'radio',
  label: 'Pick one',
  required: false,
  readOnly: false,
  direction: 'vertical',
  values: [
    { id: 1, value: 'Option A', checked: false },
    { id: 2, value: 'Option B', checked: false },
  ],
};

const DROPDOWN_META = {
  type: 'dropdown',
  label: 'Choose',
  required: false,
  readOnly: false,
  values: [{ value: 'Option 1' }, { value: 'Option 2' }],
  defaultValue: '',
};

/** Each field type with the value the V1 signing components send for it. */
const CASES: Array<{ type: FieldType; value: string; fieldMeta?: Record<string, unknown> }> = [
  { type: FieldType.SIGNATURE, value: 'Typed Name' },
  { type: FieldType.FREE_SIGNATURE, value: 'Typed Name' },
  { type: FieldType.TEXT, value: 'Hello' },
  { type: FieldType.NAME, value: 'G4 Name' },
  { type: FieldType.EMAIL, value: 'g4-value@test.documenso.com' },
  { type: FieldType.DATE, value: 'yyyy-MM-dd hh:mm a' },
  { type: FieldType.NUMBER, value: '42' },
  { type: FieldType.INITIALS, value: 'GN' },
  { type: FieldType.CHECKBOX, value: JSON.stringify(['Check A']) },
  { type: FieldType.RADIO, value: 'Option A', fieldMeta: RADIO_META },
  { type: FieldType.DROPDOWN, value: 'Option 1', fieldMeta: DROPDOWN_META },
];

const fieldSpecs = (): FieldSpec[] =>
  CASES.map((entry) => ({ key: entry.type, type: entry.type, fieldMeta: entry.fieldMeta }));

const seedAllTypes = async (internalVersion: 1 | 2) =>
  await seedG4Envelope({
    internalVersion,
    recipients: [{ key: 's1', signingOrder: 1, fields: fieldSpecs() }],
  });

/** An assistant at order 1 and a signer at order 2 with a TEXT field, PARALLEL. */
const seedWithAssistant = async (internalVersion: 1 | 2) =>
  await seedG4Envelope({
    internalVersion,
    signingOrder: DocumentSigningOrder.PARALLEL,
    recipients: [
      { key: 'a1', role: 'ASSISTANT', signingOrder: 1, fields: [] },
      { key: 's2', signingOrder: 2, fields: [{ key: 'text', type: FieldType.TEXT }] },
    ],
  });

const NAMES_V2_ROUTE = /envelope\.field\.sign|\bv2\b/i;

const expectNamesV2Route = (reply: Reply, what: string) => {
  test.info().annotations.push({ type: 'refusal message', description: `${what}: ${errorOf(reply).message}` });
  expect.soft(errorOf(reply).message, `${what}: the refusal message names the V2 route`).toMatch(NAMES_V2_ROUTE);
};

const getMultiSignDocument = async (request: Parameters<typeof trpcRaw>[0], token: string) => {
  const input = encodeURIComponent(JSON.stringify({ json: { token } }));
  const res = await request.get(`${WEBAPP_BASE_URL}/api/trpc/embeddingPresign.getMultiSignDocument?input=${input}`);

  return { status: res.status(), body: await res.text(), retryAfterMs: null } satisfies Reply;
};

// ---------------------------------------------------------------------------
// C67 first: it is the premise for C64 and C65
// ---------------------------------------------------------------------------

test('C67 V1 envelopes: every field type signs and unsigns on the V1 routes as today', async ({ request }) => {
  const seeded = await seedAllTypes(1);
  const token = seeded.r.s1.token;

  for (const entry of CASES) {
    const field = seeded.r.s1.fields[entry.type];
    const signed = await signV1(request, token, field.id, entry.value, false);

    expect.soft(signed.status, `V1 ${entry.type}: sign answers 200: ${describeReply(signed)}`).toBe(200);
    expect.soft((await fieldState(field.id)).inserted, `V1 ${entry.type}: the field is inserted`).toBe(true);

    const unsigned = await unsignV1(request, token, field.id);

    expect.soft(unsigned.status, `V1 ${entry.type}: unsign answers 200: ${describeReply(unsigned)}`).toBe(200);
    expect.soft((await fieldState(field.id)).inserted, `V1 ${entry.type}: the field is uninserted`).toBe(false);
    expect.soft((await fieldState(field.id)).signatureCount, `V1 ${entry.type}: no Signature row left`).toBe(0);
  }

  const assisted = await seedWithAssistant(1);
  const prefill = await signV1(request, assisted.r.a1.token, assisted.r.s2.fields.text.id, 'Prefilled', false);

  expect.soft(prefill.status, `V1 assistant prefill answers 200: ${describeReply(prefill)}`).toBe(200);
  expect
    .soft(
      (await fieldAuditRowsOf(assisted.envelopeId, assisted.r.s2.fields.text.secondaryId, ['DOCUMENT_FIELD_PREFILLED']))
        .length,
      'V1 assistant prefill writes one DOCUMENT_FIELD_PREFILLED row',
    )
    .toBe(1);
});

// ---------------------------------------------------------------------------
// C64
// ---------------------------------------------------------------------------

test('C64 field.signFieldWithToken on a V2 envelope is refused for every field type (signer)', async ({ request }) => {
  const seeded = await seedAllTypes(2);

  expect(seeded.internalVersion, 'premise: the envelope is V2').toBe(2);

  const snapshotBefore = await envelopeSnapshot(seeded);

  for (const entry of CASES) {
    const field = seeded.r.s1.fields[entry.type];

    await test.step(entry.type, async () => {
      try {
        const reply = await expectCallRefused(
          seeded,
          field,
          async () => await signV1(request, seeded.r.s1.token, field.id, entry.value, false),
          `V1 sign of a V2 ${entry.type} field`,
          { status: 400, code: 'INVALID_REQUEST' },
        );

        expectNamesV2Route(reply, `V1 sign of a V2 ${entry.type} field`);
      } catch (error) {
        expect.soft(String(error), `V1 sign of a V2 ${entry.type} field`).toBe('refused with 400 INVALID_REQUEST');
      }
    });
  }

  const snapshotAfter = await envelopeSnapshot(seeded);

  expect
    .soft(snapshotAfter.recipients, 'writes nothing: every recipient row is unchanged')
    .toEqual(snapshotBefore.recipients);
  expect.soft(snapshotAfter.auditCount, 'writes nothing: no audit row of any type').toBe(snapshotBefore.auditCount);

  await verifyNothingWritten(seeded, 's1');

  // 4.0: the fields can afterwards be signed with a valid value, on the V2 route.
  for (const [type, fieldValue] of [
    [FieldType.SIGNATURE, { type: FieldType.SIGNATURE, value: 'Typed Name' }],
    [FieldType.TEXT, { type: FieldType.TEXT, value: 'Hello' }],
  ] as const) {
    const field = seeded.r.s1.fields[type];
    const control = await signV2(request, seeded.r.s1.token, field.id, fieldValue);

    expect.soft(control.status, `V2 sign of the ${type} field afterwards: 200: ${describeReply(control)}`).toBe(200);
    expect.soft((await fieldState(field.id)).inserted, `V2 sign of the ${type} field afterwards: inserted`).toBe(true);
  }
});

test('C64 field.signFieldWithToken on a V2 envelope is refused for an assistant prefill', async ({ request }) => {
  const seeded = await seedWithAssistant(2);
  const field = seeded.r.s2.fields.text;

  const reply = await expectCallRefused(
    seeded,
    field,
    async () => await signV1(request, seeded.r.a1.token, field.id, 'Prefilled', false),
    'V1 assistant prefill of a V2 TEXT field',
    { status: 400, code: 'INVALID_REQUEST' },
  );

  expectNamesV2Route(reply, 'V1 assistant prefill of a V2 TEXT field');

  // 4.0: the assistant can afterwards prefill the field on the V2 route.
  const control = await signV2(request, seeded.r.a1.token, field.id, { type: FieldType.TEXT, value: 'Prefilled' });

  expect.soft(control.status, `V2 prefill afterwards: 200: ${describeReply(control)}`).toBe(200);
  expect.soft((await fieldState(field.id)).inserted, 'V2 prefill afterwards: the field is inserted').toBe(true);
  expect
    .soft(
      (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId, ['DOCUMENT_FIELD_PREFILLED'])).length,
      'V2 prefill afterwards: one DOCUMENT_FIELD_PREFILLED row',
    )
    .toBe(1);
});

/** No field of the recipient is inserted and no field audit row exists after the refusals. */
const verifyNothingWritten = async (seeded: G4Seeded, key: string) => {
  for (const [type, field] of Object.entries(seeded.r[key].fields)) {
    const state = await fieldState(field.id);

    expect.soft(state.inserted, `${type}: still uninserted after every refusal`).toBe(false);
    expect.soft(state.signatureCount, `${type}: no Signature row`).toBe(0);
    expect.soft((await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length, `${type}: no audit row`).toBe(0);
  }
};

// ---------------------------------------------------------------------------
// C65
// ---------------------------------------------------------------------------

test('C65 field.removeSignedFieldWithToken on an inserted V2 field is refused', async ({ request }) => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        fields: [
          { key: 'sig', type: FieldType.SIGNATURE },
          { key: 'text', type: FieldType.TEXT },
        ],
      },
    ],
  });

  await seedInserted(seeded, 's1', 'sig', { typed: 'S Two' });
  await seedInserted(seeded, 's1', 'text', { text: 'SEEDED' });

  for (const key of ['sig', 'text'] as const) {
    const field = seeded.r.s1.fields[key];
    const before = await fieldState(field.id);

    expect(before.inserted, `premise: the ${key} field is seeded inserted`).toBe(true);

    const auditBefore = (await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length;
    const reply = await unsignV1(request, seeded.r.s1.token, field.id);

    expect.soft(reply.status, `V1 unsign of an inserted V2 ${key} field: 400: ${describeReply(reply)}`).toBe(400);
    expect
      .soft(errorOf(reply).code, `V1 unsign of an inserted V2 ${key} field: INVALID_REQUEST`)
      .toBe('INVALID_REQUEST');
    expect
      .soft(await fieldState(field.id), `V1 unsign of a V2 ${key} field leaves field and signature`)
      .toEqual(before);
    expect
      .soft((await fieldAuditRowsOf(seeded.envelopeId, field.secondaryId)).length, `${key}: no new audit row`)
      .toBe(auditBefore);

    // 4.0: the field can afterwards be uninserted on the V2 route (value null).
    const control = await signV2(request, seeded.r.s1.token, field.id, {
      type: key === 'sig' ? FieldType.SIGNATURE : FieldType.TEXT,
      value: null,
    });
    const afterControl = await fieldState(field.id);

    expect.soft(control.status, `V2 uninsert of the ${key} field afterwards: 200: ${describeReply(control)}`).toBe(200);
    expect.soft(afterControl.inserted, `V2 uninsert of the ${key} field afterwards: uninserted`).toBe(false);
    expect.soft(afterControl.signatureCount, `V2 uninsert of the ${key} field afterwards: no Signature row`).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// C66 and the multi-sign half of C67
// ---------------------------------------------------------------------------

const seedMultiSign = async (internalVersion: 1 | 2) =>
  await seedG4Envelope({
    internalVersion,
    title: `G4 multisign V${internalVersion} ${Date.now().toString(36)}`,
    recipients: [{ key: 's1', signingOrder: 1, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] }],
  });

test('C67 V1 envelopes: getMultiSignDocument and the multi-sign embed offer them as today', async ({
  request,
  page,
}) => {
  const seeded = await seedMultiSign(1);
  const reply = await getMultiSignDocument(request, seeded.r.s1.token);

  expect.soft(reply.status, `getMultiSignDocument with a V1 token: 200: ${describeReply(reply)}`).toBe(200);

  await page.goto(`/embed/v1/multisign?token=${seeded.r.s1.token}`);
  await expect(page.getByText(seeded.title, { exact: true })).toBeVisible({ timeout: 30_000 });

  await page
    .locator('div', { has: page.getByText(seeded.title, { exact: true }) })
    .getByRole('button', { name: 'View' })
    .last()
    .click();

  await expect(page.getByRole('heading', { name: 'Sign document' }).first()).toBeVisible({ timeout: 30_000 });
});

test('C66 getMultiSignDocument refuses a V2 token', async ({ request }) => {
  // Premise: the same GET encoding answers 200 for a V1 token, so a 400 below is not an input-parsing error.
  const v1 = await seedMultiSign(1);

  expect2xx(await getMultiSignDocument(request, v1.r.s1.token), 'premise: getMultiSignDocument with a V1 token');

  const seeded = await seedMultiSign(2);
  const reply = await getMultiSignDocument(request, seeded.r.s1.token);

  expect(reply.status, `getMultiSignDocument with a V2 token: 400: ${describeReply(reply)}`).toBe(400);
  expect(errorOf(reply).code, `getMultiSignDocument with a V2 token: INVALID_REQUEST: ${describeReply(reply)}`).toBe(
    'INVALID_REQUEST',
  );
});

test('C66 the multi-sign embed does not offer a V2 envelope for signing', async ({ page }) => {
  const seeded = await seedMultiSign(2);
  const response = await page.goto(`/embed/v1/multisign?token=${seeded.r.s1.token}`);
  const status = response?.status() ?? 0;

  // Either the loader refuses the token with a 4xx, or the page renders and
  // offers no View (the way into the signing form) for the V2 envelope.
  if (status >= 400) {
    expect(status, 'the embed refuses the V2 token with a 4xx, not a 5xx').toBeLessThan(500);

    return;
  }

  // Wait until the page has settled, then require that it did not crash: an error boundary shows no View
  // button either, and must not pass. A fixed page may list the V2 envelope without a View or omit it.
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByText('It looks like we ran into an issue!').or(page.getByText('Oops! Something went wrong.')),
    'the embed shows no error boundary for a V2 token (a 2xx page must render, not crash)',
  ).toHaveCount(0);

  const viewButtons = page
    .locator('div', { has: page.getByText(seeded.title, { exact: true }) })
    .getByRole('button', { name: 'View' });

  await expect(viewButtons, `the V2 envelope "${seeded.title}" is not offered with a View button`).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// C73
// ---------------------------------------------------------------------------

test('C73 embeddingPresign.applyMultiSignSignature answers 404', async ({ request }) => {
  const seeded = await seedMultiSign(1);

  // Premise: the router is reachable, so a 404 below is about the procedure.
  expect2xx(await getMultiSignDocument(request, seeded.r.s1.token), 'premise: getMultiSignDocument answers');

  const reply = await trpcRaw(request, 'embeddingPresign.applyMultiSignSignature', {
    tokens: [seeded.r.s1.token],
    signature: 'Typed Name',
    isBase64: false,
  });

  expect(reply.status, `applyMultiSignSignature: 404: ${describeReply(reply)}`).toBe(404);
});

const WORKTREE_ROOT = path.join(__dirname, '../../../..');

test('C73 nothing in packages/trpc or apps imports apply-multi-sign-signature', async () => {
  // Premise: git grep works here and finds a known module, so an empty answer means absent.
  const control = execFileSync('git', ['grep', '-l', 'get-multi-sign-document', '--', 'packages/trpc', 'apps'], {
    cwd: WORKTREE_ROOT,
    encoding: 'utf8',
  });

  expect(control.trim().length, 'premise: git grep finds the mounted get-multi-sign-document').toBeGreaterThan(0);

  let importers = '';

  try {
    importers = execFileSync(
      'git',
      ['grep', '-n', '-E', '(from|import|require\\().*apply-multi-sign-signature', '--', 'packages/trpc', 'apps'],
      { cwd: WORKTREE_ROOT, encoding: 'utf8' },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }

  expect(importers.trim().split('\n').filter(Boolean), 'files importing apply-multi-sign-signature').toEqual([]);
});
