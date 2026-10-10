/**
 * Uploading protected PDFs, through the public v2 API and the upload
 * endpoint the web app uses.
 *
 * Written from the specification alone, before reading any implementation.
 *
 * | Test                                                              | Criteria | Failure modes |
 * | ----------------------------------------------------------------- | -------- | ------------- |
 * | owner-restricted pdf uploads as a new envelope [x3 ciphers]        | 1        | F1, F9        |
 * | owner-restricted pdf uploads as an extra document [x3 ciphers]     | 1        | F1, F9        |
 * | counterparty signature verifies in the stored file, new envelope   | 2        | F1, F2, F9    |
 * |   [x3 ciphers]                                                     |          |               |
 * | counterparty signature verifies in the stored file, extra document | 2        | F1, F2, F9    |
 * |   [x3 ciphers]                                                     |          |               |
 * | pdf whose signature is broken on arrival is refused, as a new      | 17       | F16           |
 *   envelope and as an extra document                                |          |               |
 * | pdf whose signature cannot be evaluated (ByteRange missing, wrong | 22       | F21           |
 * |   length, out of range, overlapping; contents not CMS) is refused  |          |               |
 * |   like criterion 17, as a new envelope and as an extra document    |          |               |
 * | owner-restricted pdf whose counterparty signature (made after     | 17       | F16           |
 * |   protection) is tampered is refused [x3 ciphers]                  |          |               |
 * | pdf whose CMS signature value is corrupted (digest still matches)  | 26       | F23           |
 * |   is refused, new envelope and extra document [plain, AES-256]     |          |               |
 * | unencrypted signed pdf keeps a verifying signature in storage      | 6 (of 2) | F2            |
 * | ordinary pdf still uploads, as envelope and extra document         | 8        | F8            |
 * | password pdf refused with 400 on envelope create                   | 7        | F6            |
 * | password pdf refused with 400 on adding an extra document          | 7        | F6            |
 * | password pdf refused with 400 on the web upload endpoint           | 7        | F6            |
 *
 * Expected on main (red run): every owner-restricted test fails at upload
 * (F1), and the three password tests fail on the status or the error code
 * (F6). The unencrypted-signed and ordinary-PDF tests are controls and should
 * pass on main as well.
 *
 * "The stored file" is the envelope item's current document data, read from
 * the database as the existing counterparty-preservation spec does, and
 * judged by poppler pdfsig rather than by Sign.
 */
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';

import { apiCreateEnvelope, apiCreateTestContext, apiGetEnvelope } from '../../fixtures/api-seeds';
import { apiSignin } from '../../fixtures/authentication';
import {
  API_BASE_URL,
  assertVerifierToolsPresent,
  buildCorruptedSignatureValuePdf,
  buildMalformedSignaturePdf,
  buildOpenPasswordPdf,
  buildOwnerOnlyPdf,
  buildOwnerOnlyThenSignedPdf,
  buildOwnerOnlyThenSignedThenTamperedPdf,
  buildSignedPlainPdf,
  buildSignedThenOwnerOnlyPdf,
  expectCounterpartySignatureStillValid,
  expectFixtureCounterpartySignatureValid,
  MALFORMED_SIGNATURE_KINDS,
  type MalformedSignatureKind,
  OWNER_ONLY_ALGORITHMS,
  ordinaryPdf,
  readByteRange,
  readEncryptionWithPdfinfo,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
} from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

test.beforeAll(() => {
  assertVerifierToolsPresent();
});

const WEBAPP_BASE_URL = API_BASE_URL.replace(/\/api\/v2-beta$/, '');

const createEnvelopeRaw = async (request: APIRequestContext, token: string, file: Buffer, filename: string) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ type: 'DOCUMENT', title: filename }));
  formData.append('files', new File([file], filename, { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const addEnvelopeItemRaw = async (
  request: APIRequestContext,
  token: string,
  envelopeId: string,
  file: Buffer,
  filename: string,
) => {
  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  formData.append('files', new File([file], filename, { type: 'application/pdf' }));

  return await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const readStoredItemFile = async (envelopeItemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({
    where: { id: envelopeItemId },
    include: { documentData: true },
  });

  return new Uint8Array(await getFileServerSide(item.documentData));
};

/** Upload as a new envelope; returns the stored file of its only item. */
const uploadAsNewEnvelope = async (request: APIRequestContext, file: Buffer, filename: string) => {
  const { token } = await apiCreateTestContext('protected-pdf-upload');
  const res = await createEnvelopeRaw(request, token, file, filename);

  expect(res.status(), `envelope/create refused ${filename}: ${await res.text()}`).toBe(200);

  const { id } = (await res.json()) as { id: string };
  const envelope = await apiGetEnvelope(request, token, id);

  expect(envelope.envelopeItems).toHaveLength(1);

  return await readStoredItemFile(envelope.envelopeItems[0].id);
};

/** Add as a second document to an existing draft envelope; returns its stored file. */
const uploadAsExtraDocument = async (request: APIRequestContext, file: Buffer, filename: string) => {
  const { token } = await apiCreateTestContext('protected-pdf-extra-item');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Envelope with an extra document' });
  const before = await apiGetEnvelope(request, token, envelopeId);
  const existingIds = new Set(before.envelopeItems.map((item) => item.id));

  const res = await addEnvelopeItemRaw(request, token, envelopeId, file, filename);

  expect(res.status(), `envelope/item/create-many refused ${filename}: ${await res.text()}`).toBe(200);

  const after = await apiGetEnvelope(request, token, envelopeId);
  const added = after.envelopeItems.filter((item) => !existingIds.has(item.id));

  expect(added).toHaveLength(1);

  return await readStoredItemFile(added[0].id);
};

for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test.describe(`owner-restricted PDF, ${algorithm}`, () => {
    test(`owner_restricted_pdf_uploads_as_a_new_envelope (${algorithm})`, async ({ request }) => {
      const fixture = await buildOwnerOnlyPdf(algorithm);

      expect(readEncryptionWithPdfinfo(fixture).encrypted, 'fixture precondition: encrypted').toBe(true);
      expect(readEncryptionWithPdfinfo(fixture).openFails, 'fixture precondition: opens without a password').toBe(
        false,
      );

      await uploadAsNewEnvelope(request, fixture, `owner-${algorithm}.pdf`);
    });

    test(`owner_restricted_pdf_uploads_as_an_extra_document (${algorithm})`, async ({ request }) => {
      const fixture = await buildOwnerOnlyPdf(algorithm);

      await uploadAsExtraDocument(request, fixture, `owner-${algorithm}.pdf`);
    });

    test(`counterparty_signature_still_verifies_in_the_stored_file_of_a_new_envelope (${algorithm})`, async ({
      request,
    }) => {
      const fixture = await buildOwnerOnlyThenSignedPdf(algorithm);
      const original = expectFixtureCounterpartySignatureValid(fixture);

      const stored = await uploadAsNewEnvelope(request, fixture, `owner-${algorithm}-signed.pdf`);

      expectCounterpartySignatureStillValid(stored, original, 'stored file');
    });

    test(`counterparty_signature_still_verifies_in_the_stored_file_of_an_extra_document (${algorithm})`, async ({
      request,
    }) => {
      const fixture = await buildOwnerOnlyThenSignedPdf(algorithm);
      const original = expectFixtureCounterpartySignatureValid(fixture);

      const stored = await uploadAsExtraDocument(request, fixture, `owner-${algorithm}-signed.pdf`);

      expectCounterpartySignatureStillValid(stored, original, 'stored extra document');
    });
  });
}

/**
 * Criterion 17 (F16). Protection applied over a signature rewrites the file,
 * so the signature is already broken when the PDF arrives. Sign must refuse
 * it with 400, a code in data.code (the API v2 AppError shape), a message
 * that says the existing signature is already invalid without blaming Sign,
 * and nothing stored.
 */
const expectRefusedAsAlreadyBroken = async (res: Awaited<ReturnType<APIRequestContext['post']>>) => {
  const body = await res.json().catch(() => ({}));
  const message = String(body.message ?? '');

  expect(res.status(), JSON.stringify(body)).toBe(400);
  expect(typeof body.data?.code, `an error code is reported in data.code: ${JSON.stringify(body)}`).toBe('string');
  expect(body.data?.code, 'a refusal, not a generic server error').not.toBe('INTERNAL_SERVER_ERROR');
  expect(message, 'the message is about the existing signature').toMatch(/signature/i);
  expect(message, 'the message says the signature is already invalid').toMatch(
    /already|on arrival|before (it was )?upload/i,
  );
  expect(message, 'the message says the signature is invalid').toMatch(
    /invalid|broken|not valid|does not verify|fails? to verify|cannot be verified/i,
  );
  expect(message, 'the message does not claim Sign would invalidate it').not.toMatch(
    /would (be )?invalidat|storing it|by storing|sign would|we would/i,
  );
};

const expectBrokenSignatureFixture = (fixture: Buffer) => {
  const signatures = readSignaturesWithPdfsig(fixture);

  expect(readEncryptionWithPdfinfo(fixture).encrypted, 'fixture precondition: encrypted').toBe(true);
  expect(signatures, 'fixture precondition: one counterparty signature').toHaveLength(1);
  expect(signatures[0].validation, 'fixture precondition: pdfsig says it does not verify').not.toBe(SIGNATURE_VALID);
};

test('criterion_17_pdf_whose_signature_is_broken_on_arrival_is_refused_as_a_new_envelope', async ({ request }) => {
  const fixture = await buildSignedThenOwnerOnlyPdf();

  expectBrokenSignatureFixture(fixture);

  const { token, user, team } = await apiCreateTestContext('broken-signature-create');
  const res = await createEnvelopeRaw(request, token, fixture, 'signed-then-protected.pdf');

  await expectRefusedAsAlreadyBroken(res);

  expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'no envelope is stored').toBe(0);
  expect(
    await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
    'no document data is stored',
  ).toBe(0);
});

test('criterion_17_pdf_whose_signature_is_broken_on_arrival_is_refused_as_an_extra_document', async ({ request }) => {
  const fixture = await buildSignedThenOwnerOnlyPdf();

  expectBrokenSignatureFixture(fixture);

  const { token, user, team } = await apiCreateTestContext('broken-signature-item');
  const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Existing envelope' });
  const ownedBefore = await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } });

  const res = await addEnvelopeItemRaw(request, token, envelopeId, fixture, 'signed-then-protected.pdf');

  await expectRefusedAsAlreadyBroken(res);

  const envelope = await apiGetEnvelope(request, token, envelopeId);

  expect(envelope.envelopeItems, 'no document is added').toHaveLength(1);
  expect(
    await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
    'no document data is stored',
  ).toBe(ownedBefore);
});

/**
 * Criterion 22 (F21). A signature that cannot be evaluated counts as broken on
 * arrival. The fixtures are the counterparty-signed plain PDF edited in place
 * (see buildMalformedSignaturePdf); each still parses, and pdfsig cannot
 * verify its signature.
 */
const expectUnevaluableSignatureFixture = async (fixture: Buffer, kind: MalformedSignatureKind) => {
  const signatures = readSignaturesWithPdfsig(fixture);

  if (kind === 'contents-not-cms') {
    expect(
      readByteRange(fixture).signed.equals(readByteRange(await buildSignedPlainPdf()).signed),
      'fixture precondition: every byte the /ByteRange covers is unchanged from the valid signed file',
    ).toBe(true);
    expect(readByteRange(fixture).contentsHex, 'fixture precondition: only the /Contents was replaced').toMatch(
      /^(DEADBEEF)+/,
    );
  }

  expect(readEncryptionWithPdfinfo(fixture).encrypted, 'fixture precondition: not encrypted').toBe(false);
  expect(signatures, 'fixture precondition: pdfsig still sees the signature field').toHaveLength(1);
  expect(signatures[0].validation, 'fixture precondition: pdfsig cannot verify it').not.toBe(SIGNATURE_VALID);
};

for (const kind of MALFORMED_SIGNATURE_KINDS) {
  test(`criterion_22_pdf_with_an_unevaluable_signature_is_refused_as_a_new_envelope (${kind})`, async ({ request }) => {
    const fixture = await buildMalformedSignaturePdf(kind);

    await expectUnevaluableSignatureFixture(fixture, kind);

    const { token, user, team } = await apiCreateTestContext(`unevaluable-create-${kind}`);
    const res = await createEnvelopeRaw(request, token, fixture, `${kind}.pdf`);

    await expectRefusedAsAlreadyBroken(res);

    expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'no envelope is stored').toBe(0);
    expect(
      await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
      'no document data is stored',
    ).toBe(0);
  });

  test(`criterion_22_pdf_with_an_unevaluable_signature_is_refused_as_an_extra_document (${kind})`, async ({
    request,
  }) => {
    const fixture = await buildMalformedSignaturePdf(kind);

    await expectUnevaluableSignatureFixture(fixture, kind);

    const { token, user, team } = await apiCreateTestContext(`unevaluable-item-${kind}`);
    const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Existing envelope' });
    const ownedBefore = await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } });

    const res = await addEnvelopeItemRaw(request, token, envelopeId, fixture, `${kind}.pdf`);

    await expectRefusedAsAlreadyBroken(res);

    const envelope = await apiGetEnvelope(request, token, envelopeId);

    expect(envelope.envelopeItems, 'no document is added').toHaveLength(1);
    expect(
      await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
      'no document data is stored',
    ).toBe(ownedBefore);
  });
}

/**
 * Criterion 17 for a signature made after protection. The counterparty signs
 * the owner-restricted file, then one signed byte changes, so the signature
 * cannot verify. An encrypted file must not have its counterparty signature
 * skipped: it is refused as broken on arrival, under each cipher.
 */
for (const algorithm of OWNER_ONLY_ALGORITHMS) {
  test(`criterion_17_owner_restricted_pdf_whose_counterparty_signature_is_tampered_is_refused (${algorithm})`, async ({
    request,
  }) => {
    const fixture = await buildOwnerOnlyThenSignedThenTamperedPdf(algorithm);

    expectBrokenSignatureFixture(fixture);

    const { token, user, team } = await apiCreateTestContext(`tampered-${algorithm}`);
    const res = await createEnvelopeRaw(request, token, fixture, `tampered-${algorithm}.pdf`);

    await expectRefusedAsAlreadyBroken(res);

    expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'no envelope is stored').toBe(0);
    expect(
      await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
      'no document data is stored',
    ).toBe(0);
  });
}

/**
 * Criterion 26 (F23). The digest matches but the CMS signature value is
 * corrupted, so the signature does not cryptographically verify. pdfsig says
 * so ("Signature is Invalid.", not a digest mismatch), and every byte the
 * /ByteRange covers is unchanged from the valid signed file. Sign must refuse
 * it on arrival like criterion 17.
 */
const corruptedValueCases = [
  { label: 'plain', ownerOnly: undefined, valid: async () => await buildSignedPlainPdf() },
  { label: 'AES-256', ownerOnly: 'AES-256', valid: async () => await buildOwnerOnlyThenSignedPdf('AES-256') },
] as const;

const expectCorruptedValueFixture = async (fixture: Buffer, valid: Buffer) => {
  const signatures = readSignaturesWithPdfsig(fixture);

  expect(signatures, 'fixture precondition: one counterparty signature').toHaveLength(1);
  expect(signatures[0].validation, 'fixture precondition: pdfsig says the signature itself is invalid').toBe(
    'Signature is Invalid.',
  );
  expect(
    readByteRange(fixture).signed.equals(readByteRange(valid).signed),
    'fixture precondition: every byte the /ByteRange covers is unchanged',
  ).toBe(true);
  expect(fixture.length, 'fixture precondition: same length as the valid file').toBe(valid.length);
};

for (const { label, ownerOnly, valid } of corruptedValueCases) {
  test(`criterion_26_pdf_with_a_corrupted_cms_signature_value_is_refused_as_a_new_envelope (${label})`, async ({
    request,
  }) => {
    const fixture = await buildCorruptedSignatureValuePdf({ ownerOnly });

    await expectCorruptedValueFixture(fixture, await valid());

    const { token, user, team } = await apiCreateTestContext(`corrupted-value-create-${label}`);
    const res = await createEnvelopeRaw(request, token, fixture, `corrupted-value-${label}.pdf`);

    await expectRefusedAsAlreadyBroken(res);

    expect(await prisma.envelope.count({ where: { teamId: team.id } }), 'no envelope is stored').toBe(0);
    expect(
      await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
      'no document data is stored',
    ).toBe(0);
  });

  test(`criterion_26_pdf_with_a_corrupted_cms_signature_value_is_refused_as_an_extra_document (${label})`, async ({
    request,
  }) => {
    const fixture = await buildCorruptedSignatureValuePdf({ ownerOnly });

    await expectCorruptedValueFixture(fixture, await valid());

    const { token, user, team } = await apiCreateTestContext(`corrupted-value-item-${label}`);
    const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Existing envelope' });
    const ownedBefore = await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } });

    const res = await addEnvelopeItemRaw(request, token, envelopeId, fixture, `corrupted-value-${label}.pdf`);

    await expectRefusedAsAlreadyBroken(res);

    const envelope = await apiGetEnvelope(request, token, envelopeId);

    expect(envelope.envelopeItems, 'no document is added').toHaveLength(1);
    expect(
      await prisma.documentData.count({ where: { OR: [{ userId: user.id }, { teamId: team.id }] } }),
      'no document data is stored',
    ).toBe(ownedBefore);
  });
}

test('unencrypted_signed_pdf_keeps_a_verifying_counterparty_signature_in_storage', async ({ request }) => {
  const fixture = await buildSignedPlainPdf();
  const original = expectFixtureCounterpartySignatureValid(fixture);

  expect(readEncryptionWithPdfinfo(fixture).encrypted, 'fixture precondition: not encrypted').toBe(false);

  const storedAsEnvelope = await uploadAsNewEnvelope(request, fixture, 'signed-plain.pdf');
  expectCounterpartySignatureStillValid(storedAsEnvelope, original, 'stored file');

  const storedAsExtra = await uploadAsExtraDocument(request, fixture, 'signed-plain.pdf');
  expectCounterpartySignatureStillValid(storedAsExtra, original, 'stored extra document');
});

test('ordinary_pdf_still_uploads_as_an_envelope_and_as_an_extra_document', async ({ request }) => {
  await uploadAsNewEnvelope(request, ordinaryPdf(), 'ordinary.pdf');
  await uploadAsExtraDocument(request, ordinaryPdf(), 'ordinary.pdf');
});

test.describe('PDF that needs a password to open', () => {
  test('password_pdf_is_refused_with_400_password_protected_document_on_envelope_create', async ({ request }) => {
    const fixture = await buildOpenPasswordPdf();

    expect(readEncryptionWithPdfinfo(fixture).openFails, 'fixture precondition: needs a password').toBe(true);

    const { token, team } = await apiCreateTestContext('password-pdf-create');
    const res = await createEnvelopeRaw(request, token, fixture, 'password.pdf');
    const body = await res.json().catch(() => ({}));

    expect(res.status(), JSON.stringify(body)).toBe(400);
    expect(body.data?.code, JSON.stringify(body)).toBe('PASSWORD_PROTECTED_DOCUMENT');

    expect(await prisma.envelope.count({ where: { teamId: team.id } })).toBe(0);
  });

  test('password_pdf_is_refused_with_400_password_protected_document_on_adding_an_extra_document', async ({
    request,
  }) => {
    const fixture = await buildOpenPasswordPdf();
    const { token } = await apiCreateTestContext('password-pdf-item');
    const { id: envelopeId } = await apiCreateEnvelope(request, token, { title: 'Existing envelope' });

    const res = await addEnvelopeItemRaw(request, token, envelopeId, fixture, 'password.pdf');
    const body = await res.json().catch(() => ({}));

    expect(res.status(), JSON.stringify(body)).toBe(400);
    expect(body.data?.code, JSON.stringify(body)).toBe('PASSWORD_PROTECTED_DOCUMENT');

    const envelope = await apiGetEnvelope(request, token, envelopeId);

    expect(envelope.envelopeItems).toHaveLength(1);
  });

  test('password_pdf_is_refused_with_400_password_protected_document_on_the_web_upload_endpoint', async ({ page }) => {
    const fixture = await buildOpenPasswordPdf();
    const { user } = await apiCreateTestContext('password-pdf-web-upload');

    await apiSignin({ page, email: user.email });

    const { request } = page.context();

    const formData = new FormData();
    formData.append('file', new File([fixture], 'password.pdf', { type: 'application/pdf' }));

    const res = await request.post(`${WEBAPP_BASE_URL}/api/files/upload-pdf`, {
      multipart: formData,
    });
    const body = await res.json().catch(() => ({}));

    expect(res.status(), JSON.stringify(body)).toBe(400);
    expect(body.code).toBe('PASSWORD_PROTECTED_DOCUMENT');
  });
});
