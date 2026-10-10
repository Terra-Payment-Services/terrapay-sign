/**
 * A failed field request saves none of its fields (criterion 14).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * Each test sends one request holding a field that is valid on its own and a
 * field that makes the request fail, then counts the envelope's fields. The
 * valid field is put first, so a request that saves as it goes would have
 * saved it before reaching the bad one. Each test then sends the valid field
 * alone and expects it to save, which shows that the zero before was the
 * failed request's doing and not a field the API would refuse anyway.
 *
 * | Test                                                         | Criteria | Failure modes |
 * | ------------------------------------------------------------ | -------- | ------------- |
 * | v2: coordinate field + missing placeholder saves nothing      | 14       | F13           |
 * | v2: found placeholder + missing placeholder saves nothing     | 14       | F13           |
 * | v2: valid field + field for a recipient not on the envelope   | 14       | F13           |
 * |   saves nothing                                               |          |               |
 * | v1: valid field + field for a recipient not on the document   | 14       | F13           |
 * |   saves nothing                                               |          |               |
 * | v2: placeholder found on one document, missing on another in  | 14       | F13           |
 * |   the same envelope, saves nothing                            |          |               |
 * | v2: placeholder request on a counterparty-signed pdf leaves    | 14, 13   | F13, F12      |
 * |   no field behind if it fails                                 |          |               |
 *
 * Criterion 14 is reachable end to end, so no isolated test is needed.
 *
 * The placeholder PDF is the repository's no-recipient-placeholders.pdf, which
 * the existing placeholder spec shows carries `{{signature}}` and `{{name}}`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedDraftDocument } from '@documenso/prisma/seed/documents';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiCreateEnvelope, apiCreateRecipients, apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  API_SIGNATURE_PLACEHOLDER,
  assertVerifierToolsPresent,
  buildCounterpartySignedPlaceholderPdf,
  ordinaryPdf,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

const PLACEHOLDER_PDF = fs.readFileSync(
  path.join(__dirname, '../../../../assets/fixtures/auto-placement/no-recipient-placeholders.pdf'),
);

const NO_SUCH_RECIPIENT_ID = 2_000_000_000;

const json = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

const seedEnvelopeWithSigner = async (request: APIRequestContext) => {
  const { token } = await apiCreateTestContext('field-atomicity');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, {
    title: 'Field atomicity',
    pdfFile: { name: 'no-recipient-placeholders.pdf', data: PLACEHOLDER_PDF },
  });
  const recipients = await apiCreateRecipients(request, token, envelopeId, [
    { email: `atomicity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com` },
  ]);

  return { token, envelopeId, recipientId: recipients.data[0].id };
};

const coordinateField = (recipientId: number) => ({
  recipientId,
  type: FieldType.SIGNATURE,
  page: 1,
  positionX: 10,
  positionY: 20,
  width: 15,
  height: 5,
});

const createFieldsV2 = async (
  request: APIRequestContext,
  token: string,
  envelopeId: string,
  data: Array<Record<string, unknown>>,
) =>
  await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
    headers: json(token),
    data: { envelopeId, data },
  });

const addItem = async (request: APIRequestContext, token: string, envelopeId: string, file: Buffer, name: string) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  formData.append('files', new File([file], name, { type: 'application/pdf' }));

  const res = await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(res.ok(), `envelope/item/create-many: ${await res.text()}`).toBeTruthy();
};

const fieldCount = async (envelopeId: string) => await prisma.field.count({ where: { envelopeId } });

test('criterion_14_v2_request_with_a_missing_placeholder_saves_none_of_its_coordinate_fields', async ({ request }) => {
  const { token, envelopeId, recipientId } = await seedEnvelopeWithSigner(request);

  const failed = await createFieldsV2(request, token, envelopeId, [
    coordinateField(recipientId),
    { recipientId, type: FieldType.TEXT, placeholder: '{{nonexistent}}' },
  ]);

  expect(failed.ok(), `the request should fail: ${await failed.text()}`).toBeFalsy();
  expect(await fieldCount(envelopeId), 'no field from the failed request is saved').toBe(0);

  const control = await createFieldsV2(request, token, envelopeId, [coordinateField(recipientId)]);

  expect(control.ok(), `control: the valid field alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId)).toBe(1);
});

test('criterion_14_v2_request_with_a_missing_placeholder_saves_none_of_its_found_placeholder_fields', async ({
  request,
}) => {
  const { token, envelopeId, recipientId } = await seedEnvelopeWithSigner(request);

  const found = { recipientId, type: FieldType.SIGNATURE, placeholder: '{{signature}}' };

  const failed = await createFieldsV2(request, token, envelopeId, [
    found,
    { recipientId, type: FieldType.TEXT, placeholder: '{{nonexistent}}' },
  ]);

  expect(failed.ok(), `the request should fail: ${await failed.text()}`).toBeFalsy();
  expect(await fieldCount(envelopeId), 'no field from the failed request is saved').toBe(0);

  const control = await createFieldsV2(request, token, envelopeId, [found]);

  expect(control.ok(), `control: the found placeholder alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId)).toBe(1);
});

test('criterion_14_v2_request_with_a_field_for_an_unknown_recipient_saves_none_of_its_fields', async ({ request }) => {
  const { token, envelopeId, recipientId } = await seedEnvelopeWithSigner(request);

  const failed = await createFieldsV2(request, token, envelopeId, [
    coordinateField(recipientId),
    coordinateField(NO_SUCH_RECIPIENT_ID),
  ]);

  expect(failed.ok(), `the request should fail: ${await failed.text()}`).toBeFalsy();
  expect(await fieldCount(envelopeId), 'no field from the failed request is saved').toBe(0);

  const control = await createFieldsV2(request, token, envelopeId, [coordinateField(recipientId)]);

  expect(control.ok(), `control: the valid field alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(envelopeId)).toBe(1);
});

test('criterion_14_v1_request_with_a_field_for_an_unknown_recipient_saves_none_of_its_fields', async ({ request }) => {
  const { token, user, team } = await apiCreateTestContext('field-atomicity-v1');
  const email = `atomicity-v1-${Date.now()}@test.documenso.com`;
  const document = await seedDraftDocument(user, team.id, [email], { internalVersion: 1 });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id, email } });
  const documentId = mapSecondaryIdToDocumentId(document.secondaryId);
  const before = await fieldCount(document.id);

  const v1Field = (recipientId: number) => ({
    recipientId,
    type: FieldType.SIGNATURE,
    pageNumber: 1,
    pageX: 10,
    pageY: 20,
    pageWidth: 15,
    pageHeight: 5,
    fieldMeta: { type: 'signature' },
  });

  const url = `${NEXT_PUBLIC_WEBAPP_URL()}/api/v1/documents/${documentId}/fields`;

  const failed = await request.post(url, {
    headers: json(token),
    data: [v1Field(recipient.id), v1Field(NO_SUCH_RECIPIENT_ID)],
  });

  expect(failed.ok(), `the request should fail: ${await failed.text()}`).toBeFalsy();
  expect(await fieldCount(document.id), 'no field from the failed request is saved').toBe(before);

  const control = await request.post(url, { headers: json(token), data: [v1Field(recipient.id)] });

  expect(control.ok(), `control: the valid field alone saves: ${await control.text()}`).toBeTruthy();
  expect(await fieldCount(document.id)).toBe(before + 1);
});

test('criterion_14_v2_request_whose_placeholder_is_missing_on_a_second_document_saves_none_of_its_fields', async ({
  request,
}) => {
  const { token, envelopeId, recipientId } = await seedEnvelopeWithSigner(request);

  await addItem(request, token, envelopeId, ordinaryPdf(), 'ordinary.pdf');

  const items = await prisma.envelopeItem.findMany({ where: { envelopeId }, orderBy: { order: 'asc' } });

  expect(items, 'premise: the envelope holds the placeholder PDF and an ordinary one').toHaveLength(2);

  const [placeholderItem, ordinaryItem] = items;

  const failed = await createFieldsV2(request, token, envelopeId, [
    { recipientId, envelopeItemId: placeholderItem.id, type: FieldType.SIGNATURE, placeholder: '{{signature}}' },
    { recipientId, envelopeItemId: ordinaryItem.id, type: FieldType.NAME, placeholder: '{{name}}' },
  ]);

  expect(
    failed.ok(),
    `the request should fail, {{name}} is not on the ordinary PDF: ${await failed.text()}`,
  ).toBeFalsy();
  expect(await fieldCount(envelopeId), 'no field from the failed request is saved').toBe(0);
});

test('criterion_14_placeholder_request_on_a_counterparty_signed_pdf_leaves_no_field_if_it_fails', async ({
  request,
}) => {
  assertVerifierToolsPresent();

  const { token } = await apiCreateTestContext('field-atomicity-signed');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, {
    title: 'Field atomicity on a signed PDF',
    pdfFile: {
      name: 'signed-placeholder.pdf',
      data: await buildCounterpartySignedPlaceholderPdf([API_SIGNATURE_PLACEHOLDER]),
    },
  });
  const { data: recipients } = await apiCreateRecipients(request, token, envelopeId, [
    { email: `atomicity-signed-${Date.now()}@test.documenso.com` },
  ]);

  const res = await createFieldsV2(request, token, envelopeId, [
    { recipientId: recipients[0].id, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER },
  ]);
  const text = await res.text();

  // Criterion 13 wants this request to succeed; this test only asks that
  // whichever way it goes, the saved fields match the answer.
  expect(await fieldCount(envelopeId), `request answered ${res.status()}: ${text}`).toBe(res.ok() ? 1 : 0);
});
