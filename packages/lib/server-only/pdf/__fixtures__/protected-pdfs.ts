import { readFileSync } from 'node:fs';
import path from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';

/**
 * Protected PDFs built on demand from the committed fixtures, so the tests show
 * exactly how each one was made.
 *
 * "Owner-protected" is what Adobe and DocuSign commonly hand back: the file
 * opens without a password, but carries an owner password and permission
 * restrictions, and is therefore encrypted. "User-protected" needs a password
 * to open at all.
 */
const fixture = (name: string) => readFileSync(path.join(__dirname, name));

export const signer = async () => await P12Signer.create(fixture('signing-cert.p12'), '', { buildChain: false });

export const ownerProtectedPdf = async () => {
  const doc = await PDF.load(fixture('unsigned.pdf'));

  doc.setProtection({ ownerPassword: 'owner-only', permissions: { modify: false } });

  return Buffer.from(await doc.save());
};

/** Protected first and signed afterwards, which is the order a signing tool works in. */
export const ownerProtectedSignedPdf = async () => {
  const doc = await PDF.load(await ownerProtectedPdf());

  const { bytes } = await doc.sign({
    signer: await signer(),
    reason: 'Counterparty signature',
    subFilter: 'ETSI.CAdES.detached',
  });

  return Buffer.from(bytes);
};

export const userProtectedPdf = async () => {
  const doc = await PDF.load(fixture('unsigned.pdf'));

  doc.setProtection({ userPassword: 'open-sesame', ownerPassword: 'owner' });

  return Buffer.from(await doc.save());
};
