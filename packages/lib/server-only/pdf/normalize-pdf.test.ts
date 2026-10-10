import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inspectEmbeddedSignatures } from '@documenso/signing/helpers/embedded-signatures';
import { PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { ownerProtectedPdf, ownerProtectedSignedPdf, userProtectedPdf } from './__fixtures__/protected-pdfs';
import { normalizePdf } from './normalize-pdf';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));

/**
 * The behaviour under test is what a reader sees when it opens the result, not
 * how the file was written. A signature survives only if both of these hold,
 * and it is possible to get one right and the other wrong:
 *
 *   - the bytes the signature is computed over are unchanged, and
 *   - the signature field is still listed in the AcroForm.
 *
 * So each assertion checks the signature is still *found and signed* after a
 * round trip, and separately that the signed bytes did not move.
 */
const readSignatures = async (pdf: Buffer) => {
  const doc = await PDF.load(pdf);
  const fields = doc.getForm()?.getSignatureFields() ?? [];

  return {
    total: fields.length,
    signed: fields.filter((field) => field.isSigned).length,
  };
};

describe('normalizePdf', () => {
  it('keeps a signature applied by someone else before we received the file', async () => {
    const input = fixture('externally-signed.pdf');

    expect(await readSignatures(input)).toEqual({ total: 1, signed: 1 });

    const output = await normalizePdf(input);

    expect(await readSignatures(output)).toEqual({ total: 1, signed: 1 });
  });

  it('leaves the signed bytes untouched so the existing signature still verifies', async () => {
    const input = fixture('externally-signed.pdf');

    const output = await normalizePdf(input);

    // An incremental save appends, so the original file is a prefix of the new
    // one and every byte the signature covers is still where it was.
    expect(output.subarray(0, input.length).equals(input)).toBe(true);
  });

  it('still flattens a document that carries no existing signature', async () => {
    const input = fixture('unsigned.pdf');

    const output = await normalizePdf(input);

    expect(output.length).toBeGreaterThan(0);
    expect(await readSignatures(output)).toEqual({ total: 0, signed: 0 });
  });

  it('destroys the signature only when the caller asks for that explicitly', async () => {
    const input = fixture('externally-signed.pdf');

    const output = await normalizePdf(input, { allowSignatureDestruction: true });

    expect(await readSignatures(output)).toEqual({ total: 0, signed: 0 });
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(normalizePdf(Buffer.from('this is not a pdf'))).rejects.toThrow();
  });

  it('accepts a PDF that opens without a password but carries owner restrictions', async () => {
    const output = await normalizePdf(await ownerProtectedPdf());

    const doc = await PDF.load(output);

    expect(doc.isAuthenticated).toBe(true);
    expect(doc.isEncrypted).toBe(true);
    expect(doc.getPageCount()).toBe(1);
  });

  it('keeps the signature on an owner-protected PDF that arrived already signed', async () => {
    const input = await ownerProtectedSignedPdf();

    const output = await normalizePdf(input);

    expect(await readSignatures(output)).toEqual({ total: 1, signed: 1 });
    expect(output.subarray(0, input.length).equals(input)).toBe(true);
    expect(await inspectEmbeddedSignatures(output)).toMatchObject({ checked: 1, intact: 1 });
  });

  it('refuses a PDF that needs a password to open, and says that is why', async () => {
    await expect(normalizePdf(await userProtectedPdf())).rejects.toMatchObject({
      code: 'PASSWORD_PROTECTED_DOCUMENT',
      message: expect.stringMatching(/password/i),
    });
  });
});
