import { readFileSync } from 'node:fs';
import path from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

/**
 * The sealing pipeline in `seal-document.handler.ts` cannot be called directly
 * from a unit test: it needs prisma, the job queue and an envelope row. What it
 * does to the PDF is a short, fixed sequence, and that sequence is what decides
 * whether a counterparty's signature survives.
 *
 * These tests pin that sequence. If someone reintroduces the default flatten or
 * the full rewrite before signing, the handler will start destroying signatures
 * again and these tests are what should fail.
 */
const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));

const signer = async () =>
  await P12Signer.create(readFileSync(path.join(__dirname, '__fixtures__', 'signing-cert.p12')), '', {
    buildChain: false,
  });

const readSignatures = async (bytes: Uint8Array | Buffer) => {
  const doc = await PDF.load(bytes);
  const fields = doc.getForm()?.getSignatureFields() ?? [];

  return { total: fields.length, signed: fields.filter((field) => field.isSigned).length };
};

describe('counter-signing a document that arrived already signed', () => {
  it('keeps the original signature and adds ours alongside it', async () => {
    const input = fixture('externally-signed.pdf');

    const pdfDoc = await PDF.load(input);

    // The sequence the seal handler performs when it detects prior signatures.
    pdfDoc.flattenAll({ form: { skipSignatures: true } });
    pdfDoc.upgradeVersion('1.7');

    expect(pdfDoc.canSaveIncrementally()).toBeNull();

    const { bytes } = await pdfDoc.sign({
      signer: await signer(),
      reason: 'Counter-signature',
      subFilter: 'ETSI.CAdES.detached',
    });

    expect(await readSignatures(bytes)).toEqual({ total: 2, signed: 2 });
  });

  it('leaves every byte the original signature covers exactly where it was', async () => {
    const input = fixture('externally-signed.pdf');

    const pdfDoc = await PDF.load(input);
    pdfDoc.flattenAll({ form: { skipSignatures: true } });

    const { bytes } = await pdfDoc.sign({
      signer: await signer(),
      reason: 'Counter-signature',
      subFilter: 'ETSI.CAdES.detached',
    });

    const output = Buffer.from(bytes);

    expect(output.subarray(0, input.length).equals(input)).toBe(true);
  });

  it('loses the original signature if the form is flattened the default way', async () => {
    // The failure this whole change exists to prevent, pinned so the difference
    // between the two flatten modes stays visible.
    const input = fixture('externally-signed.pdf');

    const pdfDoc = await PDF.load(input);
    pdfDoc.flattenAll();

    const { bytes } = await pdfDoc.sign({
      signer: await signer(),
      reason: 'Counter-signature',
      subFilter: 'ETSI.CAdES.detached',
    });

    expect(await readSignatures(bytes)).toEqual({ total: 1, signed: 1 });
  });
});
