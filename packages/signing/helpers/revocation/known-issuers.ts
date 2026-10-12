import { createHash } from 'node:crypto';

import { once } from 'remeda';

/**
 * Certificates the revocation check may use as the issuer of a certificate
 * whose own chain stops short of it, to verify that certificate's CRL. They are
 * not trust anchors and never exempt anything.
 *
 * USERTrust RSA Certification Authority issued the cross-signed copy of
 * Sectigo Public Time Stamping Root R46 that ends every Sectigo timestamp
 * token. That copy names a CRL but no caIssuers URL, so without this
 * certificate the CRL cannot be checked and a seal fails in strict mode.
 * Downloaded from http://crt.usertrust.com/USERTrustRSACertificationAuthority.crt
 * (serial 01FD6D30FCA3CA51A81BBC640E35032D, valid to 2038-01-18).
 */
const USERTRUST_RSA_CERTIFICATION_AUTHORITY_SHA256 = 'e793c9b02fd8aa13e21c31228accb08119643b749c898964b1746d46c3d4cbd2';

const USERTRUST_RSA_CERTIFICATION_AUTHORITY =
  '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' +
  'YvnKkKj9';

/**
 * Throw unless the DER hashes to the expected SHA-256. This catches an
 * accidental replacement or truncation of the embedded certificate, not
 * deliberate tampering, since both sit in this file.
 */
export const assertCertificateFingerprint = (der: Uint8Array, sha256Hex: string): void => {
  const actual = createHash('sha256').update(der).digest('hex');

  if (!sha256Hex || actual !== sha256Hex) {
    throw new Error(`Known issuer certificate does not match its fingerprint: expected ${sha256Hex}, got ${actual}`);
  }
};

const checkedCertificates = once((): Uint8Array[] => {
  const der = new Uint8Array(Buffer.from(USERTRUST_RSA_CERTIFICATION_AUTHORITY, 'base64'));

  assertCertificateFingerprint(der, USERTRUST_RSA_CERTIFICATION_AUTHORITY_SHA256);

  return [der];
});

/** Fresh copies, so that no caller can alter what later signing uses after the one fingerprint check. */
export const knownIssuerCertificates = (): Uint8Array[] => checkedCertificates().map((der) => der.slice());
