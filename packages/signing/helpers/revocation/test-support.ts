import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/**
 * Test-only PKI builders.
 *
 * Everything the revocation tests need is generated here with pkijs rather
 * than checked in as OpenSSL output: a small CA, an end entity, a delegated
 * OCSP responder, an unauthorised one, and the OCSP responses and CRLs those
 * keys sign. Building the DER in the test means a test can say "a response
 * whose CertID names a different serial" and have that be one argument rather
 * than an opaque fixture file. Not part of the shipped surface of this package.
 *
 * Keys are ECDSA P-256 because generating a handful of RSA keys per test file
 * is slow enough to be felt.
 */

const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_AUTHORITY_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';
const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';
const OID_AD_OCSP = '1.3.6.1.5.5.7.48.1';
const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_BASIC_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.1';
const OID_OCSP_NONCE = '1.3.6.1.5.5.7.48.1.2';

const engine = () => pkijs.getCrypto(true);

export type TestIdentity = {
  certificate: pkijs.Certificate;
  der: Uint8Array;
  privateKey: CryptoKey;
};

export type CreateCertificateOptions = {
  commonName: string;
  serialNumber: number;
  /** Omit for a self-signed certificate. */
  issuer?: TestIdentity;
  isCa?: boolean;
  extendedKeyUsages?: string[];
  ocspUrl?: string;
  crlUrl?: string;
  notBefore?: Date;
  notAfter?: Date;
};

const name = (commonName: string): pkijs.RelativeDistinguishedNames =>
  new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: OID_COMMON_NAME,
        value: new asn1js.PrintableString({ value: commonName }),
      }),
    ],
  });

const extension = (extnID: string, value: asn1js.AsnType, critical = false): pkijs.Extension =>
  new pkijs.Extension({ extnID, critical, extnValue: value.toBER(false) });

export const createIdentity = async ({
  commonName,
  serialNumber,
  issuer,
  isCa = false,
  extendedKeyUsages = [],
  ocspUrl,
  crlUrl,
  notBefore = new Date(Date.now() - 86_400_000),
  notAfter = new Date(Date.now() + 86_400_000),
}: CreateCertificateOptions): Promise<TestIdentity> => {
  const crypto = engine();
  const keys = await crypto.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: serialNumber });
  certificate.subject = name(commonName);
  certificate.issuer = issuer ? issuer.certificate.subject : name(commonName);
  certificate.notBefore.value = notBefore;
  certificate.notAfter.value = notAfter;
  certificate.extensions = [];

  if (isCa) {
    certificate.extensions.push(
      extension(OID_BASIC_CONSTRAINTS, new pkijs.BasicConstraints({ cA: true }).toSchema(), true),
    );
  }

  if (extendedKeyUsages.length > 0) {
    certificate.extensions.push(
      extension(OID_EXT_KEY_USAGE, new pkijs.ExtKeyUsage({ keyPurposes: extendedKeyUsages }).toSchema()),
    );
  }

  if (ocspUrl) {
    certificate.extensions.push(
      extension(
        OID_AUTHORITY_INFO_ACCESS,
        new pkijs.InfoAccess({
          accessDescriptions: [
            new pkijs.AccessDescription({
              accessMethod: OID_AD_OCSP,
              accessLocation: new pkijs.GeneralName({ type: 6, value: ocspUrl }),
            }),
          ],
        }).toSchema(),
      ),
    );
  }

  if (crlUrl) {
    certificate.extensions.push(
      extension(
        OID_CRL_DISTRIBUTION_POINTS,
        new pkijs.CRLDistributionPoints({
          distributionPoints: [
            new pkijs.DistributionPoint({
              distributionPoint: [new pkijs.GeneralName({ type: 6, value: crlUrl })],
            }),
          ],
        }).toSchema(),
      ),
    );
  }

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey, crypto);
  await certificate.sign(issuer ? issuer.privateKey : keys.privateKey, 'SHA-256', crypto);

  const der = new Uint8Array(certificate.toSchema(true).toBER(false));

  return { certificate: pkijs.Certificate.fromBER(der), der, privateKey: keys.privateKey };
};

export type TestPki = {
  /** Self-signed root, issuer of everything else. */
  ca: TestIdentity;
  /** End entity with both an OCSP responder and a CRL distribution point. */
  leaf: TestIdentity;
  /** Responder the CA delegated to, carrying id-kp-OCSPSigning. */
  responder: TestIdentity;
  /** Issued by the same CA but without the OCSP signing purpose. */
  unauthorisedResponder: TestIdentity;
  /** A second CA, for responses signed by a stranger. */
  otherCa: TestIdentity;
  ocspUrl: string;
  crlUrl: string;
};

export const createTestPki = async ({
  ocspUrl = 'http://ocsp.example.test/',
  crlUrl = 'http://crl.example.test/ca.crl',
} = {}): Promise<TestPki> => {
  const ca = await createIdentity({ commonName: 'Example Signing CA', serialNumber: 1, isCa: true });

  const [leaf, responder, unauthorisedResponder, otherCa] = await Promise.all([
    createIdentity({ commonName: 'Example Signer', serialNumber: 1001, issuer: ca, ocspUrl, crlUrl }),
    createIdentity({
      commonName: 'Example OCSP Responder',
      serialNumber: 1002,
      issuer: ca,
      extendedKeyUsages: [OID_KP_OCSP_SIGNING],
    }),
    createIdentity({ commonName: 'Example Web Server', serialNumber: 1003, issuer: ca }),
    createIdentity({ commonName: 'Unrelated CA', serialNumber: 2, isCa: true }),
  ]);

  return { ca, leaf, responder, unauthorisedResponder, otherCa, ocspUrl, crlUrl };
};

export type BuildOcspResponseOptions = {
  /** The certificate the response is about. */
  certificate: pkijs.Certificate;
  /** The issuer whose name and key the CertID is built from. */
  issuer: pkijs.Certificate;
  /** Whoever signs the response. */
  responder: TestIdentity;
  /** Attach the responder certificate to the response. @default true */
  includeResponderCertificate?: boolean;
  status?: 'good' | 'revoked' | 'unknown';
  revokedAt?: Date;
  thisUpdate?: Date;
  nextUpdate?: Date | null;
  /** Overrides the serial in the CertID, to build a response about something else. */
  certIdSerialNumber?: number;
  /** Echoed back in a nonce extension. */
  nonce?: Uint8Array;
  /** Response status other than successful, for the error paths. */
  responseStatus?: number;
  /** Signs with this key instead of the responder's, to forge a bad signature. */
  signingKey?: CryptoKey;
};

const certStatusBlock = (status: 'good' | 'revoked' | 'unknown', revokedAt: Date): asn1js.AsnType => {
  if (status === 'good') {
    return new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } });
  }

  if (status === 'unknown') {
    return new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 2 } });
  }

  return new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber: 1 },
    value: [new asn1js.GeneralizedTime({ valueDate: revokedAt })],
  });
};

export const buildOcspResponse = async ({
  certificate,
  issuer,
  responder,
  includeResponderCertificate = true,
  status = 'good',
  revokedAt = new Date(Date.now() - 3_600_000),
  thisUpdate = new Date(Date.now() - 60_000),
  nextUpdate = new Date(Date.now() + 86_400_000),
  certIdSerialNumber,
  nonce,
  responseStatus = 0,
  signingKey,
}: BuildOcspResponseOptions): Promise<Uint8Array> => {
  const crypto = engine();
  const response = new pkijs.OCSPResponse();

  response.responseStatus = new asn1js.Enumerated({ value: responseStatus });

  if (responseStatus !== 0) {
    return new Uint8Array(response.toSchema().toBER(false));
  }

  const certID = await pkijs.CertID.create(certificate, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer }, crypto);

  if (certIdSerialNumber !== undefined) {
    certID.serialNumber = new asn1js.Integer({ value: certIdSerialNumber });
  }

  const single = new pkijs.SingleResponse({ certID });
  single.certStatus = certStatusBlock(status, revokedAt);
  single.thisUpdate = thisUpdate;

  if (nextUpdate) {
    single.nextUpdate = nextUpdate;
  }

  const basic = new pkijs.BasicOCSPResponse();
  basic.tbsResponseData.responderID = responder.certificate.subject;
  basic.tbsResponseData.producedAt = thisUpdate;
  basic.tbsResponseData.responses = [single];

  if (nonce) {
    basic.tbsResponseData.responseExtensions = [
      new pkijs.Extension({
        extnID: OID_OCSP_NONCE,
        critical: false,
        extnValue: new asn1js.OctetString({ valueHex: nonce.slice().buffer as ArrayBuffer }).toBER(false),
      }),
    ];
  }

  if (includeResponderCertificate) {
    basic.certs = [responder.certificate];
  }

  await basic.sign(signingKey ?? responder.privateKey, 'SHA-256', crypto);

  response.responseBytes = new pkijs.ResponseBytes({
    responseType: OID_BASIC_OCSP_RESPONSE,
    response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER(false) }),
  });

  return new Uint8Array(response.toSchema().toBER(false));
};

export type BuildCrlOptions = {
  issuer: TestIdentity;
  revokedSerialNumbers?: number[];
  revokedAt?: Date;
  thisUpdate?: Date;
  nextUpdate?: Date | null;
};

export const buildCrl = async ({
  issuer,
  revokedSerialNumbers = [],
  revokedAt = new Date(Date.now() - 3_600_000),
  thisUpdate = new Date(Date.now() - 60_000),
  nextUpdate = new Date(Date.now() + 86_400_000),
}: BuildCrlOptions): Promise<Uint8Array> => {
  const crl = new pkijs.CertificateRevocationList();

  crl.version = 1;
  crl.issuer = issuer.certificate.subject;
  crl.thisUpdate = new pkijs.Time({ type: 0, value: thisUpdate });

  if (nextUpdate) {
    crl.nextUpdate = new pkijs.Time({ type: 0, value: nextUpdate });
  }

  if (revokedSerialNumbers.length > 0) {
    crl.revokedCertificates = revokedSerialNumbers.map(
      (serialNumber) =>
        new pkijs.RevokedCertificate({
          userCertificate: new asn1js.Integer({ value: serialNumber }),
          revocationDate: new pkijs.Time({ type: 0, value: revokedAt }),
        }),
    );
  }

  await crl.sign(issuer.privateKey, 'SHA-256', engine());

  return new Uint8Array(crl.toSchema(true).toBER(false));
};

/** A lookup that answers every hostname with one address. */
export const fixedLookup =
  (address: string) =>
  async (_hostname: string): Promise<string[]> => [address];

/**
 * A lookup that keeps the range guard happy in tests.
 *
 * 203.0.113.0/24 is the documentation range, which the guard blocks, so tests
 * that need a reachable host use an address outside every reserved block.
 */
export const publicLookup = fixedLookup('198.51.101.10');
