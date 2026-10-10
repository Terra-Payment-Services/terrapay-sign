/**
 * The V1 PDF check after a two-step upload, as it stands once the
 * send no longer leaves the upload URL pointing at the document's PDF.
 *
 * Written from the specification alone, without reading the send or resend
 * implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | two-step V1 document, PDF unchanged: send then resend, the         | 2, 3 | F4            |
 * |   recipient receives both emails                                   |          |               |
 * | late PUT after send: v1 repeat send answers 200, recipient         | 3    | F1            |
 * |   is served the original PDF                                       |          |               |
 * | late PUT after send: tRPC distribute answers 200                   | 3    | F1            |
 * | late PUT after send: v1 resend answers 200 and emails the          | 3    | F1            |
 * |   recipient                                                        |          |               |
 * | late PUT after send: tRPC redistribute answers 200 and emails      | 3    | F1            |
 * |   the recipient                                                    |          |               |
 * | late PUT after send: signing reminder emails the recipient         | 3    | F1            |
 * | no late PUT: signing reminder emails the recipient (control)       | 2    | F8            |
 * | v1 send of a file that is not a PDF: 400 naming                    | 4    | F3            |
 * |   INVALID_DOCUMENT_FILE, never 500                                 |          |               |
 * | v1 send of a broken-signature PDF keeps its 400                    | 4    | F3            |
 * |   SIGNATURE_ALREADY_INVALID answer                                 |          |               |
 *
 * Rewritten for the send-time copy. Five tests here were built on `sendThenOverwrite`, whose
 * premise was that the send keeps the DocumentData id and S3 key and that a PUT
 * to the upload URL after the send replaces the stored PDF, so that the repeat
 * send, resend, distribute, redistribute and reminder were then refused. The send-time copy
 * makes that premise false by design: after the send no row names the key the
 * URL can write, so a late PUT changes nothing the document reads. The five
 * now do `sendThenLatePut` and assert what criterion 3 asks for: the same
 * routes answer 200 and the recipient receives the emails, because the PDF
 * they check is still the original. The reminder test gained a control
 * without a late PUT, which passes before and after the change.
 *
 * Two-step creation exists only under the S3 upload transport, so (criterion 5
 * of the send-path work) the whole spec skips with that reason unless
 * NEXT_PUBLIC_UPLOAD_TRANSPORT is "s3". Run it against MinIO locally for the
 * MR evidence.
 *
 * The file that triggers INVALID_DOCUMENT_FILE is one that is not a PDF at
 * all. The same document sent through the tRPC distribute procedure answers
 * 400 with data.code INVALID_DOCUMENT_FILE, which establishes the code.
 *
 * "No email" is measured as in send-path-pdf-check.spec.ts.
 */
import { expect, test } from '@playwright/test';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  assertVerifierToolsPresent,
  buildSignedThenTamperedPdf,
  readEncryptionWithPdfinfo,
  SIGNATURE_ALREADY_INVALID,
} from '../../fixtures/protected-pdfs';
import {
  assertMailCatcherReachable,
  expectNoNewMail,
  readRefusal,
  runSigningReminder,
  v1Resend,
  v1Send,
  v2Distribute,
  v2Redistribute,
  waitForMail,
} from '../../fixtures/send-path';
import {
  buildMarkerPdf,
  buildOwnerRestrictedMarkerPdf,
  createTwoStep,
  fetchRecipientPdf,
  sha256,
  uniqueMarker,
} from '../../fixtures/two-step-upload';

test.describe.configure({ mode: 'parallel' });

const UPLOAD_TRANSPORT = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;

test.skip(
  UPLOAD_TRANSPORT !== 's3',
  `Two-step v1 creation exists only under the S3 upload transport; NEXT_PUBLIC_UPLOAD_TRANSPORT is ${JSON.stringify(UPLOAD_TRANSPORT ?? null)}.`,
);

test.beforeAll(async ({ request }) => {
  assertVerifierToolsPresent();
  await assertMailCatcherReachable(request);
});

/**
 * Sends an ordinary two-step document (the check passes and the signer is
 * emailed), then PUTs an owner-restricted replacement to the same upload URL.
 * Whether that PUT fails or succeeds is not asserted here: criterion 3
 * allows either, and what matters is what the document does afterwards.
 */
const sendThenLatePut = async (request: Parameters<typeof createTwoStep>[0], token: string, label: string) => {
  const original = buildMarkerPdf(uniqueMarker('ORIGINAL'), 2);
  const doc = await createTwoStep(request, token, label, original);

  const send = await v1Send(request, token, doc.documentId);

  expect(send.status(), `first send of the ordinary PDF: ${await send.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 1);

  const replacement = buildOwnerRestrictedMarkerPdf(uniqueMarker('REPLACEMENT'), 5);

  expect(
    readEncryptionWithPdfinfo(replacement).encrypted,
    'fixture precondition: the replacement is owner-restricted',
  ).toBe(true);

  await request.put(doc.uploadUrl, { headers: { 'Content-Type': 'application/pdf' }, data: replacement });

  return { doc, original };
};

const expectRecipientStillServedOriginal = async (
  request: Parameters<typeof createTwoStep>[0],
  doc: Awaited<ReturnType<typeof createTwoStep>>,
  original: Buffer,
  context: string,
) => {
  for (const version of ['current', 'initial'] as const) {
    const served = await fetchRecipientPdf(request, doc.documentId, doc.recipientId, version);

    expect(sha256(served), `${context}: the recipient's ${version} PDF is still the original upload`).toBe(
      sha256(original),
    );
  }
};

test('criteria_2_3_two_step_v1_document_whose_pdf_is_unchanged_is_sent_and_resent_and_the_recipient_receives_both', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-valid');
  const doc = await createTwoStep(request, token, 's3-valid', buildMarkerPdf(uniqueMarker('VALID')));

  const send = await v1Send(request, token, doc.documentId);

  expect(send.status(), `send: ${await send.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 1);

  const resend = await v1Resend(request, token, doc.documentId, [doc.recipientId]);

  expect(resend.status(), `resend: ${await resend.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 2);
});

test('criterion_37_3_v1_repeat_send_after_a_late_put_answers_200_and_the_recipient_is_served_the_original', async ({
  request,
}) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-repeat-send');
  const { doc, original } = await sendThenLatePut(request, token, 's3-repeat-send');

  const repeat = await v1Send(request, token, doc.documentId);

  expect(repeat.status(), `v1 repeat send after a late PUT: ${await repeat.text()}`).toBe(200);
  await expectRecipientStillServedOriginal(request, doc, original, 'v1 repeat send after a late PUT');
});

test('criterion_37_3_trpc_distribute_after_a_late_put_answers_200', async ({ request }) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-distribute');
  const { doc, original } = await sendThenLatePut(request, token, 's3-distribute');

  const distribute = await v2Distribute(request, token, doc.documentId);

  expect(distribute.status(), `distribute after a late PUT: ${await distribute.text()}`).toBe(200);
  await expectRecipientStillServedOriginal(request, doc, original, 'distribute after a late PUT');
});

test('criterion_37_3_v1_resend_after_a_late_put_answers_200_and_emails_the_recipient', async ({ request }) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-resend');
  const { doc } = await sendThenLatePut(request, token, 's3-resend');

  const resend = await v1Resend(request, token, doc.documentId, [doc.recipientId]);

  expect(resend.status(), `v1 resend after a late PUT: ${await resend.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 2);
});

test('criterion_37_3_trpc_redistribute_after_a_late_put_answers_200_and_emails_the_recipient', async ({ request }) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-redistribute');
  const { doc } = await sendThenLatePut(request, token, 's3-redistribute');

  const redistribute = await v2Redistribute(request, token, doc.documentId, [doc.recipientId]);

  expect(redistribute.status(), `redistribute after a late PUT: ${await redistribute.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 2);
});

test('criterion_37_3_signing_reminder_after_a_late_put_emails_the_recipient', async ({ request }) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-reminder');
  const { doc } = await sendThenLatePut(request, token, 's3-reminder');

  await runSigningReminder(request, doc.recipientId);

  await waitForMail(request, doc.localPart, 2);
});

test('control_signing_reminder_without_a_late_put_emails_the_recipient', async ({ request }) => {
  test.setTimeout(90_000);

  const { token } = await apiCreateTestContext('spt-s3-reminder-control');
  const doc = await createTwoStep(request, token, 's3-reminder-control', buildMarkerPdf(uniqueMarker('CONTROL')));

  const send = await v1Send(request, token, doc.documentId);

  expect(send.status(), `send: ${await send.text()}`).toBe(200);
  await waitForMail(request, doc.localPart, 1);

  await runSigningReminder(request, doc.recipientId);

  await waitForMail(request, doc.localPart, 2);
});

test('criterion_4_v1_send_of_a_file_that_is_not_a_pdf_answers_400_invalid_document_file_not_500', async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { token } = await apiCreateTestContext('spt-s3-invalid-file');
  const notAPdf = Buffer.from('This upload is plain text, not a PDF.\n');

  const premise = await createTwoStep(request, token, 's3-invalid-premise', notAPdf);
  const trpc = await readRefusal(await v2Distribute(request, token, premise.documentId));

  expect(
    { status: trpc.status, code: trpc.code },
    `premise: the DRAFT check refuses this file as INVALID_DOCUMENT_FILE: ${trpc.text}`,
  ).toEqual({ status: 400, code: 'INVALID_DOCUMENT_FILE' });

  const doc = await createTwoStep(request, token, 's3-invalid-file', notAPdf);
  const refusal = await readRefusal(await v1Send(request, token, doc.documentId));

  expect(refusal.status, `v1 send answers 400, not a server error: ${refusal.text}`).toBe(400);
  expect(refusal.message, `the body is not the generic server error: ${refusal.text}`).not.toMatch(
    /something went wrong/i,
  );
  expect(refusal.text, 'the body names INVALID_DOCUMENT_FILE').toContain('INVALID_DOCUMENT_FILE');
  await expectNoNewMail(request, doc.localPart, 0, 'v1 send of a file that is not a PDF');
});

test('criterion_4_v1_send_of_a_broken_signature_pdf_keeps_its_400_signature_already_invalid_answer', async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { token } = await apiCreateTestContext('spt-s3-broken-signature');
  const doc = await createTwoStep(request, token, 's3-broken-signature', await buildSignedThenTamperedPdf());
  const refusal = await readRefusal(await v1Send(request, token, doc.documentId));

  expect(refusal.status, `v1 send: ${refusal.text}`).toBe(400);
  expect(refusal.code, `the code is still reported: ${refusal.text}`).toBe(SIGNATURE_ALREADY_INVALID);
});
