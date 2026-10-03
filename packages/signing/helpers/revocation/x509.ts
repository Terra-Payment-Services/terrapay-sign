import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { RevocationCheckError } from './errors';

/** Small shared X.509 helpers used by both the OCSP and the CRL checks. */

/** id-ce-extKeyUsage */
export const OID_EXT_KEY_USAGE = '2.5.29.37';

/** id-kp-OCSPSigning: the only thing that makes a delegated responder legitimate. */
export const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';

/** id-pe-authorityInfoAccess */
export const OID_AUTHORITY_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';

/** id-ad-ocsp, the access method naming a responder inside AIA. */
export const OID_AD_OCSP = '1.3.6.1.5.5.7.48.1';

/** id-ce-cRLDistributionPoints */
export const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';

/** Digest OIDs a CertID or a signature may name, mapped to WebCrypto names. */
export const DIGEST_NAMES_BY_OID: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * Parse a DER certificate.
 *
 * @throws {RevocationCheckError} when the bytes are not a certificate.
 */
export const parseCertificate = (der: Uint8Array, label: string): pkijs.Certificate => {
  try {
    return pkijs.Certificate.fromBER(toArrayBuffer(der));
  } catch (error) {
    throw new RevocationCheckError(
      `Could not parse the ${label} certificate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** A human readable subject, for error messages and operator logs. */
export const describeSubject = (certificate: pkijs.Certificate): string => {
  const parts = certificate.subject.typesAndValues.map((entry) => {
    const value: unknown = entry.value.valueBlock.value;

    return typeof value === 'string' ? value : '';
  });

  const description = parts.filter(Boolean).join(', ');

  return description || '(no subject)';
};

export const serialNumberHex = (certificate: pkijs.Certificate): string =>
  bytesToHex(new Uint8Array(certificate.serialNumber.valueBlock.valueHexView));

/** The raw public key bits, which is what an OCSP issuerKeyHash is taken over. */
export const publicKeyBits = (certificate: pkijs.Certificate): Uint8Array =>
  new Uint8Array(certificate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);

export const encodedSubject = (certificate: pkijs.Certificate): Uint8Array =>
  new Uint8Array(certificate.subject.toSchema().toBER(false));

/** Two certificates are the same entity when the name and the key both match. */
export const isSameCertificate = (left: pkijs.Certificate, right: pkijs.Certificate): boolean =>
  left.subject.isEqual(right.subject) && equalBytes(publicKeyBits(left), publicKeyBits(right));

export const isSelfIssued = (certificate: pkijs.Certificate): boolean =>
  certificate.subject.isEqual(certificate.issuer);

export const extensionByOid = (certificate: pkijs.Certificate, oid: string): pkijs.Extension | undefined =>
  certificate.extensions?.find((extension) => extension.extnID === oid);

/** Extended key usage purposes, or an empty list when the extension is absent. */
export const extendedKeyUsages = (certificate: pkijs.Certificate): string[] => {
  const extension = extensionByOid(certificate, OID_EXT_KEY_USAGE);

  if (!extension) {
    return [];
  }

  try {
    const parsed = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

    if (parsed.offset === -1) {
      return [];
    }

    return new pkijs.ExtKeyUsage({ schema: parsed.result }).keyPurposes;
  } catch {
    return [];
  }
};

/** URLs listed under one accessMethod of the Authority Information Access extension. */
export const authorityInfoAccessUrls = (certificate: pkijs.Certificate, accessMethod: string): string[] => {
  const extension = extensionByOid(certificate, OID_AUTHORITY_INFO_ACCESS);

  if (!extension) {
    return [];
  }

  try {
    const parsed = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

    if (parsed.offset === -1) {
      return [];
    }

    const infoAccess = new pkijs.InfoAccess({ schema: parsed.result });

    return infoAccess.accessDescriptions
      .filter((description) => description.accessMethod === accessMethod)
      .map((description) => description.accessLocation)
      .filter((location) => location.type === 6 && typeof location.value === 'string')
      .map((location): string => location.value);
  } catch {
    return [];
  }
};

/** http(s) distribution point URLs from the CRL Distribution Points extension. */
export const crlDistributionPointUrls = (certificate: pkijs.Certificate): string[] => {
  const extension = extensionByOid(certificate, OID_CRL_DISTRIBUTION_POINTS);

  if (!extension) {
    return [];
  }

  try {
    const parsed = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

    if (parsed.offset === -1) {
      return [];
    }

    const points = new pkijs.CRLDistributionPoints({ schema: parsed.result });
    const urls: string[] = [];

    for (const point of points.distributionPoints) {
      const names = point.distributionPoint;

      if (!Array.isArray(names)) {
        continue;
      }

      for (const name of names) {
        if (name.type === 6 && typeof name.value === 'string') {
          urls.push(name.value);
        }
      }
    }

    return urls;
  } catch {
    return [];
  }
};

/** Digest `data` with the algorithm the given OID names. */
export const digestByOid = async (oid: string, data: Uint8Array): Promise<Uint8Array> => {
  const name = DIGEST_NAMES_BY_OID[oid];

  if (!name) {
    throw new RevocationCheckError(`Unsupported digest algorithm ${oid} in revocation data`);
  }

  const crypto = pkijs.getCrypto(true);

  return new Uint8Array(await crypto.digest({ name }, toArrayBuffer(data)));
};

/** Is `at` inside the certificate's validity window, give or take the skew? */
export const isWithinValidity = (certificate: pkijs.Certificate, at: Date, clockSkewMs: number): boolean =>
  certificate.notBefore.value.getTime() - clockSkewMs <= at.getTime() &&
  certificate.notAfter.value.getTime() + clockSkewMs >= at.getTime();
