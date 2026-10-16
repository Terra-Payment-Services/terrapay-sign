import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, FieldType } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { PDF } from '@libpdf/core';
import { type APIRequestContext, expect, test } from '@playwright/test';

import {
  buildLargeSignedPdf,
  buildSmallSignedPdf,
  tamperCoveredByte,
} from '../../../lib/server-only/pdf/__fixtures__/large-signature';
import { apiSeedPendingDocument } from '../fixtures/api-seeds';
import {
  COUNTERPARTY_FIELD_NAME,
  downloadEnvelopeItem,
  expectFixtureCounterpartySignatureValid,
  readSignaturesWithPdfsig,
  SIGNATURE_VALID,
  signAndCompleteAsRecipient,
} from '../fixtures/protected-pdfs';

/**
 * Through the upload route: a counterparty signature whose CMS needs more
 * than 10,000 ASN.1 nodes, as PandaDoc, DocuSign and Adobe LTV signatures do.
 *
 * Sign checks every signature a PDF arrives with before accepting it. A user
 * could not upload an NDA signed through PandaDoc because the check could not
 * parse a CMS that large, found no message digest, and refused the file with
 * SIGNATURE_ALREADY_INVALID although its signature was intact.
 *
 * Criteria covered here, through POST /api/v2-beta/envelope/create:
 * 1. A PDF with one intact large signature is accepted, and what is stored
 *    still carries it: the field is still signed, the received bytes are a
 *    prefix of the stored ones, and poppler verifies the stored file.
 * 2. The same large signature over bytes altered after signing is refused
 *    with SIGNATURE_ALREADY_INVALID.
 * 4. A small signature made the same way is accepted and kept, and a small one
 *    over altered bytes is refused, exactly as before (regression guard).
 * Preservation also covers sealing: a large-signature upload sent to a Sign
 * recipient, signed and completed, yields a sealed PDF in which poppler still
 * verifies the counterparty's original signature as well as Sign's own.
 * Criterion 3, the upper bound on the parse, is in
 * packages/signing/helpers/embedded-signatures-large-cms.test.ts.
 *
 * The fixtures are built at run time by
 * packages/lib/server-only/pdf/__fixtures__/large-signature.ts, which states
 * how and how many nodes each needs. Poppler `pdfsig` is the oracle for
 * whether a signature verifies, never Sign's own check. Requires openssl and
 * poppler-utils on PATH.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const baseUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;

const SIGNATURE_ALREADY_INVALID = 'SIGNATURE_ALREADY_INVALID';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-signature-upload-60-'));

const pdfsigValidation = (bytes: Uint8Array) => {
  const file = path.join(workDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

  fs.writeFileSync(file, bytes);

  const result = spawnSync('pdfsig', [file], { encoding: 'utf8' });

  if (result.error) {
    throw new Error('pdfsig is not on PATH (apt-get install poppler-utils; brew install poppler)');
  }

  return /- Signature Validation: (.*)$/m.exec(result.stdout)?.[1]?.trim() ?? '';
};

const readSignatures = async (bytes: Uint8Array) => {
  const doc = await PDF.load(new Uint8Array(bytes));
  const fields = (await doc.getForm())?.getSignatureFields() ?? [];

  return {
    total: fields.length,
    signed: fields.filter((field) => field.isSigned()).length,
  };
};

const postEnvelope = async (request: APIRequestContext, file: Buffer, filename: string) => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({
    userId: user.id,
    teamId: team.id,
    tokenName: 'test',
    expiresIn: null,
  });

  const payload: TCreateEnvelopePayload = {
    type: EnvelopeType.DOCUMENT,
    title: filename,
  };

  const formData = new FormData();

  formData.append('payload', JSON.stringify(payload));
  formData.append('files', new File([file], filename, { type: 'application/pdf' }));

  return await request.post(`${baseUrl}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });
};

const uploadAndReadStored = async (request: APIRequestContext, file: Buffer, filename: string) => {
  const res = await postEnvelope(request, file, filename);

  expect(res.status(), `envelope/create refused ${filename}: ${await res.text()}`).toBe(200);

  const response = (await res.json()) as TCreateEnvelopeResponse;

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: response.id },
    include: { envelopeItems: { include: { documentData: true } } },
  });

  return Buffer.from(await getFileServerSide(envelope.envelopeItems[0].documentData));
};

const expectRefusedAsAlreadyInvalid = async (request: APIRequestContext, file: Buffer, filename: string) => {
  const res = await postEnvelope(request, file, filename);
  const text = await res.text();
  const body = (() => {
    try {
      return JSON.parse(text) as { data?: { code?: string } };
    } catch {
      return {};
    }
  })();

  expect(res.status(), text).toBe(400);
  expect(body.data?.code, text).toBe(SIGNATURE_ALREADY_INVALID);
};

const expectSignatureKept = async (received: Buffer, stored: Buffer) => {
  expect(await readSignatures(stored), 'the signed field is still signed').toEqual({ total: 1, signed: 1 });
  expect(stored.length).toBeGreaterThanOrEqual(received.length);
  expect(stored.subarray(0, received.length).equals(received), 'the received file is a prefix of the stored one').toBe(
    true,
  );
  expect(pdfsigValidation(stored), 'poppler verifies the stored file').toBe('Signature is Valid.');
};

test.describe.configure({ mode: 'parallel' });

test.describe('Signatures that need more than 10,000 ASN.1 nodes', () => {
  test('criterion 1: an intact large signature is accepted and kept in what is stored', async ({ request }) => {
    const large = await buildLargeSignedPdf();

    expect(pdfsigValidation(large), 'fixture precondition: poppler verifies it').toBe('Signature is Valid.');

    const stored = await uploadAndReadStored(request, large, 'large-signature.pdf');

    await expectSignatureKept(large, stored);
  });

  test('criterion 2: a large signature over bytes altered after signing is refused', async ({ request }) => {
    const tampered = tamperCoveredByte(await buildLargeSignedPdf());

    expect(pdfsigValidation(tampered), 'fixture precondition: poppler finds it broken').toBe('Digest Mismatch.');

    await expectRefusedAsAlreadyInvalid(request, tampered, 'large-signature-tampered.pdf');
  });

  test('criterion 4: an intact small signature is accepted and kept, as before', async ({ request }) => {
    const small = await buildSmallSignedPdf();

    expect(pdfsigValidation(small), 'fixture precondition: poppler verifies it').toBe('Signature is Valid.');

    const stored = await uploadAndReadStored(request, small, 'small-signature.pdf');

    await expectSignatureKept(small, stored);
  });

  test('criterion 4: a small signature over altered bytes is refused, as before', async ({ request }) => {
    const tampered = tamperCoveredByte(await buildSmallSignedPdf());

    expect(pdfsigValidation(tampered), 'fixture precondition: poppler finds it broken').toBe('Digest Mismatch.');

    await expectRefusedAsAlreadyInvalid(request, tampered, 'small-signature-tampered.pdf');
  });

  test('criterion 1, sealed: a large signature still verifies in the completed PDF', async ({ request }) => {
    test.setTimeout(120_000);

    const large = await buildLargeSignedPdf();
    const original = expectFixtureCounterpartySignatureValid(large);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { envelope, token, distributeResult } = await apiSeedPendingDocument(request, {
      title: 'large-signature-sealed',
      pdfFile: { name: 'large-signature-sealed.pdf', data: large },
      recipients: [{ email: `large-signature-signer-${stamp}@test.documenso.com`, name: 'Signer' }],
      fieldsPerRecipient: [
        [{ type: FieldType.SIGNATURE, page: 1, positionX: 10, positionY: 60, width: 25, height: 8 }],
      ],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id && f.type === FieldType.SIGNATURE);

    expect(field, 'the recipient has a signature field').toBeTruthy();

    await signAndCompleteAsRecipient({
      request,
      recipientToken: recipient.token,
      documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
      fieldId: field?.id ?? -1,
    });

    await expect(async () => {
      const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });

      expect(current.status).toBe(DocumentStatus.COMPLETED);
    }).toPass({ timeout: 45_000 });

    const sealed = await downloadEnvelopeItem(request, token, envelope.envelopeItems[0].id, 'signed');
    const signatures = readSignaturesWithPdfsig(sealed);
    const counterparty = signatures.find((s) => s.fieldName === COUNTERPARTY_FIELD_NAME);

    expect(
      counterparty,
      `the counterparty signature is in the sealed PDF (pdfsig saw ${signatures.length})`,
    ).toBeTruthy();
    expect(counterparty?.signingTime, 'it is the original signature').toBe(original.signingTime);
    expect(counterparty?.validation, 'poppler verifies it in the sealed PDF').toBe(SIGNATURE_VALID);
    expect(
      signatures.filter((s) => s.fieldName !== COUNTERPARTY_FIELD_NAME).length,
      "Sign's own signature is present",
    ).toBeGreaterThanOrEqual(1);

    for (const signature of signatures) {
      expect(signature.validation, `poppler verifies signature #${signature.index} (${signature.fieldName})`).toBe(
        SIGNATURE_VALID,
      );
    }
  });
});
