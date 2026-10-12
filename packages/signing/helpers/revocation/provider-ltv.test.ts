import { CryptoKeySigner, PDF, type PdfArray, type PdfDict, type PdfRef, type PdfStream } from '@libpdf/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createValidatingRevocationProvider } from './provider';
import { buildCrl, createCrossSignedRoot, createIdentity, publicLookup, type TestIdentity } from './test-support';

/**
 * Signs a real PDF with long term validation, with no network and no
 * timestamp authority, to see what reaches the document's /DSS.
 *
 * The signer's chain ends in a cross-signed root: a certificate that names a
 * CRL distribution point and an OCSP URL, carries no caIssuers, and is issued
 * by a root the chain does not contain. That is Sectigo R46 under USERTrust.
 */

const LEAF_CRL_URL = 'http://crl.cross.test/root.crl';
const KNOWN_CRL_URL = 'http://crl.known.test/known.crl';

let known: TestIdentity;
let cross: TestIdentity;
let leaf: TestIdentity;
let leafCrl: Uint8Array;
let crossCrl: Uint8Array;
let unsigned: Uint8Array;

beforeAll(async () => {
  known = await createIdentity({ commonName: 'Known Root', serialNumber: 5, isCa: true });

  ({ crossSigned: cross } = await createCrossSignedRoot({
    commonName: 'Cross Signed Root',
    issuer: known,
    crlUrl: KNOWN_CRL_URL,
    ocspUrl: 'http://ocsp.known.test/',
  }));

  leaf = await createIdentity({
    commonName: 'LTV Signer',
    serialNumber: 2001,
    issuer: cross,
    crlUrl: LEAF_CRL_URL,
    ocspUrl: 'http://ocsp.cross.test/',
  });

  leafCrl = await buildCrl({ issuer: cross });
  crossCrl = await buildCrl({ issuer: known });

  const pdf = PDF.create();
  pdf.addPage({ size: 'a4' });
  unsigned = await pdf.save();
});

const dssCrls = async (bytes: Uint8Array): Promise<Uint8Array[]> => {
  const pdf = await PDF.load(bytes);
  const resolve = (ref: PdfRef) => pdf.context.resolve(ref);
  const dss = pdf.getCatalog().get('DSS', resolve) as PdfDict;
  const array = dss.get('CRLs', resolve) as PdfArray;

  return [...array].map((ref) => (resolve(ref as PdfRef) as PdfStream).getDecodedData());
};

const serve = () =>
  vi.fn((url: string) => {
    if (url === LEAF_CRL_URL) {
      return Promise.resolve(new Response(leafCrl.slice() as unknown as BodyInit));
    }

    if (url === KNOWN_CRL_URL) {
      return Promise.resolve(new Response(crossCrl.slice() as unknown as BodyInit));
    }

    // Everything else, including both OCSP responders, is unavailable.
    return Promise.resolve(new Response('', { status: 404 }));
  });

const signWith = async (knownIssuers: Uint8Array[]) => {
  const provider = createValidatingRevocationProvider({
    mode: 'strict',
    fetchFn: serve() as unknown as typeof fetch,
    lookup: publicLookup,
    knownIssuers,
  });

  const signer = new CryptoKeySigner(leaf.privateKey, leaf.der, 'EC', 'ECDSA', [cross.der]);
  const doc = await PDF.load(unsigned);
  const { bytes } = await doc.sign({ signer, longTermValidation: true, revocationProvider: provider });

  return { bytes, provider };
};

describe('a signed PDF carries the CRLs the provider returned', () => {
  // F10: the library embeds what the provider returns. Passes on the unfixed
  // code for the leaf, whose issuer arrives in the signer's chain.
  it('puts the exact bytes of the signer CRL into the DSS', async () => {
    const { bytes } = await signWith([]);

    expect(await dssCrls(bytes)).toContainEqual(leafCrl);
  });

  // F10 and F1 together: the CRL for the cross-signed root, verified through a
  // known issuer, reaches the DSS byte for byte, and the signing completes.
  // The DSS is read before assertComplete so that a library regression and a
  // provider gap fail differently.
  it('puts the exact bytes of the cross-signed root CRL into the DSS', async () => {
    const { bytes, provider } = await signWith([known.der]);

    const embedded = await dssCrls(bytes);

    expect(embedded).toContainEqual(leafCrl);
    expect(embedded).toContainEqual(crossCrl);
    expect(() => provider.assertComplete({ expectChecks: true })).not.toThrow();
  });
});
