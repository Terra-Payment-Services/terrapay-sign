/**
 * Placeholder fields on a counterparty-signed PDF (criterion 13).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * The PDF placeholders guide (apps/docs .../advanced/pdf-placeholders.mdx)
 * says placeholder text such as `{{signature, r1}}` becomes a field at upload,
 * that `{{signature}}` with no recipient is reserved for placement through the
 * API, and that the placeholder text is covered with a white rectangle once
 * the field exists. Covering it rewrites the page, which is exactly what would
 * break a counterparty's signature (F12). The verdict on that signature always
 * comes from poppler pdfsig reading the bytes.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | signed placeholder pdf uploads with fields placed and the      | 13       | F12           |
 * |   signature intact in storage [plain, AES-256 owner-only]      |          |               |
 * | upload-time placeholder field: signed, completed, counterparty | 13       | F12           |
 * |   signature verifies [plain, AES-256 owner-only]               |          |               |
 * | placeholder field added after upload: stored file and          | 13, 14   | F12, F13      |
 * |   completed PDF keep the counterparty signature                |          |               |
 * |   [plain, AES-256 owner-only]                                  |          |               |
 *
 * To land the upload-time field on a real recipient, the envelope is created
 * first, a signer added, and the signed PDF then added as a document, the
 * order the existing placeholder spec shows maps `r1` to the first signer.
 */

import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import {
  apiCreateEnvelope,
  apiCreateRecipients,
  apiCreateTestContext,
  apiDistributeEnvelope,
} from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  API_SIGNATURE_PLACEHOLDER,
  assertVerifierToolsPresent,
  buildCounterpartySignedPlaceholderPdf,
  COUNTERPARTY_FIELD_NAME,
  downloadEnvelopeItem,
  expectCounterpartySignatureStillValid,
  expectFixtureCounterpartySignatureValid,
  type OwnerOnlyAlgorithm,
  ordinaryPdf,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
  trpcMutation,
  UPLOAD_SIGNATURE_PLACEHOLDER,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const VARIANTS: Array<{ label: string; ownerOnly?: OwnerOnlyAlgorithm }> = [
  { label: 'unencrypted' },
  { label: 'owner-restricted AES-256', ownerOnly: 'AES-256' },
];

const readStoredItemFile = async (envelopeItemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({
    where: { id: envelopeItemId },
    include: { documentData: true },
  });

  return new Uint8Array(await getFileServerSide(item.documentData));
};

const uploadAsNewEnvelope = async (request: APIRequestContext, token: string, file: Buffer) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ type: 'DOCUMENT', title: 'Signed placeholder PDF' }));
  formData.append('files', new File([file], 'signed-placeholders.pdf', { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const addItem = async (request: APIRequestContext, token: string, envelopeId: string, file: Buffer) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  formData.append('files', new File([file], 'signed-placeholders.pdf', { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

/** Distribute, sign every signature field the one signer has, and wait for completion. */
const sendSignAndComplete = async (request: APIRequestContext, token: string, envelopeId: string) => {
  const distributed = await apiDistributeEnvelope(request, token, envelopeId);
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, include: { fields: true } });
  const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  for (const recipient of distributed.recipients) {
    const fields = envelope.fields.filter((f) => f.recipientId === recipient.id && f.type === FieldType.SIGNATURE);

    for (const field of fields) {
      await trpcMutation(request, 'envelope.field.sign', {
        token: recipient.token,
        fieldId: field.id,
        fieldValue: { type: FieldType.SIGNATURE, value: 'Signature' },
      });
    }

    await trpcMutation(request, 'recipient.completeDocumentWithToken', { token: recipient.token, documentId });
  }

  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

    expect(current.status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 45_000 });
};

const softExpectCompletedKeepsCounterparty = (
  completed: Uint8Array,
  original: ReturnType<typeof expectFixtureCounterpartySignatureValid>,
) => {
  const signatures = readSignaturesWithPdfsig(completed);
  const counterparty = signatures.find((s) => s.fieldName === COUNTERPARTY_FIELD_NAME);

  expect
    .soft(counterparty?.signingTime, 'completed PDF: the counterparty signature is present')
    .toBe(original.signingTime);
  expect
    .soft(counterparty?.validation, 'completed PDF: pdfsig verifies the counterparty signature')
    .toBe(SIGNATURE_VALID);
  expect
    .soft(signatures.filter((s) => s.fieldName !== COUNTERPARTY_FIELD_NAME).length, 'completed PDF: Sign signed it')
    .toBeGreaterThanOrEqual(1);

  for (const signature of signatures) {
    expect
      .soft(signature.validation, `completed PDF: pdfsig verifies #${signature.index} (${signature.fieldName})`)
      .toBe(SIGNATURE_VALID);
  }
};

for (const { label, ownerOnly } of VARIANTS) {
  test(`criterion_13_signed_pdf_with_placeholders_uploads_with_fields_placed_and_signature_intact (${label})`, async ({
    request,
  }) => {
    const fixture = await buildCounterpartySignedPlaceholderPdf([UPLOAD_SIGNATURE_PLACEHOLDER], { ownerOnly });
    const original = expectFixtureCounterpartySignatureValid(fixture);
    const { token } = await apiCreateTestContext('signed-placeholder-upload');

    const res = await uploadAsNewEnvelope(request, token, fixture);

    expect(res.status(), `envelope/create refused the signed placeholder PDF: ${await res.text()}`).toBe(200);

    const { id } = (await res.json()) as { id: string };
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: id } });

    expect
      .soft(await prisma.field.count({ where: { envelopeItemId: item.id } }), 'a field was placed from the placeholder')
      .toBeGreaterThanOrEqual(1);

    expectCounterpartySignatureStillValid(await readStoredItemFile(item.id), original, 'stored file');
  });

  test(`criterion_13_upload_time_placeholder_field_signs_and_completes_with_counterparty_signature_verifying (${label})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const fixture = await buildCounterpartySignedPlaceholderPdf([UPLOAD_SIGNATURE_PLACEHOLDER], { ownerOnly });
    const original = expectFixtureCounterpartySignatureValid(fixture);
    const { token } = await apiCreateTestContext('signed-placeholder-flow');

    const { id: envelopeId } = await apiCreateEnvelope(request, token, {
      title: 'Countersign a placeholder PDF',
      pdfFile: { name: 'ordinary.pdf', data: ordinaryPdf() },
    });
    const { data: recipients } = await apiCreateRecipients(request, token, envelopeId, [
      { email: uniqueEmail('placeholder-signer'), name: 'Placeholder Signer' },
    ]);

    const added = await addItem(request, token, envelopeId, fixture);

    expect(added.status(), `item/create-many refused the signed placeholder PDF: ${await added.text()}`).toBe(200);

    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId, order: { gt: 1 } } });
    const placed = await prisma.field.findMany({ where: { envelopeItemId: item.id } });

    expect(placed.length, 'a field was placed from the placeholder').toBeGreaterThanOrEqual(1);
    expect(
      placed.every((field) => field.recipientId === recipients[0].id),
      'r1 maps to the signer',
    ).toBe(true);

    expectCounterpartySignatureStillValid(await readStoredItemFile(item.id), original, 'stored file');

    await sendSignAndComplete(request, token, envelopeId);

    softExpectCompletedKeepsCounterparty(await downloadEnvelopeItem(request, token, item.id, 'signed'), original);
  });

  test(`criterion_13_placeholder_field_added_after_upload_keeps_the_counterparty_signature (${label})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const fixture = await buildCounterpartySignedPlaceholderPdf([API_SIGNATURE_PLACEHOLDER], { ownerOnly });
    const original = expectFixtureCounterpartySignatureValid(fixture);
    const { token } = await apiCreateTestContext('signed-placeholder-api');

    const res = await uploadAsNewEnvelope(request, token, fixture);

    expect(res.status(), `envelope/create refused the signed placeholder PDF: ${await res.text()}`).toBe(200);

    const { id: envelopeId } = (await res.json()) as { id: string };
    const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId } });

    expect(await prisma.field.count({ where: { envelopeId } }), 'premise: an API-only placeholder places nothing').toBe(
      0,
    );

    const { data: recipients } = await apiCreateRecipients(request, token, envelopeId, [
      { email: uniqueEmail('api-placeholder-signer'), name: 'API Placeholder Signer' },
    ]);

    const fieldRes = await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        envelopeId,
        data: [{ recipientId: recipients[0].id, type: FieldType.SIGNATURE, placeholder: API_SIGNATURE_PLACEHOLDER }],
      },
    });
    const fieldText = await fieldRes.text();
    const saved = await prisma.field.count({ where: { envelopeId } });

    // Criterion 14 holds even if criterion 13 does not: a failed request saves nothing.
    expect.soft(fieldRes.ok() || saved === 0, `a failed field request left ${saved} field(s): ${fieldText}`).toBe(true);
    expect(fieldRes.status(), `field/create-many with a placeholder: ${fieldText}`).toBe(200);
    expect(saved, 'the field was placed from the placeholder').toBe(1);

    expectCounterpartySignatureStillValid(await readStoredItemFile(item.id), original, 'stored file after placement');

    await sendSignAndComplete(request, token, envelopeId);

    softExpectCompletedKeepsCounterparty(await downloadEnvelopeItem(request, token, item.id, 'signed'), original);
  });
}
