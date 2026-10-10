/**
 * Countersigning protected and pre-signed PDFs through to completion.
 *
 * Written from the specification alone, before reading any implementation.
 *
 * Each test uploads a fixture, sends it to two Sign recipients, has the first
 * sign, downloads the pending copy, has the second sign, waits for completion
 * and downloads the sealed PDF. Every verdict on a signature comes from poppler
 * pdfsig reading the downloaded bytes, never from Sign, because F3 is the case
 * where Sign's own checks say intact and an independent verifier says broken.
 *
 * | Test                                                          | Criteria | Failure modes  |
 * | ------------------------------------------------------------- | -------- | -------------- |
 * | countersigned owner-restricted pdf completes with both         | 2,3,4,5  | F1,F3,F4,F5,F9 |
 * |   signatures verifying and its restrictions kept [x3 ciphers]  |          |                |
 * | unsigned owner-restricted pdf completes signed by Sign with    | 3,4      | F1,F4,F9       |
 * |   its restrictions kept [x3 ciphers]                           |          |                |
 * | countersigned unencrypted pdf completes with both signatures   | 6        | F3,F5          |
 * |   verifying                                                    |          |                |
 * | ordinary pdf signs, completes and downloads as before          | 8        | F8             |
 *
 * Expected on main (red run): the six owner-restricted tests fail at upload
 * (F1). The countersigned unencrypted test is expected to fail on the pending
 * copy (F5) if the pending download rewrites the file. The ordinary-PDF test
 * is a control and should pass on main.
 *
 * Checks within a flow are soft, so one run reports every criterion that
 * fails rather than stopping at the first.
 */
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../../fixtures/api-seeds';
import {
  assertVerifierToolsPresent,
  buildOwnerOnlyPdf,
  buildOwnerOnlyThenSignedPdf,
  buildSignedPlainPdf,
  buildSignedPlainPdfWithDerEndingInZero,
  COUNTERPARTY_FIELD_NAME,
  downloadEnvelopeItem,
  expectFixtureCounterpartySignatureValid,
  lastDerByteOfSignature,
  OWNER_ONLY_ALGORITHMS,
  ordinaryPdf,
  type PdfSignature,
  readEncryptionWithPdfinfo,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
  signAndCompleteAsRecipient,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

type FlowResult = {
  pending: Uint8Array;
  completed: Uint8Array;
};

/**
 * Upload, send to two signers, sign once, take the pending copy, sign again,
 * wait for completion, take the sealed copy.
 */
const runCountersigningFlow = async (
  request: APIRequestContext,
  fixture: Buffer,
  name: string,
): Promise<FlowResult> => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { envelope, token, distributeResult } = await apiSeedPendingDocument(request, {
    title: name,
    pdfFile: { name: `${name}.pdf`, data: fixture },
    recipients: [
      { email: `protected-signer-a-${stamp}@test.documenso.com`, name: 'Signer A' },
      { email: `protected-signer-b-${stamp}@test.documenso.com`, name: 'Signer B' },
    ],
    fieldsPerRecipient: [
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 60, width: 25, height: 8 }],
      [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 75, width: 25, height: 8 }],
    ],
  });

  const [recipientA, recipientB] = distributeResult.recipients;
  const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);
  const envelopeItemId = envelope.envelopeItems[0].id;

  const fieldFor = (recipientId: number) => {
    const field = envelope.fields.find((f) => f.recipientId === recipientId && f.type === FieldType.SIGNATURE);

    if (!field) {
      throw new Error(`No signature field for recipient ${recipientId}`);
    }

    return field;
  };

  await signAndCompleteAsRecipient({
    request,
    recipientToken: recipientA.token,
    documentId,
    fieldId: fieldFor(recipientA.id).id,
  });

  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({
      where: { id: envelope.id },
      include: { recipients: true },
    });

    expect(current.status).toBe(DocumentStatus.PENDING);
    expect(current.recipients.find((r) => r.id === recipientA.id)?.signingStatus).toBe(SigningStatus.SIGNED);
  }).toPass();

  const pending = await downloadEnvelopeItem(request, token, envelopeItemId, 'pending');

  await signAndCompleteAsRecipient({
    request,
    recipientToken: recipientB.token,
    documentId,
    fieldId: fieldFor(recipientB.id).id,
  });

  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

    expect(current.status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 45_000 });

  const completed = await downloadEnvelopeItem(request, token, envelopeItemId, 'signed');

  return { pending, completed };
};

const softExpectCounterpartyValid = (bytes: Uint8Array, original: PdfSignature, context: string) => {
  const signatures = readSignaturesWithPdfsig(bytes);
  const counterparty = signatures.find((s) => s.fieldName === COUNTERPARTY_FIELD_NAME);

  expect
    .soft(counterparty, `${context}: counterparty signature present (pdfsig saw ${signatures.length})`)
    .toBeTruthy();
  expect
    .soft(counterparty?.signingTime, `${context}: it is the counterparty's original signature`)
    .toBe(original.signingTime);
  expect.soft(counterparty?.validation, `${context}: pdfsig verifies the counterparty signature`).toBe(SIGNATURE_VALID);

  return signatures;
};

/** Sign's own seal is a signature that is not the counterparty's, and every signature verifies. */
const softExpectSealedBySignAndAllValid = (signatures: PdfSignature[], context: string) => {
  const sealing = signatures.filter((s) => s.fieldName !== COUNTERPARTY_FIELD_NAME);

  expect.soft(sealing.length, `${context}: Sign's own signature is present`).toBeGreaterThanOrEqual(1);

  for (const signature of signatures) {
    expect
      .soft(signature.validation, `${context}: pdfsig verifies signature #${signature.index} (${signature.fieldName})`)
      .toBe(SIGNATURE_VALID);
  }
};

const softExpectRestrictionsKept = (fixture: Uint8Array, completed: Uint8Array) => {
  const arrived = readEncryptionWithPdfinfo(fixture);
  const sealed = readEncryptionWithPdfinfo(completed);

  expect.soft(sealed.encrypted, `completed PDF is still protected (pdfinfo: "${sealed.raw}")`).toBe(true);
  expect
    .soft(sealed.permissions, `completed PDF keeps the restrictions it arrived with ("${arrived.raw}")`)
    .toEqual(arrived.permissions);
};

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`countersigned_owner_restricted_pdf_completes_with_both_signatures_verifying_and_restrictions_kept (${algorithm})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const fixture = await buildOwnerOnlyThenSignedPdf(algorithm);
    const original = expectFixtureCounterpartySignatureValid(fixture);

    const { pending, completed } = await runCountersigningFlow(request, fixture, `countersigned-owner-${algorithm}`);

    softExpectCounterpartyValid(pending, original, 'pending copy');

    const sealedSignatures = softExpectCounterpartyValid(completed, original, 'completed PDF');
    softExpectSealedBySignAndAllValid(sealedSignatures, 'completed PDF');

    softExpectRestrictionsKept(fixture, completed);
  });

  test(`unsigned_owner_restricted_pdf_completes_signed_by_sign_with_its_restrictions_kept (${algorithm})`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const fixture = await buildOwnerOnlyPdf(algorithm);

    const { completed } = await runCountersigningFlow(request, fixture, `unsigned-owner-${algorithm}`);

    const signatures = readSignaturesWithPdfsig(completed);
    softExpectSealedBySignAndAllValid(signatures, 'completed PDF');

    softExpectRestrictionsKept(fixture, completed);
  });
}

test('countersigned_unencrypted_pdf_completes_with_both_signatures_verifying', async ({ request }) => {
  test.setTimeout(120_000);

  const fixture = await buildSignedPlainPdf();
  const original = expectFixtureCounterpartySignatureValid(fixture);

  const { pending, completed } = await runCountersigningFlow(request, fixture, 'countersigned-plain');

  softExpectCounterpartyValid(pending, original, 'pending copy');

  const sealedSignatures = softExpectCounterpartyValid(completed, original, 'completed PDF');
  softExpectSealedBySignAndAllValid(sealedSignatures, 'completed PDF');
});

/**
 * Regression: a counterparty signature whose DER ends in 0x00 (about one in
 * 256) must survive countersigning. The fixture is searched for until its
 * DER's last byte is 0x00, so this runs the rare case every time.
 */
test('countersigned_pdf_whose_signature_der_ends_in_zero_completes_with_both_signatures_verifying', async ({
  request,
}) => {
  test.setTimeout(120_000);

  const fixture = await buildSignedPlainPdfWithDerEndingInZero();

  expect(lastDerByteOfSignature(fixture), 'fixture precondition: the signature DER ends in 0x00').toBe(0x00);

  const original = expectFixtureCounterpartySignatureValid(fixture);
  const { pending, completed } = await runCountersigningFlow(request, fixture, 'countersigned-der-zero');

  softExpectCounterpartyValid(pending, original, 'pending copy');

  const sealedSignatures = softExpectCounterpartyValid(completed, original, 'completed PDF');
  softExpectSealedBySignAndAllValid(sealedSignatures, 'completed PDF');
});

test('ordinary_pdf_signs_completes_and_downloads_as_before', async ({ request }) => {
  test.setTimeout(120_000);

  // The pending copy downloading as a PDF at all is the check (inside the flow).
  const { completed } = await runCountersigningFlow(request, ordinaryPdf(), 'ordinary');

  const signatures = readSignaturesWithPdfsig(completed);
  softExpectSealedBySignAndAllValid(signatures, 'completed PDF');

  expect.soft(readEncryptionWithPdfinfo(completed).encrypted, 'an ordinary PDF is not encrypted by Sign').toBe(false);
});
