/**
 * Two-step document creation through API v1 (criteria 10 and 11).
 *
 * Written from the specification alone, without reading any implementation.
 *
 * API v1 creates a document, or a template, before any file exists, and hands
 * back an upload URL the client then PUTs the PDF to. The shapes used here
 * come from the OpenAPI document the running app serves at
 * /api/v1/openapi.json (createDocument returns `uploadUrl`, `documentId` and
 * `recipients`; createTemplate returns `template` and `uploadUrl`).
 *
 * | Test                                                          | Criteria | Failure modes |
 * | ------------------------------------------------------------- | -------- | ------------- |
 * | ordinary pdf, two-step document: send, sign, complete          | 10       | F10           |
 * | ordinary pdf, two-step template then generate: send, sign,     | 10       | F10           |
 * |   complete                                                     |          |               |
 * | owner-restricted pdf, two-step document: refused at send       | 11       | F11           |
 * |   [x3 ciphers]                                                 |          |               |
 * | owner-restricted pdf, two-step template: refused at generate   | 11       | F11           |
 * |   or at send, never reaches a signer                           |          |               |
 * | broken-signature pdf, two-step document: refused at send with  | 19       | F18           |
 * |   the criterion 17 code, nobody notified                       |          |               |
 * | owner-restricted pdf whose signature is broken: refused at     | 19       | F18           |
 * |   send as a broken signature, not with the envelope advice     |          |               |
 *
 * "A document from a template" is read as: create a template through
 * POST /api/v1/templates (the v1 route that returns an upload URL), upload the
 * PDF, then make a document from it with
 * POST /api/v1/templates/:id/generate-document. The template's recipient and
 * field are added through API v2, because v1 has no template recipient or
 * field routes.
 *
 * "No recipient is notified" is asserted as: the recipient's sendStatus stays
 * NOT_SENT, no EMAIL_SENT audit entry exists for the document, and no
 * send.signing.requested.email job exists for the recipient. "Nothing is
 * signed" is: the document never leaves DRAFT and no field is inserted.
 *
 * Two-step creation exists only under the S3 upload transport: under any
 * other, API v1 answers 500 "Create document is not available without S3
 * transport." Production and CI's e2e_local run
 * NEXT_PUBLIC_UPLOAD_TRANSPORT="database", so (Ram, 2026-10-06) the whole spec
 * skips, with that reason, unless the variable the app reads is "s3". Under
 * S3 nothing is skipped and every test fails or passes on its assertions; run
 * it against MinIO locally for the MR evidence.
 *
 * Criterion 19 asks for "the criterion 17 code" at send. The API v1 contract
 * (ZUnsuccessfulResponseSchema) declares only `message`, so where the code
 * travels in a v1 error is an assumption: these tests accept it in `code` or
 * in `data.code`, and require it in one of them.
 */
import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, type APIResponse, expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType, SendStatus, SigningStatus } from '@prisma/client';

import { apiCreateTestContext } from '../../fixtures/api-seeds';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildOwnerOnlyPdf,
  buildSignedThenOwnerOnlyPdf,
  buildSignedThenTamperedPdf,
  OWNER_ONLY_ALGORITHMS,
  ordinaryPdf,
  readEncryptionWithPdfinfo,
  readSignaturesWithPdfsig,
  SIGNATURE_ALREADY_INVALID,
  SIGNATURE_VALID,
  signV1AsRecipientInBrowser,
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

type V1Recipient = { recipientId: number; email: string; token: string };

const json = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

const bodyOf = async (res: APIResponse) => {
  const text = await res.text();

  try {
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { text, body: {} as Record<string, unknown> };
  }
};

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

const putToUploadUrl = async (request: APIRequestContext, uploadUrl: string, file: Buffer) => {
  const res = await request.put(uploadUrl, { headers: { 'Content-Type': 'application/pdf' }, data: file });

  expect(res.ok(), `PUT to the upload URL failed: ${res.status()} ${await res.text()}`).toBeTruthy();
};

/** Step one and two of the document flow: create with no file, then upload to the URL it returns. */
const createTwoStepDocument = async (request: APIRequestContext, token: string, file: Buffer, email: string) => {
  const res = await request.post(`${V1}/documents`, {
    headers: json(token),
    data: { title: 'Two-step document', recipients: [{ name: 'Two Step Signer', email, role: 'SIGNER' }] },
  });
  const { text, body } = await bodyOf(res);

  expect(res.status(), `POST /api/v1/documents: ${text}`).toBe(200);
  expect(typeof body.uploadUrl, 'an upload URL is returned before any file exists').toBe('string');

  await putToUploadUrl(request, body.uploadUrl as string, file);

  return { documentId: body.documentId as number, recipients: body.recipients as V1Recipient[] };
};

const addV1SignatureField = async (
  request: APIRequestContext,
  token: string,
  documentId: number,
  recipientId: number,
) => {
  const res = await request.post(`${V1}/documents/${documentId}/fields`, {
    headers: json(token),
    data: {
      recipientId,
      type: FieldType.SIGNATURE,
      pageNumber: 1,
      pageX: 10,
      pageY: 10,
      pageWidth: 20,
      pageHeight: 5,
      fieldMeta: { type: 'signature' },
    },
  });
  const { text, body } = await bodyOf(res);

  expect(res.status(), `POST /api/v1/documents/${documentId}/fields: ${text}`).toBe(200);

  const fields = body.fields as { id: number } | Array<{ id: number }>;

  return Array.isArray(fields) ? fields[0].id : fields.id;
};

const sendV1 = async (request: APIRequestContext, token: string, documentId: number) =>
  await request.post(`${V1}/documents/${documentId}/send`, { headers: json(token), data: { sendEmail: true } });

const envelopeForDocument = async (documentId: number) =>
  await prisma.envelope.findFirstOrThrow({
    where: { secondaryId: `document_${documentId}` },
    include: { recipients: true, fields: true, envelopeItems: true },
  });

const signAndWaitForCompletion = async (page: Page, documentId: number, recipientToken: string, fieldId: number) => {
  await signV1AsRecipientInBrowser({ page, recipientToken, fieldId });

  await expect(async () => {
    const envelope = await envelopeForDocument(documentId);

    expect(envelope.status).toBe(DocumentStatus.COMPLETED);
  }).toPass({ timeout: 45_000 });
};

const downloadCompletedV1 = async (request: APIRequestContext, token: string, documentId: number) => {
  const res = await request.get(`${V1}/documents/${documentId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { text, body } = await bodyOf(res);

  expect(res.status(), `GET /api/v1/documents/${documentId}/download: ${text}`).toBe(200);

  const file = await request.get(body.downloadUrl as string);

  expect(file.ok(), `fetching the download URL failed: ${file.status()}`).toBeTruthy();

  return new Uint8Array(await file.body());
};

const expectSealedBySign = (completed: Uint8Array) => {
  const signatures = readSignaturesWithPdfsig(completed);

  expect(signatures.length, 'the completed PDF carries Sign’s signature').toBeGreaterThanOrEqual(1);

  for (const signature of signatures) {
    expect(signature.validation, `pdfsig verifies signature #${signature.index}`).toBe(SIGNATURE_VALID);
  }
};

/** Nobody was asked to sign and nothing was signed. */
const expectNotDistributed = async (documentId: number) => {
  const envelope = await envelopeForDocument(documentId);

  expect(envelope.status, 'the document never left draft').toBe(DocumentStatus.DRAFT);

  for (const recipient of envelope.recipients) {
    expect(recipient.sendStatus, `${recipient.email} was not sent the document`).toBe(SendStatus.NOT_SENT);
    expect(recipient.signingStatus, `${recipient.email} has not signed`).toBe(SigningStatus.NOT_SIGNED);

    const jobs = await prisma.backgroundJob.count({
      where: { jobId: 'send.signing.requested.email', payload: { path: ['recipientId'], equals: recipient.id } },
    });

    expect(jobs, `no signing request email was queued for ${recipient.email}`).toBe(0);
  }

  expect(
    envelope.fields.every((field) => !field.inserted),
    'no field is signed',
  ).toBe(true);
  expect(
    await prisma.documentAuditLog.count({ where: { envelopeId: envelope.id, type: 'EMAIL_SENT' } }),
    'no email was sent for the document',
  ).toBe(0);
};

const expectRefusedWithEnvelopeAdvice = async (res: APIResponse, context: string) => {
  const { text, body } = await bodyOf(res);

  expect(res.status(), `${context}: expected a refusal, got ${res.status()}: ${text}`).toBeGreaterThanOrEqual(400);
  expect(res.status(), `${context}: a refusal is the client's problem, not a server error: ${text}`).toBeLessThan(500);
  expect(res.status(), `${context}: the request reached its target: ${text}`).not.toBe(404);
  expect(String(body.message ?? ''), `${context}: the message tells the sender to use an envelope instead`).toMatch(
    /envelope/i,
  );
};

/** Template two-step: create the template with no file, upload, give it one signer with one signature field. */
const createTwoStepTemplate = async (request: APIRequestContext, token: string, file: Buffer) => {
  const res = await request.post(`${V1}/templates`, { headers: json(token), data: { title: 'Two-step template' } });
  const { text, body } = await bodyOf(res);

  expect(res.status(), `POST /api/v1/templates: ${text}`).toBe(200);
  expect(typeof body.uploadUrl, 'an upload URL is returned before any file exists').toBe('string');

  await putToUploadUrl(request, body.uploadUrl as string, file);

  const template = body.template as { id: number; envelopeId: string };

  const recipientRes = await request.post(`${API_BASE_URL}/envelope/recipient/create-many`, {
    headers: json(token),
    data: {
      envelopeId: template.envelopeId,
      data: [{ email: uniqueEmail('template-role'), name: 'Template Signer', role: 'SIGNER' }],
    },
  });

  expect(recipientRes.ok(), `adding the template recipient: ${await recipientRes.text()}`).toBeTruthy();

  const templateRecipientId = ((await recipientRes.json()) as { data: Array<{ id: number }> }).data[0].id;

  const fieldRes = await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
    headers: json(token),
    data: {
      envelopeId: template.envelopeId,
      data: [
        {
          recipientId: templateRecipientId,
          type: FieldType.SIGNATURE,
          page: 1,
          positionX: 10,
          positionY: 10,
          width: 20,
          height: 5,
        },
      ],
    },
  });

  expect(fieldRes.ok(), `adding the template field: ${await fieldRes.text()}`).toBeTruthy();

  return { templateId: template.id, templateRecipientId };
};

const generateFromTemplate = async (
  request: APIRequestContext,
  token: string,
  templateId: number,
  templateRecipientId: number,
  email: string,
) =>
  await request.post(`${V1}/templates/${templateId}/generate-document`, {
    headers: json(token),
    data: { recipients: [{ id: templateRecipientId, email, name: 'Generated Signer' }] },
  });

test('criterion_10_two_step_v1_document_with_an_ordinary_pdf_sends_signs_and_completes', async ({ request, page }) => {
  test.setTimeout(120_000);

  const { token } = await apiCreateTestContext('v1-two-step-ordinary');
  const email = uniqueEmail('two-step-signer');

  const { documentId, recipients } = await createTwoStepDocument(request, token, ordinaryPdf(), email);
  const fieldId = await addV1SignatureField(request, token, documentId, recipients[0].recipientId);

  const send = await sendV1(request, token, documentId);

  expect(send.status(), `send: ${await send.text()}`).toBe(200);
  expect((await envelopeForDocument(documentId)).internalVersion, 'premise: v1 makes a legacy V1 document').toBe(1);

  await signAndWaitForCompletion(page, documentId, recipients[0].token, fieldId);

  expectSealedBySign(await downloadCompletedV1(request, token, documentId));
});

test('criterion_10_two_step_v1_template_with_an_ordinary_pdf_generates_a_document_that_sends_signs_and_completes', async ({
  request,
  page,
}) => {
  test.setTimeout(120_000);

  const { token } = await apiCreateTestContext('v1-two-step-template-ordinary');
  const { templateId, templateRecipientId } = await createTwoStepTemplate(request, token, ordinaryPdf());

  const generated = await generateFromTemplate(request, token, templateId, templateRecipientId, uniqueEmail('gen'));
  const { text, body } = await bodyOf(generated);

  expect(generated.status(), `generate-document: ${text}`).toBe(200);

  const documentId = body.documentId as number;
  const recipient = (body.recipients as V1Recipient[])[0];

  const send = await sendV1(request, token, documentId);

  expect(send.status(), `send: ${await send.text()}`).toBe(200);

  const envelope = await envelopeForDocument(documentId);
  const field = envelope.fields.find((f) => f.recipientId === recipient.recipientId && f.type === FieldType.SIGNATURE);

  expect(field, 'the template field was copied to the document').toBeTruthy();

  await signAndWaitForCompletion(page, documentId, recipient.token, field!.id);

  expectSealedBySign(await downloadCompletedV1(request, token, documentId));
});

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`criterion_11_two_step_v1_document_with_an_owner_restricted_pdf_is_refused_at_send (${algorithm})`, async ({
    request,
  }) => {
    const { token } = await apiCreateTestContext('v1-two-step-protected');

    const { documentId, recipients } = await createTwoStepDocument(
      request,
      token,
      await buildOwnerOnlyPdf(algorithm),
      uniqueEmail('two-step-protected'),
    );

    await addV1SignatureField(request, token, documentId, recipients[0].recipientId);

    await expectRefusedWithEnvelopeAdvice(await sendV1(request, token, documentId), 'send');
    await expectNotDistributed(documentId);
  });
}

test('criterion_11_two_step_v1_template_with_an_owner_restricted_pdf_never_reaches_a_signer', async ({ request }) => {
  const { token, team } = await apiCreateTestContext('v1-two-step-template-protected');
  const { templateId, templateRecipientId } = await createTwoStepTemplate(
    request,
    token,
    await buildOwnerOnlyPdf('AES-256'),
  );
  const email = uniqueEmail('gen-protected');

  // Refusal at generation (criterion 9) or at sending (criterion 11) are both
  // acceptable. Reaching a signer is not.
  const generated = await generateFromTemplate(request, token, templateId, templateRecipientId, email);

  if (!generated.ok()) {
    await expectRefusedWithEnvelopeAdvice(generated, 'generate-document');
    expect(await prisma.envelope.count({ where: { teamId: team.id, type: 'DOCUMENT' } }), 'no document is stored').toBe(
      0,
    );
    expect(await prisma.recipient.count({ where: { email } }), 'no recipient exists to be notified').toBe(0);

    return;
  }

  const documentId = ((await generated.json()) as { documentId: number }).documentId;

  await expectRefusedWithEnvelopeAdvice(await sendV1(request, token, documentId), 'send');
  await expectNotDistributed(documentId);
});

/** Criterion 19: refused at send as a signature already invalid on arrival, with the criterion 17 code. */
const expectRefusedAsAlreadyBroken = async (res: APIResponse, context: string) => {
  const { text, body } = await bodyOf(res);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const message = String(body.message ?? '');

  expect(res.status(), `${context}: expected 400, got ${res.status()}: ${text}`).toBe(400);
  expect([body.code, data.code], `${context}: the criterion 17 code is reported: ${text}`).toContain(
    SIGNATURE_ALREADY_INVALID,
  );
  expect(message, `${context}: the message is about the existing signature`).toMatch(/signature/i);
  expect(message, `${context}: the message says the signature is already invalid`).toMatch(
    /already|on arrival|before (it was )?upload/i,
  );
  expect(message, `${context}: the message does not claim Sign would invalidate it`).not.toMatch(
    /would (be )?invalidat|storing it|by storing|sign would|we would/i,
  );
};

const expectBrokenSignature = (fixture: Buffer, encrypted: boolean) => {
  const signatures = readSignaturesWithPdfsig(fixture);

  expect(readEncryptionWithPdfinfo(fixture).encrypted, `fixture precondition: encrypted is ${encrypted}`).toBe(
    encrypted,
  );
  expect(signatures, 'fixture precondition: one counterparty signature').toHaveLength(1);
  expect(signatures[0].validation, 'fixture precondition: pdfsig says it does not verify').not.toBe(SIGNATURE_VALID);
};

test('criterion_19_two_step_v1_document_with_a_broken_signature_is_refused_at_send_with_the_criterion_17_code', async ({
  request,
}) => {
  const fixture = await buildSignedThenTamperedPdf();

  expectBrokenSignature(fixture, false);

  const { token } = await apiCreateTestContext('v1-two-step-broken');
  const { documentId, recipients } = await createTwoStepDocument(
    request,
    token,
    fixture,
    uniqueEmail('two-step-broken'),
  );

  await addV1SignatureField(request, token, documentId, recipients[0].recipientId);

  await expectRefusedAsAlreadyBroken(await sendV1(request, token, documentId), 'send');
  await expectNotDistributed(documentId);
});

test('criterion_19_two_step_v1_owner_restricted_pdf_with_a_broken_signature_reports_the_signature_not_the_envelope_advice', async ({
  request,
}) => {
  const fixture = await buildSignedThenOwnerOnlyPdf();

  expectBrokenSignature(fixture, true);

  const { token } = await apiCreateTestContext('v1-two-step-protected-broken');
  const { documentId, recipients } = await createTwoStepDocument(
    request,
    token,
    fixture,
    uniqueEmail('two-step-protected-broken'),
  );

  await addV1SignatureField(request, token, documentId, recipients[0].recipientId);

  const res = await sendV1(request, token, documentId);
  const { body } = await bodyOf(res);

  await expectRefusedAsAlreadyBroken(res, 'send');
  expect(String(body.message ?? ''), 'the legacy-envelope advice is not what is reported').not.toMatch(
    /use an envelope|envelope instead/i,
  );
  await expectNotDistributed(documentId);
});
