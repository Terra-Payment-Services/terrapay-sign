import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { RevocationCheckError } from './errors';
import { crlDistributionPointUrls, equalBytes, toArrayBuffer } from './x509';

/**
 * RFC 5280 CRL handling.
 *
 * The library's default provider does not parse CRLs at all: `fetchCrl` checks
 * `response.ok` and hands the body back, so a captive portal's HTML error page
 * would be written into the document's `/DSS` as a certificate revocation list.
 * Everything below exists so that cannot happen.
 *
 * A CRL is usable only when it parses, was issued by the certificate's issuer,
 * verifies under that issuer's key, is current, and is a complete base CRL
 * rather than a delta or an indirect CRL. The last two matter because the
 * conclusion we draw is "this serial is absent, therefore not revoked", and
 * that conclusion is unsound for a partial list.
 */

/** id-ce-basicConstraints */
const OID_BASIC_CONSTRAINTS = '2.5.29.19';

/** id-ce-deltaCRLIndicator */
const OID_DELTA_CRL_INDICATOR = '2.5.29.27';

/** id-ce-issuingDistributionPoint */
const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';

export type CrlStatus = 'good' | 'revoked';

export type CrlCheckResult = {
  status: CrlStatus;
  revokedAt?: Date;
};

export type ValidateCrlOptions = {
  crl: Uint8Array;
  certificate: pkijs.Certificate;
  /** The certificate that issued `certificate`, needed to check the signature. */
  issuer: pkijs.Certificate;
  now: Date;
  clockSkewMs: number;
};

const parseCrl = (der: Uint8Array): pkijs.CertificateRevocationList => {
  try {
    return pkijs.CertificateRevocationList.fromBER(toArrayBuffer(der));
  } catch (error) {
    throw new RevocationCheckError(
      `Fetched data is not a parseable CRL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const assertIsCompleteBaseCrl = (crl: pkijs.CertificateRevocationList, certificate: pkijs.Certificate): void => {
  const extensions = crl.crlExtensions?.extensions ?? [];

  if (extensions.some((extension) => extension.extnID === OID_DELTA_CRL_INDICATOR)) {
    throw new RevocationCheckError('Fetched CRL is a delta CRL, which cannot be used on its own');
  }

  const issuingDistributionPoint = extensions.find((extension) => extension.extnID === OID_ISSUING_DISTRIBUTION_POINT);

  if (!issuingDistributionPoint) {
    return;
  }

  const parsed = asn1js.fromBER(
    toArrayBuffer(new Uint8Array(issuingDistributionPoint.extnValue.valueBlock.valueHexView)),
  );

  if (parsed.offset === -1) {
    throw new RevocationCheckError('Fetched CRL carries an unparseable issuing distribution point');
  }

  const point = new pkijs.IssuingDistributionPoint({ schema: parsed.result });

  if (point.indirectCRL) {
    throw new RevocationCheckError('Fetched CRL is an indirect CRL, whose entries may belong to another issuer');
  }

  const certificateIsCa = isCertificateAuthority(certificate);

  if (point.onlyContainsCACerts && !certificateIsCa) {
    throw new RevocationCheckError('Fetched CRL covers only CA certificates, and this is an end entity certificate');
  }

  if (point.onlyContainsUserCerts && certificateIsCa) {
    throw new RevocationCheckError('Fetched CRL covers only end entity certificates, and this is a CA certificate');
  }

  if (point.onlyContainsAttributeCerts) {
    throw new RevocationCheckError('Fetched CRL covers only attribute certificates, which this is not');
  }

  // A CRL scoped to a subset of revocation reasons is silent about the others,
  // so the serial being absent proves nothing. RFC 5280 expects a verifier to
  // accumulate partitioned CRLs until every reason is covered, which this does
  // not do, so the honest answer is to refuse rather than to read absence as
  // good news.
  if (point.onlySomeReasons) {
    throw new RevocationCheckError(
      'Fetched CRL covers only some revocation reasons, so the absence of this certificate does not establish ' +
        'that it is unrevoked',
    );
  }

  // A CRL naming a distribution point only speaks for certificates pointed at
  // that same place. Another current, correctly signed CRL from the same CA
  // for a different partition would otherwise read as a clean bill of health.
  if (point.distributionPoint && !distributionPointMatches(point, certificate)) {
    throw new RevocationCheckError(
      'Fetched CRL is scoped to a distribution point this certificate does not name, so it does not cover it',
    );
  }
};

/**
 * Does the CRL's own distribution point appear among the ones the certificate
 * points at?
 *
 * Compared on the URI names, which is the form every CA in practice uses and
 * the only form `crlDistributionPointUrls` collects. A CRL scoped by anything
 * else is treated as not matching, which fails closed.
 */
const distributionPointMatches = (point: pkijs.IssuingDistributionPoint, certificate: pkijs.Certificate): boolean => {
  const names = point.distributionPoint;

  if (!Array.isArray(names)) {
    return false;
  }

  const crlNames = names
    .filter((name) => name.type === 6 && typeof name.value === 'string')
    .map((name): string => name.value);

  if (crlNames.length === 0) {
    return false;
  }

  const certificateUrls = new Set(crlDistributionPointUrls(certificate));

  return crlNames.some((name) => certificateUrls.has(name));
};

/** Does basicConstraints mark this certificate as a CA? */
const isCertificateAuthority = (certificate: pkijs.Certificate): boolean => {
  const extension = certificate.extensions?.find((candidate) => candidate.extnID === OID_BASIC_CONSTRAINTS);

  if (!extension) {
    return false;
  }

  const parsed = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

  if (parsed.offset === -1) {
    return false;
  }

  return new pkijs.BasicConstraints({ schema: parsed.result }).cA;
};

/**
 * Validate a CRL and report what it says about one certificate.
 *
 * @throws {RevocationCheckError} when the CRL does not parse, was not issued by
 *   the expected issuer, does not verify, is stale, or is not a complete list.
 */
export const validateCrl = async ({
  crl,
  certificate,
  issuer,
  now,
  clockSkewMs,
}: ValidateCrlOptions): Promise<CrlCheckResult> => {
  const parsed = parseCrl(crl);

  if (!parsed.issuer.isEqual(certificate.issuer)) {
    throw new RevocationCheckError('Fetched CRL was issued by a different authority than the certificate');
  }

  if (!parsed.issuer.isEqual(issuer.subject)) {
    throw new RevocationCheckError('Fetched CRL issuer does not match the issuing certificate supplied');
  }

  assertIsCompleteBaseCrl(parsed, certificate);

  const engine = pkijs.getCrypto(true);
  let signatureValid = false;

  try {
    signatureValid = await parsed.verify({ issuerCertificate: issuer }, engine);
  } catch (error) {
    throw new RevocationCheckError(
      `CRL signature could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!signatureValid) {
    throw new RevocationCheckError('CRL signature does not verify under the issuer key');
  }

  if (parsed.thisUpdate.value.getTime() > now.getTime() + clockSkewMs) {
    throw new RevocationCheckError('CRL is dated in the future');
  }

  // RFC 5280 requires conforming CRL issuers to set nextUpdate. Without it
  // there is no freshness bound, so an ancient list would look current.
  if (!parsed.nextUpdate) {
    throw new RevocationCheckError('CRL omits nextUpdate, so its freshness cannot be bounded');
  }

  if (parsed.nextUpdate.value.getTime() < now.getTime() - clockSkewMs) {
    throw new RevocationCheckError(`CRL expired at ${parsed.nextUpdate.value.toISOString()} and is too stale to embed`);
  }

  const serial = new Uint8Array(certificate.serialNumber.valueBlock.valueHexView);

  const entry = parsed.revokedCertificates?.find((revoked) =>
    equalBytes(new Uint8Array(revoked.userCertificate.valueBlock.valueHexView), serial),
  );

  if (!entry) {
    return { status: 'good' };
  }

  return {
    status: 'revoked',
    revokedAt: entry.revocationDate.value,
  };
};
