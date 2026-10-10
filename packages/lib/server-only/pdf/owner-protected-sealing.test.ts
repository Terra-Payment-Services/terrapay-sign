import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { ownerProtectedPdf, signer } from './__fixtures__/protected-pdfs';
import { assertLegacyEnvelopeAcceptsPdf, normalizePdf } from './normalize-pdf';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));

/**
 * An unsigned owner-protected upload stays encrypted. The V2 field path keeps
 * it that way. The V1 path goes through pdf-lib, which drops /Encrypt when it
 * decrypts, so a legacy envelope refuses such a file instead. Like
 * `counter-signature.test.ts`, these pin the PDF operations the handler
 * performs, since the handler itself needs prisma and the job queue.
 */
const readSignedCount = async (bytes: Uint8Array) => {
  const doc = await PDF.load(bytes);

  return (doc.getForm()?.getSignatureFields() ?? []).filter((field) => field.isSigned()).length;
};

describe('sealing an unsigned owner-protected document', () => {
  it('goes through the V2 path and comes out signed', async () => {
    const uploaded = await normalizePdf(await ownerProtectedPdf());

    const pdfDoc = await PDF.load(uploaded);
    pdfDoc.flattenAll({ form: { skipSignatures: false } });
    pdfDoc.upgradeVersion('1.7');

    const resaved = await PDF.load(await pdfDoc.save({ useXRefStream: true }));
    const { bytes } = await resaved.sign({ signer: await signer(), subFilter: 'ETSI.CAdES.detached' });

    expect(await readSignedCount(bytes)).toBe(1);
    expect((await PDF.load(bytes)).isEncrypted).toBe(true);
  });

  it('is refused for a legacy (V1) envelope, whose field path cannot keep the protection', async () => {
    const uploaded = await normalizePdf(await ownerProtectedPdf());

    await expect(assertLegacyEnvelopeAcceptsPdf(uploaded)).rejects.toMatchObject({
      code: 'ENVELOPE_LEGACY',
      message: expect.stringMatching(/V2 envelope/),
    });
  });

  it('is not refused for a legacy envelope when the PDF is unprotected', async () => {
    await expect(assertLegacyEnvelopeAcceptsPdf(await normalizePdf(fixture('unsigned.pdf')))).resolves.toBeUndefined();
  });
});
