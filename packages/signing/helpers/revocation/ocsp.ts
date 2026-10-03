import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { RevocationCheckError } from './errors';
import {
  bytesToHex,
  digestByOid,
  encodedSubject,
  equalBytes,
  extendedKeyUsages,
  isSameCertificate,
  isWithinValidity,
  OID_KP_OCSP_SIGNING,
  publicKeyBits,
  toArrayBuffer,
} from './x509';

/**
 * RFC 6960 OCSP: build a request, and validate a response before anyone is
 * allowed to believe it.
 *
 * A response is only usable once all of the following hold. Any failure is a
 * `RevocationCheckError`, never a quiet null.
 *
 * 1. `responseStatus` is `successful` and the payload is an id-pkix-ocsp-basic
 *    BasicOCSPResponse.
 * 2. The responder named by `responderID` is found among the certificates the
 *    response carries or is the issuer itself.
 * 3. The responder is authorised for this issuer: it either is the issuer, or
 *    it was issued by the issuer, carries id-kp-OCSPSigning and verifies under
 *    the issuer's key. Nothing else counts, whatever the response claims.
 * 4. The signature over `tbsResponseData` verifies under the responder's key.
 * 5. A `SingleResponse` exists whose `CertID` matches the certificate on all
 *    three parts: issuer name hash, issuer key hash and serial number.
 * 6. `thisUpdate` is not in the future and `nextUpdate`, where present, is not
 *    in the past, allowing a small clock skew.
 * 7. The nonce, where we sent one and the responder echoed one, matches.
 *
 * Only then is `certStatus` read, and a `revoked` status is returned as such
 * rather than being smuggled into the document as evidence of validity.
 */

/** id-pkix-ocsp-basic */
const OID_BASIC_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.1';

/**
 * How old a response with no `nextUpdate` may be before it stops counting as
 * current. Seven days is longer than any responder's own publication interval
 * and far shorter than the window a replay needs to be useful.
 */
const MAX_AGE_WITHOUT_NEXT_UPDATE_MS = 7 * 24 * 60 * 60 * 1000;

/** id-pkix-ocsp-nonce */
const OID_OCSP_NONCE = '1.3.6.1.5.5.7.48.1.2';

const RESPONSE_STATUS_NAMES: Record<number, string> = {
  0: 'successful',
  1: 'malformedRequest',
  2: 'internalError',
  3: 'tryLater',
  5: 'sigRequired',
  6: 'unauthorized',
};

/** Nonce length RFC 8954 asks for. */
const NONCE_BYTES = 16;

export type OcspStatus = 'good' | 'revoked';

export type OcspCheckResult = {
  status: OcspStatus;
  /** Set when the responder said revoked. */
  revokedAt?: Date;
  /** CRLReason, where the responder gave one. */
  reasonCode?: number;
};

export type BuildOcspRequestOptions = {
  certificate: pkijs.Certificate;
  issuer: pkijs.Certificate;
  /** Sent as an id-pkix-ocsp-nonce extension so a replayed response is detectable. */
  nonce?: Uint8Array;
};

export type ValidateOcspResponseOptions = {
  response: Uint8Array;
  certificate: pkijs.Certificate;
  issuer: pkijs.Certificate;
  /** The nonce sent with the request, if any. */
  nonce?: Uint8Array;
  now: Date;
  clockSkewMs: number;
};

export const createNonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

/** Build a DER OCSPRequest for one certificate, with a nonce when given one. */
export const buildOcspRequest = async ({
  certificate,
  issuer,
  nonce,
}: BuildOcspRequestOptions): Promise<Uint8Array> => {
  const engine = pkijs.getCrypto(true);
  const request = new pkijs.OCSPRequest();

  await request.createForCertificate(certificate, { hashAlgorithm: 'SHA-1', issuerCertificate: issuer }, engine);

  if (nonce) {
    request.tbsRequest.requestExtensions = [
      new pkijs.Extension({
        extnID: OID_OCSP_NONCE,
        critical: false,
        extnValue: new asn1js.OctetString({ valueHex: toArrayBuffer(nonce) }).toBER(false),
      }),
    ];
  }

  return new Uint8Array(request.toSchema(true).toBER(false));
};

const parseBasicResponse = (response: Uint8Array): pkijs.BasicOCSPResponse => {
  let ocspResponse: pkijs.OCSPResponse;

  try {
    ocspResponse = pkijs.OCSPResponse.fromBER(toArrayBuffer(response));
  } catch (error) {
    throw new RevocationCheckError(
      `OCSP response is not a parseable OCSPResponse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = ocspResponse.responseStatus.valueBlock.valueDec;

  if (status !== 0) {
    throw new RevocationCheckError(
      `OCSP responder returned status ${RESPONSE_STATUS_NAMES[status] ?? status} rather than successful`,
    );
  }

  if (!ocspResponse.responseBytes) {
    throw new RevocationCheckError('OCSP response claims success but carries no response bytes');
  }

  if (ocspResponse.responseBytes.responseType !== OID_BASIC_OCSP_RESPONSE) {
    throw new RevocationCheckError(
      `OCSP response carries an unsupported response type ${ocspResponse.responseBytes.responseType}`,
    );
  }

  try {
    return pkijs.BasicOCSPResponse.fromBER(
      toArrayBuffer(new Uint8Array(ocspResponse.responseBytes.response.valueBlock.valueHexView)),
    );
  } catch (error) {
    throw new RevocationCheckError(
      `OCSP response body is not a parseable BasicOCSPResponse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** Find the certificate the response says signed it, among the ones on offer. */
const findResponderCertificate = async (
  basic: pkijs.BasicOCSPResponse,
  issuer: pkijs.Certificate,
): Promise<pkijs.Certificate> => {
  const candidates = [issuer, ...(basic.certs ?? [])];
  const responderId = basic.tbsResponseData.responderID;

  if (responderId instanceof pkijs.RelativeDistinguishedNames) {
    const match = candidates.find((candidate) => candidate.subject.isEqual(responderId));

    if (!match) {
      throw new RevocationCheckError('OCSP response names a responder whose certificate it does not carry');
    }

    return match;
  }

  if (responderId instanceof asn1js.OctetString) {
    const wanted = new Uint8Array(responderId.valueBlock.valueHexView);

    for (const candidate of candidates) {
      const keyHash = await digestByOid('1.3.14.3.2.26', publicKeyBits(candidate));

      if (equalBytes(keyHash, wanted)) {
        return candidate;
      }
    }

    throw new RevocationCheckError('OCSP response names a responder key whose certificate it does not carry');
  }

  throw new RevocationCheckError('OCSP response carries a responderID of an unrecognised form');
};

/**
 * Establish that the responder may speak for this issuer.
 *
 * Either it is the issuer, or the issuer delegated to it explicitly. A
 * certificate that merely claims the issuer's name proves nothing, so the
 * delegation is checked by verifying the responder certificate under the
 * issuer's own key.
 */
const assertResponderIsAuthorised = async (
  responder: pkijs.Certificate,
  issuer: pkijs.Certificate,
  now: Date,
  clockSkewMs: number,
): Promise<void> => {
  if (isSameCertificate(responder, issuer)) {
    return;
  }

  if (!responder.issuer.isEqual(issuer.subject)) {
    throw new RevocationCheckError('OCSP responder certificate was not issued by the certificate issuer');
  }

  if (!extendedKeyUsages(responder).includes(OID_KP_OCSP_SIGNING)) {
    throw new RevocationCheckError(
      'OCSP responder certificate does not carry the id-kp-OCSPSigning extended key usage',
    );
  }

  if (!isWithinValidity(responder, now, clockSkewMs)) {
    throw new RevocationCheckError('OCSP responder certificate is outside its validity period');
  }

  const engine = pkijs.getCrypto(true);
  let delegated = false;

  try {
    delegated = await responder.verify(issuer, engine);
  } catch (error) {
    throw new RevocationCheckError(
      `OCSP responder certificate could not be verified against the issuer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!delegated) {
    throw new RevocationCheckError('OCSP responder certificate does not verify under the issuer key');
  }
};

/** Does this CertID identify the certificate we asked about? */
const certIdMatches = async (
  certId: pkijs.CertID,
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
): Promise<boolean> => {
  const hashOid = certId.hashAlgorithm.algorithmId;
  const expectedNameHash = await digestByOid(hashOid, encodedSubject(issuer));
  const expectedKeyHash = await digestByOid(hashOid, publicKeyBits(issuer));

  return (
    equalBytes(new Uint8Array(certId.issuerNameHash.valueBlock.valueHexView), expectedNameHash) &&
    equalBytes(new Uint8Array(certId.issuerKeyHash.valueBlock.valueHexView), expectedKeyHash) &&
    equalBytes(
      new Uint8Array(certId.serialNumber.valueBlock.valueHexView),
      new Uint8Array(certificate.serialNumber.valueBlock.valueHexView),
    )
  );
};

const extractNonce = (extensions: pkijs.Extension[] | undefined): Uint8Array | null => {
  const extension = extensions?.find((candidate) => candidate.extnID === OID_OCSP_NONCE);

  if (!extension) {
    return null;
  }

  const inner = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

  if (inner.offset === -1 || !(inner.result instanceof asn1js.OctetString)) {
    throw new RevocationCheckError('OCSP response carries a nonce that is not an octet string');
  }

  return new Uint8Array(inner.result.valueBlock.valueHexView);
};

const readCertStatus = (singleResponse: pkijs.SingleResponse): OcspCheckResult => {
  const certStatus: unknown = singleResponse.certStatus;

  if (!(certStatus instanceof asn1js.BaseBlock)) {
    throw new RevocationCheckError('OCSP response carries an unreadable certStatus');
  }

  const tag = certStatus.idBlock.tagNumber;

  if (tag === 0) {
    return { status: 'good' };
  }

  if (tag === 1) {
    const parts = certStatus instanceof asn1js.Constructed ? certStatus.valueBlock.value : [];
    const revocationTime = parts[0];
    const revokedAt = revocationTime instanceof asn1js.GeneralizedTime ? revocationTime.toDate() : undefined;

    return { status: 'revoked', revokedAt };
  }

  throw new RevocationCheckError('OCSP responder reports the certificate status as unknown');
};

/**
 * Validate an OCSP response and return what it says about the certificate.
 *
 * @throws {RevocationCheckError} when the response is malformed, unsigned by an
 *   authorised responder, stale, or about a different certificate.
 */
export const validateOcspResponse = async ({
  response,
  certificate,
  issuer,
  nonce,
  now,
  clockSkewMs,
}: ValidateOcspResponseOptions): Promise<OcspCheckResult> => {
  const basic = parseBasicResponse(response);
  const responder = await findResponderCertificate(basic, issuer);

  await assertResponderIsAuthorised(responder, issuer, now, clockSkewMs);

  const engine = pkijs.getCrypto(true);
  let signatureValid = false;

  try {
    signatureValid = await engine.verifyWithPublicKey(
      basic.tbsResponseData.tbsView,
      basic.signature,
      responder.subjectPublicKeyInfo,
      basic.signatureAlgorithm,
    );
  } catch (error) {
    throw new RevocationCheckError(
      `OCSP response signature could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!signatureValid) {
    throw new RevocationCheckError('OCSP response signature does not verify under the responder key');
  }

  if (nonce) {
    const echoed = extractNonce(basic.tbsResponseData.responseExtensions);

    // A responder serving pre-produced responses legitimately omits the nonce.
    // One that echoes a different nonce is replaying something at us.
    if (echoed && !equalBytes(echoed, nonce)) {
      throw new RevocationCheckError('OCSP response echoes a nonce that does not match the request');
    }
  }

  const matches: pkijs.SingleResponse[] = [];

  for (const singleResponse of basic.tbsResponseData.responses) {
    if (await certIdMatches(singleResponse.certID, certificate, issuer)) {
      matches.push(singleResponse);
    }
  }

  if (matches.length === 0) {
    throw new RevocationCheckError(
      `OCSP response contains no entry for serial ${bytesToHex(new Uint8Array(certificate.serialNumber.valueBlock.valueHexView))}`,
    );
  }

  const singleResponse = matches[0];

  if (singleResponse.thisUpdate.getTime() > now.getTime() + clockSkewMs) {
    throw new RevocationCheckError('OCSP response is dated in the future');
  }

  if (singleResponse.nextUpdate && singleResponse.nextUpdate.getTime() < now.getTime() - clockSkewMs) {
    throw new RevocationCheckError(
      `OCSP response expired at ${singleResponse.nextUpdate.toISOString()} and is too stale to embed`,
    );
  }

  // A response with no nextUpdate is not timeless. RFC 6960 reads an absent
  // nextUpdate as "newer information is always available", which is the
  // opposite of "this answer never goes stale". Without a bound here, a
  // correctly signed `good` from years ago, for a certificate revoked since,
  // replays cleanly: the nonce is the other defence and a responder is allowed
  // to omit it when serving pre-produced responses, so neither check alone
  // catches this.
  if (!singleResponse.nextUpdate) {
    const age = now.getTime() - singleResponse.thisUpdate.getTime();

    if (age > MAX_AGE_WITHOUT_NEXT_UPDATE_MS + clockSkewMs) {
      throw new RevocationCheckError(
        `OCSP response was produced at ${singleResponse.thisUpdate.toISOString()}, carries no nextUpdate, and is ` +
          `older than ${MAX_AGE_WITHOUT_NEXT_UPDATE_MS / 86_400_000} days, so it cannot be treated as current`,
      );
    }
  }

  return readCertStatus(singleResponse);
};
