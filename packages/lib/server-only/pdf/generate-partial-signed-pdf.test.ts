import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import { inspectEmbeddedSignatures } from '@documenso/signing/helpers/embedded-signatures';
import { PDF } from '@libpdf/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ownerProtectedSignedPdf } from './__fixtures__/protected-pdfs';
import { rawSignatureContents, signatureObjectNumber } from './__fixtures__/signature-bytes';
import { generatePartialSignedPdf } from './generate-partial-signed-pdf';

/**
 * The pending download burns in what the recipients have filled so far. A
 * document that arrived signed by a counterparty has to come out with that
 * signature still valid, or the preview shows a contract whose first signature
 * is broken.
 */
const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const insertedTextField = {
  id: 1,
  secondaryId: 'field-1',
  envelopeId: 'envelope-1',
  envelopeItemId: 'item-1',
  recipientId: 1,
  type: 'TEXT',
  page: 1,
  positionX: 10,
  positionY: 10,
  width: 20,
  height: 5,
  customText: 'Filled in so far',
  inserted: true,
  fieldMeta: null,
  signature: null,
} as unknown as FieldWithSignature;

const signedCount = async (bytes: Uint8Array) => {
  const doc = await PDF.load(bytes);

  return (doc.getForm()?.getSignatureFields() ?? []).filter((field) => field.isSigned()).length;
};

describe('generatePartialSignedPdf', () => {
  beforeAll(() => {
    // The overlay renderer loads its fonts from `public/fonts` under the working
    // directory, which in production is apps/remix.
    vi.spyOn(process, 'cwd').mockReturnValue(path.resolve(__dirname, '../../../../apps/remix'));
  });

  it.each([
    ['an unprotected', async () => fixture('externally-signed.pdf')],
    ['an owner-protected', ownerProtectedSignedPdf],
  ])('keeps the counterparty signature on %s document', async (_, received) => {
    const input = await received();
    const objectNumber = await signatureObjectNumber(input);

    const output = await generatePartialSignedPdf({ pdfData: input, fields: [insertedTextField] });

    expect(await signedCount(output)).toBe(1);
    expect(Buffer.from(output).subarray(0, input.length).equals(input)).toBe(true);
    expect(await inspectEmbeddedSignatures(output)).toMatchObject({ checked: 1, intact: 1 });
    expect(rawSignatureContents(output, objectNumber)).toBe(rawSignatureContents(input, objectNumber));
  });

  it('still produces a preview of a document nobody has signed', async () => {
    const output = await generatePartialSignedPdf({ pdfData: fixture('unsigned.pdf'), fields: [insertedTextField] });

    expect((await PDF.load(output)).getPageCount()).toBe(1);
  });
});
