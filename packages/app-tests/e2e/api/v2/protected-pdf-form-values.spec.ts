/**
 * A valid signed PDF uploaded with form values is never blamed for damage
 * Sign would do (criterion 18, F17).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | signed fillable form + formValues, as a new envelope           | 18, 23   | F17, F22      |
 * | the same, form linearised before the counterparty signed       | 18, 23   | F17, F22      |
 * | the same, with a damaged final startxref so the file needs     | 18       | F17           |
 * |   recovery, while pdfsig still verifies the signature          |          |               |
 *
 * The fixture is the repository's fillable-form PDF (the one the
 * form-flattening spec fills), signed by the counterparty. pdfsig verifies the
 * signature on the fixture, so the file is valid on arrival. Filling the form
 * changes the signed bytes, so Sign has two acceptable answers:
 *
 * - accept it, in which case the stored file's counterparty signature still
 *   verifies (criterion 2);
 * - refuse it with 400, a code in data.code that is neither the criterion 17
 *   code (SIGNATURE_ALREADY_INVALID) nor a generic one, a message that does
 *   not say the file's signature is already invalid, and nothing stored.
 *
 * Criterion 23 (F22) extends the accepted branch: Sign flattens filled
 * forms, so every supplied text or choice value must appear in the stored
 * PDF's page content, read by pdftotext, not by Sign.
 *
 * Anything else, including a 5xx, fails. formValues travel in the
 * envelope/create payload, as the form-flattening spec sends them.
 *
 * The linearised variant is linearised by qpdf and then signed as an
 * incremental update, as Acrobat signs a fast-web-view file. pdfinfo reports
 * such a file as no longer optimised, so the precondition checks that the
 * first revision carries the /Linearized dictionary instead.
 *
 * The recovery variant (added after the coordinator reported, 2026-10-06,
 * that the PDF library falls back to a full save when a file needs
 * brute-force recovery): the form is written with classic xref tables, signed,
 * and given an appended end-of-file section whose startxref points past the
 * end. qpdf --check reports the file damaged; pdfsig recovers it and still
 * verifies the counterparty signature over its /ByteRange.
 */
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildCounterpartySignedFormPdf,
  buildCounterpartySignedFormPdfNeedingRecovery,
  expectCounterpartySignatureStillValid,
  expectFixtureCounterpartySignatureValid,
  FORM_VALUES,
  qpdfCheck,
  readInfoWithPdfinfo,
  readPageTextWithPdftotext,
  SIGNATURE_ALREADY_INVALID,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const createWithFormValues = async (request: APIRequestContext, token: string, file: Buffer) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ type: 'DOCUMENT', title: 'Signed form', formValues: FORM_VALUES }));
  formData.append('files', new File([file], 'signed-form.pdf', { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

/**
 * Criterion 23 (F22), as clarified: Sign flattens filled forms, so each
 * supplied value must appear in the stored PDF's page content, read by
 * pdftotext. The caller has already checked the counterparty signature still
 * verifies. A ticked checkbox draws a mark, not text, so pdftotext cannot see
 * it; only the text and choice values are checked.
 */
const expectEveryFormValueStored = (stored: Uint8Array) => {
  const pageText = readPageTextWithPdftotext(stored);

  test.info().annotations.push({ type: 'stored page text (pdftotext)', description: pageText.slice(0, 500) });

  for (const [name, supplied] of Object.entries(FORM_VALUES)) {
    if (typeof supplied === 'string') {
      expect(pageText, `criterion 23: the value supplied for ${name} is on the page`).toContain(supplied);
    }
  }
};

/** Upload with formValues; accepted with the signature intact, or refused without blaming the file. */
const expectNeverBlamedForSignsDamage = async (
  request: APIRequestContext,
  fixture: Buffer,
  original: ReturnType<typeof expectFixtureCounterpartySignatureValid>,
  label: string,
) => {
  const { token, user, team } = await apiCreateTestContext(`signed-form-${label}`);
  const res = await createWithFormValues(request, token, fixture);
  const text = await res.text();

  test.info().annotations.push({ type: 'response', description: `${res.status()} ${text.slice(0, 500)}` });

  if (res.status() === 200) {
    const { id } = JSON.parse(text) as { id: string };
    const item = await prisma.envelopeItem.findFirstOrThrow({
      where: { envelopeId: id },
      include: { documentData: true },
    });
    const stored = new Uint8Array(await getFileServerSide(item.documentData));

    expectCounterpartySignatureStillValid(stored, original, 'accepted with form values, the stored file');
    expectEveryFormValueStored(stored);

    return;
  }

  const body = JSON.parse(text || '{}');
  const message = String(body.message ?? '');

  expect(res.status(), `either accepted intact or refused with 400: ${text}`).toBe(400);
  expect(typeof body.data?.code, `a refusal carries a code in data.code: ${text}`).toBe('string');
  expect(body.data?.code, 'the valid file is not refused as arriving with a broken signature').not.toBe(
    SIGNATURE_ALREADY_INVALID,
  );
  expect(body.data?.code, 'a specific refusal, not a generic server error').not.toBe('INTERNAL_SERVER_ERROR');
  expect(message, 'the message does not say the file’s signature is already invalid').not.toMatch(
    /already|on arrival|before (it was )?upload/i,
  );
  expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'no envelope is stored').toBe(0);
  expect(
    await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
    'no document data is stored',
  ).toBe(0);
};

for (const variant of ['plain', 'linearised'] as const) {
  test(`criterion_18_valid_signed_form_with_form_values_is_never_refused_as_already_invalid (${variant})`, async ({
    request,
  }) => {
    const fixture = await buildCounterpartySignedFormPdf(variant);
    const original = expectFixtureCounterpartySignatureValid(fixture);

    expect(readInfoWithPdfinfo(fixture).Form, 'fixture precondition: the PDF has a fillable form').toBe('AcroForm');

    if (variant === 'linearised') {
      expect(
        fixture.subarray(0, 1024).toString('latin1'),
        'fixture precondition: the first revision is linearised',
      ).toContain('/Linearized');
    }

    await expectNeverBlamedForSignsDamage(request, fixture, original, variant);
  });
}

test('criterion_18_valid_signed_form_needing_recovery_with_form_values_is_never_refused_as_already_invalid', async ({
  request,
}) => {
  const fixture = await buildCounterpartySignedFormPdfNeedingRecovery();
  const original = expectFixtureCounterpartySignatureValid(fixture);
  const check = qpdfCheck(fixture);

  expect(readInfoWithPdfinfo(fixture).Form, 'fixture precondition: the PDF has a fillable form').toBe('AcroForm');
  expect(check.output, 'fixture precondition: qpdf finds the file damaged and must recover it').toMatch(
    /damaged|reconstruct/i,
  );

  await expectNeverBlamedForSignsDamage(request, fixture, original, 'needs-recovery');
});
