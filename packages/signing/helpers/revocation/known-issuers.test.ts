import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { revocationProviderOptions } from '../../index';
import { assertCertificateFingerprint, knownIssuerCertificates } from './known-issuers';
import { createValidatingRevocationProvider } from './provider';
import { publicLookup } from './test-support';
import { extensionByOid, parseCertificate } from './x509';

/**
 * The bundled issuers are public certificates. The fixtures here were
 * downloaded from the CA and are checked in beside the tests so that the
 * bundled bytes are compared with an independent copy rather than with
 * themselves.
 */
const FIXTURES = path.join(__dirname, '__fixtures__');
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

const USERTRUST_SHA256 = 'e793c9b02fd8aa13e21c31228accb08119643b749c898964b1746d46c3d4cbd2';

const sha256Hex = (der: Uint8Array) => createHash('sha256').update(der).digest('hex');

describe('assertCertificateFingerprint', () => {
  const usertrust = fixture('usertrust-rsa-certification-authority.crt');

  it('has a fixture that is the certificate the specification names', () => {
    expect(sha256Hex(usertrust)).toBe(USERTRUST_SHA256);
  });

  it('accepts bytes that hash to the stated fingerprint', () => {
    expect(() => assertCertificateFingerprint(usertrust, USERTRUST_SHA256)).not.toThrow();
  });

  // F3
  it('rejects a certificate with one byte changed', () => {
    const changed = usertrust.slice();

    changed[changed.length - 1] ^= 0x01;

    expect(() => assertCertificateFingerprint(changed, USERTRUST_SHA256)).toThrow();
  });

  // F3
  it('rejects a truncated certificate', () => {
    expect(() => assertCertificateFingerprint(usertrust.slice(0, usertrust.length - 10), USERTRUST_SHA256)).toThrow();
  });

  // F3
  it('rejects a different certificate', () => {
    const r46 = fixture('sectigo-time-stamping-root-r46-cross.crt');

    expect(() => assertCertificateFingerprint(r46, USERTRUST_SHA256)).toThrow();
  });

  // F3
  it('rejects empty bytes and an empty fingerprint', () => {
    expect(() => assertCertificateFingerprint(new Uint8Array(), USERTRUST_SHA256)).toThrow();
    expect(() => assertCertificateFingerprint(usertrust, '')).toThrow();
  });
});

describe('knownIssuerCertificates', () => {
  it('bundles the USERTrust RSA Certification Authority root, byte for byte', () => {
    const bundled = knownIssuerCertificates();

    expect(bundled.map(sha256Hex)).toContain(USERTRUST_SHA256);
    expect(bundled).toContainEqual(fixture('usertrust-rsa-certification-authority.crt'));
  });

  it('bundles only certificates that parse and are self-signed CA roots', async () => {
    for (const der of knownIssuerCertificates()) {
      const certificate = parseCertificate(der, 'known issuer');
      const basicConstraints = extensionByOid(certificate, '2.5.29.19');

      expect(certificate.subject.isEqual(certificate.issuer)).toBe(true);
      expect((basicConstraints?.parsedValue as { cA?: boolean } | undefined)?.cA).toBe(true);
      await expect(certificate.verify(certificate)).resolves.toBe(true);
    }
  });

  // Spec: the bundled certificate cannot be altered by a caller. The
  // fingerprint is checked once, so a caller that edits what it was handed
  // must not change what later signings use.
  it('hands every caller its own copy, so a caller cannot alter the bundled certificate', () => {
    const first = knownIssuerCertificates();
    const original = first[0];
    const originalBytes = original.slice();

    try {
      first[0][0] ^= 0xff;
      first.push(new Uint8Array([1, 2, 3]));

      const second = knownIssuerCertificates();

      expect(second).toHaveLength(1);
      expect(sha256Hex(second[0])).toBe(USERTRUST_SHA256);

      first[0] = new Uint8Array([9]);

      expect(sha256Hex(knownIssuerCertificates()[0])).toBe(USERTRUST_SHA256);
    } finally {
      // Put back what this test altered, so that today's shared state does not
      // fail the tests that follow it. Harmless once each call returns a copy.
      original.set(originalBytes);
      first.splice(0, first.length, original);
    }
  });

  // F8: the bundled certificate, not just the fixture, verifies the real R46.
  it('verifies the real Sectigo R46 cross-certificate', async () => {
    const usertrust = knownIssuerCertificates().find((der) => sha256Hex(der) === USERTRUST_SHA256);

    expect(usertrust).toBeDefined();

    const issuer = parseCertificate(usertrust as Uint8Array, 'issuer');
    const r46 = parseCertificate(fixture('sectigo-time-stamping-root-r46-cross.crt'), 'subject');

    await expect(r46.verify(issuer)).resolves.toBe(true);
  });
});

describe('revocationProviderOptions', () => {
  // F5: signPdf builds its provider from these options.
  it('passes the bundled known issuers to the provider', () => {
    expect(revocationProviderOptions().knownIssuers).toEqual(knownIssuerCertificates());
  });

  // F5, F1, F6, F8 end to end without the network: the options signPdf uses,
  // with the transport and the clock injected, resolve the real R46.
  it('lets the provider signPdf creates check the real R46 against the real USERTrust CRL', async () => {
    const crl = fixture('usertrust-rsa-certification-authority.crl');
    const url = 'http://crl.usertrust.com/USERTrustRSACertificationAuthority.crl';

    const fetchFn = vi.fn((requested: string) =>
      requested === url
        ? Promise.resolve(new Response(crl.slice() as unknown as BodyInit))
        : Promise.reject(new Error(`unexpected request to ${requested}`)),
    );

    const provider = createValidatingRevocationProvider({
      ...revocationProviderOptions(),
      mode: 'strict',
      fetchFn: fetchFn as unknown as typeof fetch,
      lookup: publicLookup,
      now: () => new Date('2026-10-10T12:00:00Z'),
    });

    const returned = await provider.getCRL(fixture('sectigo-time-stamping-root-r46-cross.crt'));

    expect(returned).toEqual(crl);
    expect(provider.outcomes()).toMatchObject([{ status: 'good' }]);
    expect(() => provider.assertComplete()).not.toThrow();
  });
});
