import fs from 'node:fs';
import path from 'node:path';

import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';
import type {
  TCreateEnvelopePayload,
  TCreateEnvelopeResponse,
} from '@documenso/trpc/server/envelope-router/create-envelope.types';
import { PDF } from '@libpdf/core';
import { type APIRequestContext, expect, test } from '@playwright/test';

/**
 * The defect this fork exists to fix, tested through the API rather than the
 * library.
 *
 * Stock Documenso normalises every upload by flattening the form and
 * re-serialising the file. Both destroy a signature applied by a counterparty
 * before the document reached us: the flatten empties the AcroForm so no reader
 * finds the signature, and the full rewrite moves every byte offset so the
 * /ByteRange no longer describes the file. Neither says anything. The document
 * arrives signed and is stored unsigned.
 *
 * `packages/lib/server-only/pdf/normalize-pdf.test.ts` already covers the
 * function. This covers the path a real upload takes: the v2 envelope create
 * endpoint, which calls `normalizePdf` at create-envelope.ts:123, through to
 * the bytes that end up in storage. A unit test passing while this fails would
 * mean the fix exists and the upload route no longer reaches it, which is
 * exactly the regression worth catching.
 */

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();
const baseUrl = `${WEBAPP_BASE_URL}/api/v2-beta`;

/**
 * Read from packages/lib rather than copied into packages/assets. One binary,
 * so the fixture the unit tests assert against and the fixture this asserts
 * against cannot drift apart.
 */
const PDF_FIXTURES = path.join(__dirname, '../../../lib/server-only/pdf/__fixtures__');

const signedPdf = fs.readFileSync(path.join(PDF_FIXTURES, 'externally-signed.pdf'));

/**
 * The control fixture carries four interactive form fields, because flattening
 * them is the observable proof that normalisation ran. `unsigned.pdf` next door
 * has no AcroForm at all, so asserting it comes back with no signatures would
 * hold just as well with normalisation deleted from the upload route, which is
 * a control that controls nothing.
 */
const formFieldsPdf = fs.readFileSync(path.join(__dirname, '../../../../assets/form-fields-test.pdf'));

/**
 * What a reader sees, rather than how the file was written.
 *
 * A signature survives only if the bytes it covers are unchanged *and* the
 * field is still listed in the AcroForm. It is possible to get one right and
 * the other wrong, and either alone loses the signature, so both are asserted.
 */
const countFormFields = async (bytes: Uint8Array) => {
  const doc = await PDF.load(new Uint8Array(bytes));

  return (await doc.getForm())?.fieldCount ?? 0;
};

const readSignatures = async (bytes: Uint8Array) => {
  const doc = await PDF.load(new Uint8Array(bytes));
  const fields = (await doc.getForm())?.getSignatureFields() ?? [];

  return {
    total: fields.length,
    signed: fields.filter((field) => field.isSigned).length,
  };
};

const uploadEnvelope = async (request: APIRequestContext, file: Buffer, filename: string) => {
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

  const res = await request.post(`${baseUrl}/envelope/create`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: formData,
  });

  expect(res.ok()).toBeTruthy();

  const response = (await res.json()) as TCreateEnvelopeResponse;

  const envelope = await prisma.envelope.findUniqueOrThrow({
    where: { id: response.id },
    include: { envelopeItems: { include: { documentData: true } } },
  });

  return await getFileServerSide(envelope.envelopeItems[0].documentData);
};

test.describe.configure({ mode: 'parallel' });

test.describe('Counterparty signature preservation', () => {
  test('keeps a signature applied before the document reached us', async ({ request }) => {
    expect(await readSignatures(signedPdf)).toEqual({ total: 1, signed: 1 });

    const stored = await uploadEnvelope(request, signedPdf, 'externally-signed.pdf');

    expect(await readSignatures(stored)).toEqual({ total: 1, signed: 1 });
  });

  test('leaves every byte the signature covers exactly where it was', async ({ request }) => {
    const stored = Buffer.from(await uploadEnvelope(request, signedPdf, 'externally-signed.pdf'));

    // An incremental save appends, so the file we received is a prefix of the
    // file we stored and the /ByteRange still describes it. Asserted on the
    // bytes rather than on the signature count, because a reader can list a
    // signature field that no longer verifies.
    expect(stored.length).toBeGreaterThanOrEqual(signedPdf.length);
    expect(stored.subarray(0, signedPdf.length).equals(signedPdf)).toBe(true);
  });

  test('still flattens a document that carries no signature', async ({ request }) => {
    // The control, and it has to fail if normalisation is removed rather than
    // merely pass when it is present. Otherwise the two tests above could be
    // satisfied by dropping normalisation altogether, which would preserve
    // every counterparty signature perfectly and break everything else.
    expect(await countFormFields(formFieldsPdf)).toBe(4);

    const stored = await uploadEnvelope(request, formFieldsPdf, 'form-fields-test.pdf');

    expect(await countFormFields(stored)).toBe(0);
    expect(await readSignatures(stored)).toEqual({ total: 0, signed: 0 });
  });
});
