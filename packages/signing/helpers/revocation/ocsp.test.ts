import { beforeAll, describe, expect, it } from 'vitest';

import { RevocationCheckError } from './errors';
import { buildOcspRequest, createNonce, validateOcspResponse } from './ocsp';
import { buildOcspResponse, createIdentity, createTestPki, type TestPki } from './test-support';

const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';

let pki: TestPki;

beforeAll(async () => {
  pki = await createTestPki();
});

const validate = async (response: Uint8Array, overrides: { now?: Date; nonce?: Uint8Array } = {}) =>
  await validateOcspResponse({
    response,
    certificate: pki.leaf.certificate,
    issuer: pki.ca.certificate,
    now: overrides.now ?? new Date(),
    clockSkewMs: 300_000,
    nonce: overrides.nonce,
  });

describe('buildOcspRequest', () => {
  it('produces a DER request naming the certificate serial', async () => {
    const request = await buildOcspRequest({ certificate: pki.leaf.certificate, issuer: pki.ca.certificate });

    expect(request.length).toBeGreaterThan(0);
    expect(request[0]).toBe(0x30);
  });

  it('carries the nonce it was given', async () => {
    const nonce = createNonce();

    const withNonce = await buildOcspRequest({
      certificate: pki.leaf.certificate,
      issuer: pki.ca.certificate,
      nonce,
    });

    const withoutNonce = await buildOcspRequest({
      certificate: pki.leaf.certificate,
      issuer: pki.ca.certificate,
    });

    expect(withNonce.length).toBeGreaterThan(withoutNonce.length);
    expect(Buffer.from(withNonce).includes(Buffer.from(nonce))).toBe(true);
  });
});

describe('validateOcspResponse', () => {
  describe('a response we should believe', () => {
    it('accepts one signed by the issuer itself', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.ca,
        includeResponderCertificate: false,
      });

      await expect(validate(response)).resolves.toEqual({ status: 'good' });
    });

    it('accepts one signed by a delegated responder carrying id-kp-OCSPSigning', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
      });

      await expect(validate(response)).resolves.toEqual({ status: 'good' });
    });

    it('accepts a matching nonce, and tolerates a responder that omits one', async () => {
      const nonce = createNonce();

      const echoed = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        nonce,
      });

      const silent = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
      });

      await expect(validate(echoed, { nonce })).resolves.toEqual({ status: 'good' });
      await expect(validate(silent, { nonce })).resolves.toEqual({ status: 'good' });
    });
  });

  describe('revocation', () => {
    it('reports a revoked certificate rather than treating it as evidence of validity', async () => {
      const revokedAt = new Date('2026-01-02T03:04:05Z');

      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'revoked',
        revokedAt,
      });

      await expect(validate(response)).resolves.toEqual({ status: 'revoked', revokedAt });
    });

    it('refuses a response whose status is unknown', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        status: 'unknown',
      });

      await expect(validate(response)).rejects.toThrow(/status as unknown/);
    });
  });

  describe('responder authority', () => {
    it('refuses a response signed by a certificate without the OCSP signing purpose', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.unauthorisedResponder,
      });

      await expect(validate(response)).rejects.toThrow(RevocationCheckError);
      await expect(validate(response)).rejects.toThrow(/id-kp-OCSPSigning/);
    });

    it('refuses a response signed by a responder from an unrelated CA', async () => {
      const stranger = await createIdentity({
        commonName: 'Stranger Responder',
        serialNumber: 9001,
        issuer: pki.otherCa,
        extendedKeyUsages: [OID_KP_OCSP_SIGNING],
      });

      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: stranger,
      });

      await expect(validate(response)).rejects.toThrow(/not issued by the certificate issuer/);
    });

    it('refuses a response whose responder certificate is not attached', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        includeResponderCertificate: false,
      });

      await expect(validate(response)).rejects.toThrow(/does not carry/);
    });

    it('refuses a response whose signature does not verify under the responder key', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        signingKey: pki.ca.privateKey,
      });

      await expect(validate(response)).rejects.toThrow(/does not verify under the responder key/);
    });

    it('refuses an expired responder certificate', async () => {
      const expired = await createIdentity({
        commonName: 'Expired Responder',
        serialNumber: 9002,
        issuer: pki.ca,
        extendedKeyUsages: [OID_KP_OCSP_SIGNING],
        notBefore: new Date(Date.now() - 172_800_000),
        notAfter: new Date(Date.now() - 86_400_000),
      });

      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: expired,
      });

      await expect(validate(response)).rejects.toThrow(/outside its validity period/);
    });
  });

  describe('CertID matching', () => {
    it('refuses a response about a different serial number', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        certIdSerialNumber: 4242,
      });

      await expect(validate(response)).rejects.toThrow(/contains no entry for serial/);
    });

    it('refuses a response whose CertID was built against a different issuer', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.otherCa.certificate,
        responder: pki.responder,
      });

      await expect(validate(response)).rejects.toThrow(/contains no entry for serial/);
    });
  });

  describe('freshness', () => {
    it('refuses a response that expired at nextUpdate', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        thisUpdate: new Date(Date.now() - 172_800_000),
        nextUpdate: new Date(Date.now() - 86_400_000),
      });

      await expect(validate(response)).rejects.toThrow(/too stale to embed/);
    });

    it('refuses a response dated in the future', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        thisUpdate: new Date(Date.now() + 86_400_000),
        nextUpdate: new Date(Date.now() + 172_800_000),
      });

      await expect(validate(response)).rejects.toThrow(/dated in the future/);
    });

    it('accepts a response inside the clock skew allowance', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        thisUpdate: new Date(Date.now() + 60_000),
        nextUpdate: new Date(Date.now() + 86_400_000),
      });

      await expect(validate(response)).resolves.toEqual({ status: 'good' });
    });
  });

  describe('malformed input', () => {
    it('refuses bytes that are not an OCSP response at all', async () => {
      const html = new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>');

      await expect(validate(html)).rejects.toThrow(RevocationCheckError);
    });

    it('refuses a responder that answered tryLater', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        responseStatus: 3,
      });

      await expect(validate(response)).rejects.toThrow(/tryLater/);
    });

    it('refuses a response whose nonce does not match the request', async () => {
      const response = await buildOcspResponse({
        certificate: pki.leaf.certificate,
        issuer: pki.ca.certificate,
        responder: pki.responder,
        nonce: createNonce(),
      });

      await expect(validate(response, { nonce: createNonce() })).rejects.toThrow(/nonce that does not match/);
    });
  });
});
