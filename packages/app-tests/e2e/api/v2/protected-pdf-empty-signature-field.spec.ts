/**
 * A PDF whose signature field was never signed (criterion 15).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * Such a PDF carries an AcroForm signature field with no value. It is an
 * unsigned PDF, and must upload, sign, complete and download (pending copy
 * included) exactly as an ordinary PDF does, linearised or not (F14: the empty
 * field is mistaken for a signature and the PDF is refused or altered).
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | empty signature field pdf: upload, pending copy, complete      | 15       | F14           |
 * | linearised empty signature field pdf: the same                 | 15       | F14           |
 * | empty signature field pdf added as an extra document           | 15       | F14           |
 * | ordinary pdf through the same flow (control)                   | 8, 15    | F8            |
 *
 * Fixture preconditions are checked with poppler before use: pdfinfo reports
 * an AcroForm (and "Optimized: yes" for the linearised one), and pdfsig lists
 * the field with "The signature form field is not signed." and no signature.
 * pdfsig keeps listing an unsigned field that way, so on the completed PDF the
 * check is that every signed signature verifies and that Sign's own is among
 * them. Whether Sign seals into the empty field or a new one is recorded as an
 * annotation, not asserted: the specification does not say.
 */
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiCreateEnvelope, apiCreateTestContext, apiSeedPendingDocument } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildEmptySignatureFieldPdf,
  buildLinearisedEmptySignatureFieldPdf,
  downloadEnvelopeItem,
  EMPTY_SIGNATURE_FIELD_NAME,
  ordinaryPdf,
  pdfsigReport,
  readEncryptionWithPdfinfo,
  readInfoWithPdfinfo,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
  signAndCompleteAsRecipient,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const expectEmptySignatureFieldFixture = (bytes: Uint8Array, { linearised }: { linearised: boolean }) => {
  const info = readInfoWithPdfinfo(bytes);
  const report = pdfsigReport(bytes);

  expect(info.Form, 'fixture precondition: the PDF has an AcroForm').toBe('AcroForm');
  expect(info.Optimized, 'fixture precondition: linearisation').toBe(linearised ? 'yes' : 'no');
  expect(report, 'fixture precondition: pdfsig sees the field').toContain(EMPTY_SIGNATURE_FIELD_NAME);
  expect(report, 'fixture precondition: pdfsig says the field is not signed').toContain(
    'The signature form field is not signed.',
  );
  expect(report, 'fixture precondition: there is no signature to validate').not.toContain('Signature Validation');
};

/**
 * Upload, send to two signers, take the pending copy after the first signs,
 * then complete and take the sealed copy. Every step a user sees must work.
 */
const runTwoSignerFlow = async (request: APIRequestContext, file: Buffer, name: string) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { envelope, token, distributeResult } = await apiSeedPendingDocument(request, {
    title: name,
    pdfFile: { name: `${name}.pdf`, data: file },
    recipients: [
      { email: `empty-field-a-${stamp}@test.documenso.com`, name: 'Signer A' },
      { email: `empty-field-b-${stamp}@test.documenso.com`, name: 'Signer B' },
    ],
    fieldsPerRecipient: [
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 30, width: 25, height: 8 }],
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 45, width: 25, height: 8 }],
    ],
  });

  const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);
  const envelopeItemId = envelope.envelopeItems[0].id;
  const [first, second] = distributeResult.recipients;
  const fieldFor = (recipientId: number) => envelope.fields.find((f) => f.recipientId === recipientId)!.id;

  await signAndCompleteAsRecipient({ request, recipientToken: first.token, documentId, fieldId: fieldFor(first.id) });

  await expect(async () => {
    const current = await prisma.recipient.findUniqueOrThrow({ where: { id: first.id } });

    expect(current.signingStatus).toBe(SigningStatus.SIGNED);
  }).toPass();

  const pending = await downloadEnvelopeItem(request, token, envelopeItemId, 'pending');

  await signAndCompleteAsRecipient({ request, recipientToken: second.token, documentId, fieldId: fieldFor(second.id) });

  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

    expect(current.status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 45_000 });

  const completed = await downloadEnvelopeItem(request, token, envelopeItemId, 'signed');

  return { pending, completed };
};

const expectCompletedAsAnOrdinaryPdf = (completed: Uint8Array) => {
  const signatures = readSignaturesWithPdfsig(completed);
  const signed = signatures.filter((s) => s.validation !== '');

  expect.soft(signed.length, `Sign's own signature is present:\n${pdfsigReport(completed)}`).toBeGreaterThanOrEqual(1);

  for (const signature of signed) {
    expect
      .soft(signature.validation, `pdfsig verifies signature #${signature.index} (${signature.fieldName})`)
      .toBe(SIGNATURE_VALID);
  }

  // Which field carries Sign's seal (a new one, or the empty one the PDF
  // arrived with) is not something the specification decides, so it is
  // recorded rather than asserted.
  test.info().annotations.push({ type: 'pdfsig (completed)', description: pdfsigReport(completed) });
  expect.soft(readEncryptionWithPdfinfo(completed).encrypted, 'Sign does not encrypt an unsigned PDF').toBe(false);
};

const FIXTURES = [
  { label: 'not linearised', build: buildEmptySignatureFieldPdf, linearised: false },
  { label: 'linearised', build: buildLinearisedEmptySignatureFieldPdf, linearised: true },
];

for (const { label, build, linearised } of FIXTURES) {
  test(`criterion_15_pdf_with_an_empty_signature_field_uploads_signs_completes_and_downloads (${label})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const fixture = await build();

    expectEmptySignatureFieldFixture(fixture, { linearised });

    const { pending, completed } = await runTwoSignerFlow(request, fixture, `empty-signature-field-${label}`);

    expect.soft(readSignaturesWithPdfsig(pending).filter((s) => s.validation !== '').length, 'pending copy').toBe(0);

    expectCompletedAsAnOrdinaryPdf(completed);
  });
}

test('criterion_15_pdf_with_an_empty_signature_field_uploads_as_an_extra_document', async ({ request }) => {
  const { token } = await apiCreateTestContext('empty-signature-field-extra');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Envelope with an extra document' });

  for (const build of [buildEmptySignatureFieldPdf, buildLinearisedEmptySignatureFieldPdf]) {
    const formData = new FormData();

    formData.append('payload', JSON.stringify({ envelopeId }));
    formData.append('files', new File([await build()], 'empty-signature-field.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: formData,
    });

    expect(res.status(), `envelope/item/create-many refused the PDF: ${await res.text()}`).toBe(200);
  }
});

test('criterion_15_control_ordinary_pdf_through_the_same_flow', async ({ request }) => {
  test.setTimeout(120_000);

  const { completed } = await runTwoSignerFlow(request, ordinaryPdf(), 'empty-signature-field-control');

  expectCompletedAsAnOrdinaryPdf(completed);
});
