import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { equalBytes, toArrayBuffer } from '../revocation/x509';

/**
 * Checking that a timestamp token is what we asked for.
 *
 * `@libpdf/core` does not do this. Its `HttpTimestampAuthority` checks the HTTP
 * status, that the response parses as ASN.1, and that `PKIStatus` is 0 or 1,
 * and then returns the token bytes to be embedded. It never verifies the
 * signature on the token, the certificate that made it, the message imprint or
 * the nonce. A compromised authority, an impersonated one, or anything sitting
 * on the connection can therefore decide what time our documents claim to have
 * been signed at, and nothing downstream would notice.
 *
 * That matters more here than it might elsewhere. The timestamp is the whole
 * reason a signature is B-LTA rather than B-B: it is what lets the signature
 * still verify after the signing certificate expires, and what a dispute would
 * rest on. A forged one is worse than none, because it looks like evidence.
 *
 * RFC 3161 puts the duty on the requester: verify the token signature, that
 * the imprint matches what was sent, and that the nonce matches. This does
 * that. It does not attempt full path validation to a trust store, which is a
 * separate piece of work; what it establishes is that the token was made by
 * the certificate inside it, for our digest, in answer to our request.
 */

/** id-ct-TSTInfo */
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';

/** id-kp-timeStamping */
const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

/** id-ce-extKeyUsage */
const OID_EXT_KEY_USAGE = '2.5.29.37';

/** id-messageDigest */
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';

/** id-contentType */
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';

/** OID to the name WebCrypto knows it by, for reading the token's own choices. */
const DIGEST_NAMES_BY_OID: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

const DIGEST_OIDS: Record<string, string> = {
  'SHA-256': '2.16.840.1.101.3.4.2.1',
  'SHA-384': '2.16.840.1.101.3.4.2.2',
  'SHA-512': '2.16.840.1.101.3.4.2.3',
};

/** Raised when a timestamp token cannot be trusted. Never carries the token. */
export class TimestampVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampVerificationError';
  }
}

export type VerifyTimestampTokenOptions = {
  /** DER-encoded TimeStampToken, as returned by the authority. */
  token: Uint8Array;
  /** The digest we asked to have timestamped. */
  digest: Uint8Array;
  /** The algorithm that digest was produced with. */
  digestAlgorithm: string;
  /** The nonce we sent, which the token must echo. */
  nonce: Uint8Array;
  /** Overridden in tests, where the fixture is older than today. */
  now?: Date;
};

/**
 * Verify a timestamp token against the request it answers.
 *
 * @throws {TimestampVerificationError} on any failure. There is no partial
 *   success: a token that cannot be verified must not be embedded, because
 *   embedding it is what turns it into evidence.
 */
export const verifyTimestampToken = async ({
  token,
  digest,
  digestAlgorithm,
  nonce,
  now = new Date(),
}: VerifyTimestampTokenOptions): Promise<{ genTime: Date }> => {
  const signedData = parseSignedData(token);

  const eContent = signedData.encapContentInfo.eContent;

  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO || !eContent) {
    throw new TimestampVerificationError(
      `Timestamp token does not carry TSTInfo (content type ${signedData.encapContentInfo.eContentType})`,
    );
  }

  // The signature first. Everything read out of TSTInfo below is only worth
  // reading because this established who wrote it.
  await assertSignatureIsValid(signedData, new Uint8Array(eContent.getValue()));
  assertSignerMayTimestamp(signedData);

  const info = parseTstInfo(new Uint8Array(eContent.getValue()));

  assertImprintMatches(info, digest, digestAlgorithm);
  assertNonceMatches(info, nonce);

  if (info.genTime.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new TimestampVerificationError(`Timestamp token claims a time in the future (${info.genTime.toISOString()})`);
  }

  return { genTime: info.genTime };
};

const parseSignedData = (token: Uint8Array): pkijs.SignedData => {
  let contentInfo: pkijs.ContentInfo;

  try {
    const parsed = asn1js.fromBER(toArrayBuffer(token));

    if (parsed.offset === -1) {
      throw new Error('not valid ASN.1');
    }

    contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
  } catch (error) {
    throw new TimestampVerificationError(
      `Timestamp token does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return new pkijs.SignedData({ schema: contentInfo.content });
  } catch (error) {
    throw new TimestampVerificationError(
      `Timestamp token is not CMS SignedData: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Verify the CMS signature over the TSTInfo.
 *
 * Done by hand rather than through `SignedData.verify`, because pkijs
 * special-cases a TSTInfo payload: it tries to recompute the message imprint
 * over the data that was timestamped, and we hold only the digest, never the
 * document behind it. Asking it to verify therefore fails on a token that is
 * perfectly good.
 *
 * So this does what CMS actually requires. The signature covers the DER
 * encoding of the signed attributes, re-encoded as a SET rather than the
 * implicit tag they appear under, and one of those attributes carries the
 * digest of the content. Checking both is what ties the signature to this
 * TSTInfo rather than to some other one.
 *
 * Chain building is deliberately out of scope. Establishing that the signer
 * chains to a root we trust needs a trust store and a policy about which
 * authorities are acceptable, which is a decision rather than a computation.
 * What this proves is narrower and still worth having: the token was made by
 * the key whose certificate travels inside it, over this content.
 */
const assertSignatureIsValid = async (signedData: pkijs.SignedData, eContent: Uint8Array): Promise<void> => {
  if (signedData.signerInfos.length !== 1) {
    throw new TimestampVerificationError(
      `Timestamp token has ${signedData.signerInfos.length} signers; exactly one is expected`,
    );
  }

  const certificate = signedData.certificates?.[0];

  if (!(certificate instanceof pkijs.Certificate)) {
    throw new TimestampVerificationError(
      'Timestamp token carries no certificate, so the signature cannot be checked against anything',
    );
  }

  const signer = signedData.signerInfos[0];
  const attributes = signer.signedAttrs;

  if (!attributes) {
    throw new TimestampVerificationError('Timestamp token has no signed attributes');
  }

  await assertContentDigestMatches(attributes, eContent, signer.digestAlgorithm.algorithmId);

  // RFC 5652: the signature is over the DER SET OF SignedAttributes, not over
  // the [0] IMPLICIT encoding they appear in inside the SignerInfo.
  const signedBytes = new Uint8Array(
    new asn1js.Set({ value: attributes.attributes.map((attribute) => attribute.toSchema()) }).toBER(false),
  );

  // The signature algorithm in a SignerInfo is usually bare rsaEncryption,
  // which names no hash. In CMS the hash comes from the signer's own digest
  // algorithm, so it has to be supplied separately or the verify fails as
  // unsupported on a token that is entirely valid.
  const hashName = DIGEST_NAMES_BY_OID[signer.digestAlgorithm.algorithmId];

  if (!hashName) {
    throw new TimestampVerificationError(
      `Timestamp token signs under unsupported digest ${signer.digestAlgorithm.algorithmId}`,
    );
  }

  const engine = pkijs.getCrypto(true);
  let valid = false;

  try {
    valid = await engine.verifyWithPublicKey(
      signedBytes,
      signer.signature,
      certificate.subjectPublicKeyInfo,
      signer.signatureAlgorithm,
      hashName,
    );
  } catch (error) {
    throw new TimestampVerificationError(
      `Timestamp token signature could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!valid) {
    throw new TimestampVerificationError('Timestamp token signature does not verify under its own certificate');
  }
};

/**
 * The message-digest signed attribute must be the digest of the TSTInfo.
 *
 * Without this the signature would be over a set of attributes that need have
 * nothing to do with the content they travel with, and a valid signature from
 * the authority over some other TSTInfo could be pasted onto this one.
 */
const assertContentDigestMatches = async (
  attributes: pkijs.SignedAndUnsignedAttributes,
  eContent: Uint8Array,
  digestOid: string,
): Promise<void> => {
  const attribute = attributes.attributes.find((candidate) => candidate.type === OID_MESSAGE_DIGEST);
  const value = attribute?.values?.[0];

  if (!(value instanceof asn1js.OctetString)) {
    throw new TimestampVerificationError('Timestamp token has no message-digest attribute');
  }

  const contentType = attributes.attributes.find((candidate) => candidate.type === OID_CONTENT_TYPE);
  const declared = contentType?.values?.[0];

  if (!(declared instanceof asn1js.ObjectIdentifier) || declared.valueBlock.toString() !== OID_TST_INFO) {
    throw new TimestampVerificationError('Timestamp token signed attributes do not declare TSTInfo content');
  }

  // Read from the token rather than assumed. Sectigo signs its attributes
  // under SHA-384 and DigiCert under SHA-256, and hardcoding either would
  // reject the other's perfectly good token. An unknown algorithm fails rather
  // than skipping the check.
  const name = DIGEST_NAMES_BY_OID[digestOid];

  if (!name) {
    throw new TimestampVerificationError(`Timestamp token signs its attributes under unsupported digest ${digestOid}`);
  }

  const engine = pkijs.getCrypto(true);
  const digested = new Uint8Array(await engine.digest({ name }, eContent));
  const claimed = new Uint8Array(value.valueBlock.valueHexView);

  if (!equalBytes(digested, claimed)) {
    throw new TimestampVerificationError(
      'Timestamp token message-digest attribute does not match the TSTInfo it travels with',
    );
  }
};

/**
 * The signing certificate must say it is for timestamping and nothing else.
 *
 * RFC 3161 requires the extended key usage extension to be present, critical,
 * and to contain only id-kp-timeStamping. A certificate that is also good for
 * TLS or for signing documents would let a key taken from somewhere else mint
 * timestamps.
 */
const assertSignerMayTimestamp = (signedData: pkijs.SignedData): void => {
  const certificate = signedData.certificates?.[0];

  if (!(certificate instanceof pkijs.Certificate)) {
    throw new TimestampVerificationError('Timestamp token carries no usable signing certificate');
  }

  const extension = certificate.extensions?.find((candidate) => candidate.extnID === OID_EXT_KEY_USAGE);

  if (!extension) {
    throw new TimestampVerificationError('Timestamp signing certificate has no extended key usage extension');
  }

  const parsed = asn1js.fromBER(toArrayBuffer(new Uint8Array(extension.extnValue.valueBlock.valueHexView)));

  if (parsed.offset === -1) {
    throw new TimestampVerificationError('Timestamp signing certificate has an unparseable extended key usage');
  }

  const usages = new pkijs.ExtKeyUsage({ schema: parsed.result }).keyPurposes;

  if (!usages.includes(OID_KP_TIME_STAMPING)) {
    throw new TimestampVerificationError(
      'Timestamp signing certificate is not marked for timestamping (missing id-kp-timeStamping)',
    );
  }

  if (usages.length !== 1) {
    throw new TimestampVerificationError(
      `Timestamp signing certificate allows ${usages.length} key purposes; RFC 3161 requires timestamping alone`,
    );
  }
};

type TstInfo = {
  genTime: Date;
  hashAlgorithm: string;
  hashedMessage: Uint8Array;
  nonce: Uint8Array | null;
};

const parseTstInfo = (bytes: Uint8Array): TstInfo => {
  const parsed = asn1js.fromBER(toArrayBuffer(bytes));

  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new TimestampVerificationError('TSTInfo does not parse');
  }

  const fields = parsed.result.valueBlock.value;

  // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber,
  //                        genTime, [accuracy], [ordering], [nonce], ... }
  const imprint = fields[2];

  if (!(imprint instanceof asn1js.Sequence)) {
    throw new TimestampVerificationError('TSTInfo carries no message imprint');
  }

  const algorithm = imprint.valueBlock.value[0];
  const hashed = imprint.valueBlock.value[1];

  if (!(algorithm instanceof asn1js.Sequence) || !(hashed instanceof asn1js.OctetString)) {
    throw new TimestampVerificationError('TSTInfo message imprint is malformed');
  }

  const algorithmOid = algorithm.valueBlock.value[0];

  if (!(algorithmOid instanceof asn1js.ObjectIdentifier)) {
    throw new TimestampVerificationError('TSTInfo message imprint names no digest algorithm');
  }

  const genTimeField = fields[4];

  if (!(genTimeField instanceof asn1js.GeneralizedTime)) {
    throw new TimestampVerificationError('TSTInfo carries no genTime');
  }

  // The nonce is optional and, when present, is the only INTEGER after genTime.
  const nonceField = fields.slice(5).find((field) => field instanceof asn1js.Integer);

  return {
    genTime: genTimeField.toDate(),
    hashAlgorithm: algorithmOid.valueBlock.toString(),
    hashedMessage: new Uint8Array(hashed.valueBlock.valueHexView),
    nonce: nonceField instanceof asn1js.Integer ? new Uint8Array(nonceField.valueBlock.valueHexView) : null,
  };
};

const assertImprintMatches = (info: TstInfo, digest: Uint8Array, digestAlgorithm: string): void => {
  const expected = DIGEST_OIDS[digestAlgorithm];

  if (!expected) {
    throw new TimestampVerificationError(`Cannot verify a timestamp over unsupported digest ${digestAlgorithm}`);
  }

  if (info.hashAlgorithm !== expected) {
    throw new TimestampVerificationError(
      `Timestamp token is over a ${info.hashAlgorithm} digest, but ${digestAlgorithm} was requested`,
    );
  }

  // The point of the whole exercise. A token over some other digest is a
  // perfectly valid timestamp of somebody else's document.
  if (!equalBytes(info.hashedMessage, digest)) {
    throw new TimestampVerificationError(
      'Timestamp token is over a different digest from the one that was sent, so it does not cover this signature',
    );
  }
};

/**
 * The nonce ties this answer to this request.
 *
 * Required here rather than optional. A responder may legitimately omit it
 * when serving pre-produced OCSP responses; there is no such thing for a
 * timestamp, which is produced on demand, so a missing or different nonce
 * means the answer is not ours and may be a replay.
 *
 * Compared as unsigned big-endian with leading zeroes ignored, because DER
 * INTEGER is signed and drops or adds a leading zero byte depending on the
 * top bit.
 */
const assertNonceMatches = (info: TstInfo, nonce: Uint8Array): void => {
  if (!info.nonce) {
    throw new TimestampVerificationError('Timestamp token echoes no nonce, so it cannot be tied to this request');
  }

  const strip = (bytes: Uint8Array) => {
    let start = 0;

    while (start < bytes.length - 1 && bytes[start] === 0) {
      start += 1;
    }

    return bytes.subarray(start);
  };

  if (!equalBytes(strip(info.nonce), strip(nonce))) {
    throw new TimestampVerificationError('Timestamp token echoes a nonce that does not match the request');
  }
};
