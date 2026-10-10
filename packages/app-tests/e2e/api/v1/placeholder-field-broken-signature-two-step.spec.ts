/**
 * Placeholder field on a two-step upload whose signature is already broken
 * (criteria 5 and 6).
 *
 * Written from the specification alone, without reading the implementation of
 * create-envelope-fields.ts.
 *
 * API v1 two-step creation (create with no file, then PUT the PDF to the
 * returned upload URL) stores a file without the arrival checks an upload
 * through API v2 gets, so a PDF whose embedded signature is already broken can
 * reach an envelope item. Adding a placeholder-positioned field to it must be
 * refused as a signature already invalid on arrival (400, data.code
 * SIGNATURE_ALREADY_INVALID), with a message that does not say Sign would
 * invalidate it (F5), and must change neither the item's PDF nor its fields.
 *
 * The placeholder field is added through API v2 (field/create-many), because
 * API v1 positions fields by coordinates only.
 *
 * Two-step creation exists only under the S3 upload transport, so the spec
 * skips with that reason unless NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3", as
 * protected-pdf-two-step.spec.ts does for criteria 10 and 11 (criterion 6).
 * Run it locally against MinIO for the MR evidence.
 *
 * The broken fixture is the counterparty-signed placeholder PDF with one
 * signed byte changed afterwards (the binary comment on the file's second
 * line, the same tampering buildSignedThenTamperedPdf uses). pdfsig must
 * reject it before it is used.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | broken-signature placeholder pdf, two-step: placeholder field  | 5, 6     | F5            |
 * |   refused with SIGNATURE_ALREADY_INVALID, item unchanged       |          |               |
 * | intact counterparty-signed placeholder pdf, two-step:          | 7        | control       |
 * |   placeholder field accepted, signature still verifies         |          |               |
 * | clean placeholder item + broken-signature item, placeholder    | 3        | F3, F4        |
 * |   fields on both in one request: refused, no new DocumentData, |          |               |
 * |   both items keep their revisions                              |          |               |
 *
 * The criterion 3 test is the deterministic way, through the public API, to
 * fail a field request after one item's whiteout could have been staged: the
 * first item is an ordinary placeholder PDF whose field would succeed alone,
 * and the second is the broken-signature two-step PDF, which any correct code
 * must refuse. The envelope comes from the v1 two-step flow (so the broken
 * file arrives unchecked); the clean PDF is added as a second item through API
 * v2 and moved to order 1 with envelope/item/update-many, and the request
 * lists the clean item's field first. Any refusal satisfies the test; what it
 * checks is that nothing the request stored remains. Both PDFs carry the
 * test's marker text, so documentDataOfTest finds a revision of either item
 * whatever owner columns it was written with.
 */

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  bodyOf,
  buildPlaceholderPdf,
  createFields,
  databaseNow,
  documentDataOfTest,
  jsonHeaders,
  uniqueEmail,
  uniqueMarker,
} from '../../fixtures/placeholder-fields';
import {
  API_BASE_URL,
  API_SIGNATURE_PLACEHOLDER,
  assertVerifierToolsPresent,
  buildCounterpartySignedPlaceholderPdf,
  expectCounterpartySignatureStillValid,
  expectFixtureCounterpartySignatureValid,
  readSignaturesWithPdfsig,
  SIGNATURE_ALREADY_INVALID,
  SIGNATURE_VALID,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

const UPLOAD_TRANSPORT = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;

test.skip(
  UPLOAD_TRANSPORT !== 's3',
  `Two-step v1 creation exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(UPLOAD_TRANSPORT ?? null)}.`,
);

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const V1 = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1`;

/**
 * The counterparty-signed placeholder PDF with one signed byte changed, so its
 * signature no longer verifies. `extraText` is drawn as a further line before
 * signing (used for a test's marker).
 */
const buildBrokenSignedPlaceholderPdf = async (extraText: string[] = []) => {
  const signed = Buffer.from(await buildCounterpartySignedPlaceholderPdf([API_SIGNATURE_PLACEHOLDER, ...extraText]));
  const commentStart = signed.indexOf('\n%', 0, 'latin1') + 2;

  signed[commentStart] = signed[commentStart] === 0x58 ? 0x59 : 0x58;

  return signed;
};

/** Create a v1 document with one signer and no file, then PUT the file to the upload URL it returns. */
const createTwoStepDocument = async (request: APIRequestContext, token: string, file: Buffer) => {
  const res = await request.post(`${V1}/documents`, {
    headers: jsonHeaders(token),
    data: {
      title: 'Two-step placeholder document',
      recipients: [{ name: 'Two Step Signer', email: uniqueEmail('pf-two-step'), role: 'SIGNER' }],
    },
  });
  const { text, body } = await bodyOf(res);

  expect(res.status(), `POST /api/v1/documents: ${text}`).toBe(200);
  expect(typeof body.uploadUrl, 'an upload URL is returned before any file exists').toBe('string');

  const put = await request.put(body.uploadUrl as string, {
    headers: { 'Content-Type': 'application/pdf' },
    data: file,
  });

  expect(put.ok(), `PUT to the upload URL failed: ${put.status()} ${await put.text()}`).toBeTruthy();

  const envelope = await prisma.envelope.findFirstOrThrow({
    where: { secondaryId: `document_${body.documentId as number}` },
    include: { envelopeItems: { include: { documentData: true } } },
  });
  const recipients = body.recipients as Array<{ recipientId: number }>;

  expect(envelope.envelopeItems, 'premise: the document has one item').toHaveLength(1);

  return { envelope, item: envelope.envelopeItems[0], recipientId: recipients[0].recipientId };
};

const storedBytes = async (envelopeItemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({
    where: { id: envelopeItemId },
    include: { documentData: true },
  });

  return { documentDataId: item.documentDataId, bytes: Buffer.from(await getFileServerSide(item.documentData)) };
};

test('criterion_5_placeholder_field_on_a_two_step_pdf_with_a_broken_signature_is_refused_as_already_invalid', async ({
  request,
}) => {
  const fixture = await buildBrokenSignedPlaceholderPdf();
  const fixtureSignatures = readSignaturesWithPdfsig(fixture);

  expect(fixtureSignatures, 'fixture precondition: one signature').toHaveLength(1);
  expect(fixtureSignatures[0].validation, 'fixture precondition: pdfsig rejects the signature').not.toBe(
    SIGNATURE_VALID,
  );

  const { token } = await apiCreateTestContext('pf-two-step-broken');
  const { envelope, item, recipientId } = await createTwoStepDocument(request, token, fixture);
  const before = await storedBytes(item.id);

  const res = await createFields(request, token, envelope.id, [
    { recipientId, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
  ]);
  const { text, body } = await bodyOf(res);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const message = String(body.message ?? '');

  expect.soft(res.status(), `expected 400, got ${res.status()}: ${text}`).toBe(400);
  expect.soft(data.code, `data.code is ${SIGNATURE_ALREADY_INVALID}: ${text}`).toBe(SIGNATURE_ALREADY_INVALID);
  expect.soft(message, 'the message is about the existing signature').toMatch(/signature/i);
  expect
    .soft(message, 'the message says the signature is already invalid')
    .toMatch(/already|on arrival|before (it was )?upload/i);

  // F5: blaming Sign for a signature that arrived broken.
  expect
    .soft(message, 'the message does not claim Sign would invalidate it')
    .not.toMatch(/would (be )?invalidat|storing it|by storing|sign would|we would/i);

  const after = await storedBytes(item.id);

  expect.soft(after.documentDataId, 'the item still points at the uploaded revision').toBe(before.documentDataId);
  expect.soft(after.bytes.equals(before.bytes), "the item's PDF is unchanged").toBe(true);
  expect(await prisma.field.count({ where: { envelopeId: envelope.id } }), 'no field is saved').toBe(0);
});

test('criterion_7_placeholder_field_on_a_two_step_pdf_with_an_intact_signature_is_accepted_control', async ({
  request,
}) => {
  const fixture = await buildCounterpartySignedPlaceholderPdf([API_SIGNATURE_PLACEHOLDER]);
  const original = expectFixtureCounterpartySignatureValid(fixture);

  const { token } = await apiCreateTestContext('pf-two-step-intact');
  const { envelope, item, recipientId } = await createTwoStepDocument(request, token, fixture);

  const res = await createFields(request, token, envelope.id, [
    { recipientId, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
  ]);

  expect(res.status(), `field/create-many with a placeholder: ${await res.text()}`).toBe(200);
  expect(await prisma.field.count({ where: { envelopeId: envelope.id } }), 'the field is saved').toBe(1);

  expectCounterpartySignatureStillValid(
    new Uint8Array((await storedBytes(item.id)).bytes),
    original,
    'stored file after placement',
  );
});

test('criterion_3_request_refused_on_a_broken_signature_second_item_leaves_no_document_data_for_either_item', async ({
  request,
}) => {
  const marker = uniqueMarker();
  const broken = await buildBrokenSignedPlaceholderPdf([marker]);

  expect(
    readSignaturesWithPdfsig(broken)[0]?.validation,
    'fixture precondition: pdfsig rejects the signature',
  ).not.toBe(SIGNATURE_VALID);

  const { token, user, team } = await apiCreateTestContext('pf-two-step-mixed');
  const { envelope, item: brokenItem, recipientId } = await createTwoStepDocument(request, token, broken);

  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId: envelope.id }));
  formData.append(
    'files',
    new File([await buildPlaceholderPdf(marker, [API_SIGNATURE_PLACEHOLDER])], 'clean-placeholder.pdf', {
      type: 'application/pdf',
    }),
  );

  const added = await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(added.status(), `premise: a clean second item can be added: ${await added.text()}`).toBe(200);

  const cleanItem = await prisma.envelopeItem.findFirstOrThrow({
    where: { envelopeId: envelope.id, id: { not: brokenItem.id } },
  });

  const reordered = await request.post(`${API_BASE_URL}/envelope/item/update-many`, {
    headers: jsonHeaders(token),
    data: {
      envelopeId: envelope.id,
      data: [
        { envelopeItemId: cleanItem.id, order: 1 },
        { envelopeItemId: brokenItem.id, order: 2 },
      ],
    },
  });

  expect(reordered.status(), `premise: the clean item becomes the first: ${await reordered.text()}`).toBe(200);

  const items = await prisma.envelopeItem.findMany({ where: { envelopeId: envelope.id }, orderBy: { order: 'asc' } });

  expect(
    items.map((item) => item.id),
    'premise: the clean item is first, the broken one second',
  ).toEqual([cleanItem.id, brokenItem.id]);

  const owner = { userId: user.id, teamId: team.id, marker };
  const since = await databaseNow();
  const before = await documentDataOfTest({ ...owner, since });

  const res = await createFields(request, token, envelope.id, [
    { recipientId, envelopeItemId: cleanItem.id, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
    { recipientId, envelopeItemId: brokenItem.id, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
  ]);
  const text = await res.text();

  const after = await documentDataOfTest({ ...owner, since });
  const created = [...after].filter((id) => !before.has(id));
  const itemsAfter = await prisma.envelopeItem.findMany({
    where: { envelopeId: envelope.id },
    orderBy: { order: 'asc' },
  });

  test.info().annotations.push({
    type: 'field request',
    description: JSON.stringify({ status: res.status(), body: text.slice(0, 400), created }),
  });

  expect(res.ok(), `premise: the request must be refused because of the second item: ${text}`).toBeFalsy();
  expect(await prisma.field.count({ where: { envelopeId: envelope.id } }), 'no field is saved').toBe(0);

  // F3: a revision staged for the clean item, or for the broken one, is still stored.
  expect(created, 'no DocumentData row created by the refused request remains').toEqual([]);

  // F4: an item moved to a new revision anyway.
  expect(
    itemsAfter.map((item) => item.documentDataId),
    'both items still point at their previous revisions',
  ).toEqual(items.map((item) => item.documentDataId));

  const control = await createFields(request, token, envelope.id, [
    { recipientId, envelopeItemId: cleanItem.id, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
  ]);

  expect(control.status(), `control: the clean item's field alone is accepted: ${await control.text()}`).toBe(200);
});
