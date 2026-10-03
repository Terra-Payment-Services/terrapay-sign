import { beforeAll, describe, expect, it } from 'vitest';

import { validateCrl } from './crl';
import { RevocationCheckError } from './errors';
import { buildCrl, createIdentity, createTestPki, type TestPki } from './test-support';

let pki: TestPki;

beforeAll(async () => {
  pki = await createTestPki();
});

const validate = async (crl: Uint8Array, now = new Date()) =>
  await validateCrl({
    crl,
    certificate: pki.leaf.certificate,
    issuer: pki.ca.certificate,
    now,
    clockSkewMs: 300_000,
  });

describe('validateCrl', () => {
  it('accepts a current CRL that does not list the certificate', async () => {
    const crl = await buildCrl({ issuer: pki.ca, revokedSerialNumbers: [4242] });

    await expect(validate(crl)).resolves.toEqual({ status: 'good' });
  });

  it('reports the certificate as revoked when its serial is listed', async () => {
    const revokedAt = new Date('2026-02-03T04:05:06Z');
    const crl = await buildCrl({ issuer: pki.ca, revokedSerialNumbers: [1001], revokedAt });

    await expect(validate(crl)).resolves.toEqual({ status: 'revoked', revokedAt });
  });

  it('refuses an HTML error page, which the library default would embed verbatim', async () => {
    const html = new TextEncoder().encode('<html><head><title>404 Not Found</title></head></html>');

    await expect(validate(html)).rejects.toThrow(RevocationCheckError);
    await expect(validate(html)).rejects.toThrow(/not a parseable CRL/);
  });

  it('refuses a CRL issued by a different authority', async () => {
    const crl = await buildCrl({ issuer: pki.otherCa });

    await expect(validate(crl)).rejects.toThrow(/issued by a different authority/);
  });

  it('refuses a CRL whose signature does not verify under the issuer key', async () => {
    const impostor = await createIdentity({
      commonName: 'Example Signing CA',
      serialNumber: 77,
      isCa: true,
    });

    const crl = await buildCrl({ issuer: impostor });

    await expect(validate(crl)).rejects.toThrow(/does not verify under the issuer key/);
  });

  it('refuses a CRL that is past its nextUpdate', async () => {
    const crl = await buildCrl({
      issuer: pki.ca,
      thisUpdate: new Date(Date.now() - 172_800_000),
      nextUpdate: new Date(Date.now() - 86_400_000),
    });

    await expect(validate(crl)).rejects.toThrow(/too stale to embed/);
  });

  it('refuses a CRL dated in the future', async () => {
    const crl = await buildCrl({
      issuer: pki.ca,
      thisUpdate: new Date(Date.now() + 86_400_000),
      nextUpdate: new Date(Date.now() + 172_800_000),
    });

    await expect(validate(crl)).rejects.toThrow(/dated in the future/);
  });

  it('refuses a CRL with no nextUpdate, whose freshness cannot be bounded', async () => {
    const crl = await buildCrl({ issuer: pki.ca, nextUpdate: null });

    await expect(validate(crl)).rejects.toThrow(/omits nextUpdate/);
  });
});
