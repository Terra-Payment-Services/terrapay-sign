import { PDF } from '@libpdf/core';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/**
 * Does every signature already in this PDF still cover the bytes it was made
 * over?
 *
 * This is the guarantee the fork exists for, checked at the one place every
 * document passes through on its way to storage rather than at each caller.
 *
 * The earlier approach compared the stored file against the uploaded file and
 * required one to be a prefix of the other. That works, and it only works
 * where somebody remembered to do it. A review found four routes that reach
 * storage without it: placeholder removal draws over the page and does a plain
 * full save, form filling saves incrementally with no fallback check and runs
 * *before* normalisation so the comparison afterwards uses already-rewritten
 * bytes as its baseline, field creation by placeholder saves plainly, and the
 * AES path rewrites with an xref stream. Each is a separate patch, and the
 * next route added would be a fifth.
 *
 * A prefix comparison was always a proxy anyway. What actually matters is
 * whether the bytes under the signature still hash to what the signature says
 * they hashed to, and a PDF carries everything needed to answer that: the
 * /ByteRange names the covered spans, and the signature's own signed
 * attributes carry the digest of them. So this needs no original to compare
 * against, catches a rewrite wherever it happened, and cannot be bypassed by
 * adding another step upstream.
 *
 * It deliberately does not verify the signer's certificate or chain. Whether a
 * counterparty's certificate is trustworthy is their business and was settled
 * before the document reached us. The question here is narrower: did we break
 * it.
 */

const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
/** id-ct-TSTInfo, the eContent of an RFC 3161 timestamp token. */
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';

const DIGEST_NAMES_BY_OID: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '1.3.14.3.2.26': 'SHA-1',
};

/** Raised when a document would be stored with a signature we have broken. */
export class EmbeddedSignatureBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddedSignatureBrokenError';
  }
}

export type EmbeddedSignatureReport = {
  /** Signature fields carrying a signature. */
  checked: number;
  /** Those whose covered bytes still hash to what they claim. */
  intact: number;
  /** Those the check could not evaluate, with the reason. */
  skipped: string[];
};

/**
 * Check every signature in `bytes` and throw if any no longer covers the
 * document it sits in.
 *
 * @param bytes the file exactly as it is to be judged.
 * @param loaded optionally, `bytes` already parsed, so a caller that has
 *   loaded the file does not pay for a second parse. See
 *   `inspectEmbeddedSignatures` for what it must be.
 * @throws {EmbeddedSignatureBrokenError} when a signature's covered bytes no
 *   longer match its own digest, which means the file was rewritten under it.
 */
export const assertEmbeddedSignaturesIntact = async (
  bytes: Uint8Array,
  loaded?: PDF,
): Promise<EmbeddedSignatureReport> => {
  const report = await inspectEmbeddedSignatures(bytes, loaded);

  return report;
};

/**
 * The same check, reporting rather than throwing, for callers that want to
 * decide what to do about it.
 *
 * @param bytes the file exactly as it is to be judged. The /ByteRange spans
 *   and the /Contents gap are read from these bytes.
 * @param loaded optionally, a document parsed from exactly `bytes` and not
 *   modified since. Only the signature dictionaries are read from it. A
 *   document parsed from other bytes, or one already filled or flattened,
 *   would be judged against the wrong file. When absent, `bytes` is parsed here.
 */
export const inspectEmbeddedSignatures = async (bytes: Uint8Array, loaded?: PDF): Promise<EmbeddedSignatureReport> => {
  let doc: PDF;

  try {
    doc = loaded ?? (await PDF.load(bytes));
  } catch {
    // Not our question. A file that will not load is rejected elsewhere, and
    // failing here would turn a parse problem into a signature accusation.
    return { checked: 0, intact: 0, skipped: ['document did not load'] };
  }

  const fields = (doc.getForm()?.getSignatureFields() ?? []).filter((field) => field.isSigned());
  const skipped: string[] = [];
  let intact = 0;

  for (const [index, field] of fields.entries()) {
    const name = `signature ${index + 1}`;
    const dict = field.getSignatureDict();

    if (!dict) {
      skipped.push(`${name}: no signature dictionary`);
      continue;
    }

    const range = readByteRange(dict);

    if (!range) {
      skipped.push(`${name}: no usable /ByteRange`);
      continue;
    }

    const [start, firstLength, secondStart, secondLength] = range;

    if (
      start < 0 ||
      firstLength < 0 ||
      secondStart < start + firstLength ||
      secondLength < 0 ||
      secondStart + secondLength > bytes.length
    ) {
      // The ranges no longer describe this file at all, which is what a full
      // rewrite does to them. That is a broken signature, not a skip.
      throw new EmbeddedSignatureBrokenError(
        `${name} covers bytes outside the document it is in, so the file was rewritten after it was signed`,
      );
    }

    const covered = new Uint8Array(firstLength + secondLength);

    covered.set(bytes.subarray(start, start + firstLength), 0);
    covered.set(bytes.subarray(secondStart, secondStart + secondLength), firstLength);

    const claimed = await claimedDigest(dict, bytes.subarray(start + firstLength, secondStart));

    if (!claimed) {
      skipped.push(`${name}: signature carries no message digest to compare against`);
      continue;
    }

    const engine = pkijs.getCrypto(true);
    const actual = new Uint8Array(await engine.digest({ name: claimed.algorithm }, covered));

    if (!equal(actual, claimed.digest)) {
      throw new EmbeddedSignatureBrokenError(
        `${name} no longer covers the bytes it was made over. The document was rewritten after it was signed, ` +
          'so the signature would be stored broken. Refusing to store it.',
      );
    }

    const verdict = await verifySigners(claimed.signedData, covered);

    if (verdict === 'unverifiable') {
      skipped.push(`${name}: the signer's signature could not be checked`);
      continue;
    }

    if (verdict === 'invalid') {
      throw new EmbeddedSignatureBrokenError(
        `${name} does not verify under its signer's certificate, so its signature value is not valid`,
      );
    }

    intact += 1;
  }

  return { checked: fields.length, intact, skipped };
};

/** /ByteRange as four numbers, or null if it is not the expected shape. */
const readByteRange = (dict: { get: (key: string) => unknown }): number[] | null => {
  const value = dict.get('ByteRange') as { items?: Array<{ value?: unknown }> } | undefined;
  const items = value?.items;

  if (!Array.isArray(items) || items.length !== 4) {
    return null;
  }

  const numbers = items.map((item) => Number(item?.value));

  return numbers.every((number) => Number.isFinite(number)) ? numbers : null;
};

/**
 * The digest the signature says it was made over, and the algorithm used.
 *
 * For an ordinary signature this is the message-digest signed attribute of the
 * CMS in /Contents, which is where a PDF signature records it.
 *
 * A document timestamp records it somewhere else, and reading the wrong one
 * accuses every timestamped document of being broken. Its /Contents is an RFC
 * 3161 timestamp token whose signed attributes cover the TSTInfo, not the PDF,
 * so the message-digest attribute there is the digest of the TSTInfo and will
 * never match the bytes the /ByteRange covers. The digest of those bytes is the
 * imprint inside TSTInfo. Since we add a document timestamp to every document
 * we seal at B-LT or above, reading the attribute made this check refuse every
 * document the moment a timestamp authority was configured.
 *
 * The signature is read from the gap the /ByteRange leaves, which is the
 * /Contents string as written. In an encrypted file that string is stored
 * unencrypted, but the parser decrypts it like any other string, which turns
 * an RC4 or AES-128 signature into noise. The parsed value is the fallback.
 */
const claimedDigest = async (
  dict: { get: (key: string) => unknown },
  gap: Uint8Array,
): Promise<{ algorithm: string; digest: Uint8Array; signedData: pkijs.SignedData } | null> => {
  const written = /^\s*<([0-9a-fA-F\s]*)>\s*$/.exec(new TextDecoder('latin1').decode(gap));
  const contents = written
    ? { value: written[1] }
    : (dict.get('Contents') as { value?: string; bytes?: Uint8Array } | undefined);
  const der = toBytes(contents);

  if (!der) {
    return null;
  }

  try {
    const parsed = asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength));

    if (parsed.offset === -1) {
      return null;
    }

    const signedData = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: parsed.result }).content });

    if (signedData.encapContentInfo?.eContentType === OID_TST_INFO) {
      const imprint = timestampImprint(signedData);

      return imprint ? { ...imprint, signedData } : null;
    }

    const signer = signedData.signerInfos[0];
    const attribute = signer?.signedAttrs?.attributes.find((candidate) => candidate.type === OID_MESSAGE_DIGEST);
    const value = attribute?.values?.[0];
    const algorithm = DIGEST_NAMES_BY_OID[signer?.digestAlgorithm?.algorithmId ?? ''];

    if (!(value instanceof asn1js.OctetString) || !algorithm) {
      return null;
    }

    return { algorithm, digest: new Uint8Array(value.valueBlock.valueHexView), signedData };
  } catch {
    return null;
  }
};

/**
 * Does every signer's signature over its signed attributes verify under the
 * signer's own certificate in the CMS?
 *
 * Matching the digest only shows the covered bytes are the ones the signed
 * attributes name. Anyone can write those attributes; the signature over them
 * is what shows the signer did, so a corrupted or forged signature value
 * passes the digest check and fails here.
 *
 * The content is the bytes the /ByteRange covers for an ordinary signature,
 * and the TSTInfo for a document timestamp, whose imprint over the covered
 * bytes is checked by the caller. The chain is not checked: whose certificate
 * it is was settled before the document reached us, and Sign's own is checked
 * when it signs.
 *
 * Done by hand, as in timestamp/verify.ts, because `SignedData.verify` fails
 * on valid signatures under the crypto engine @libpdf/core installs. Only a
 * signer whose certificate or algorithm cannot be found is 'unverifiable'; a
 * known signer whose signature does not verify, or cannot be decoded, is
 * 'invalid'.
 */
const verifySigners = async (
  signedData: pkijs.SignedData,
  covered: Uint8Array,
): Promise<'valid' | 'invalid' | 'unverifiable'> => {
  const engine = pkijs.getCrypto(true);
  const eContent = signedData.encapContentInfo?.eContent;
  const content = eContent ? new Uint8Array(eContent.getValue()) : covered;

  if (signedData.signerInfos.length === 0) {
    return 'unverifiable';
  }

  for (const signer of signedData.signerInfos) {
    const certificate = signerCertificate(signedData, signer);
    const hash = DIGEST_NAMES_BY_OID[signer.digestAlgorithm.algorithmId];
    const isKnownAlgorithm =
      'name' in engine.getAlgorithmByOID(signer.signatureAlgorithm.algorithmId) &&
      'name' in engine.getAlgorithmByOID(certificate?.subjectPublicKeyInfo.algorithm.algorithmId ?? '');

    if (!certificate || !hash || !isKnownAlgorithm) {
      return 'unverifiable';
    }

    let signed = content;

    if (signer.signedAttrs) {
      const attribute = signer.signedAttrs.attributes.find((candidate) => candidate.type === OID_MESSAGE_DIGEST);
      const value = attribute?.values?.[0];

      if (!(value instanceof asn1js.OctetString)) {
        return 'unverifiable';
      }

      const digest = new Uint8Array(await engine.digest({ name: hash }, content));

      if (!equal(digest, new Uint8Array(value.valueBlock.valueHexView))) {
        return 'invalid';
      }

      signed = new Uint8Array(signer.signedAttrs.encodedValue);
    }

    let verified: boolean;

    try {
      verified = await engine.verifyWithPublicKey(
        signed,
        signer.signature,
        certificate.subjectPublicKeyInfo,
        signer.signatureAlgorithm,
        hash,
      );
    } catch {
      // The certificate and algorithms are known, so a value that cannot even
      // be decoded is a broken signature, not one we are unable to judge.
      verified = false;
    }

    if (!verified) {
      return 'invalid';
    }
  }

  return 'valid';
};

/**
 * The [0] subjectKeyIdentifier choice of a SignerInfo sid. pkijs parses it as
 * a constructed block holding the OCTET STRING; read a primitive one too.
 */
const subjectKeyIdentifier = (sid: unknown): Uint8Array | null => {
  if (sid instanceof asn1js.Constructed) {
    const inner = sid.valueBlock.value[0];

    return inner instanceof asn1js.OctetString ? new Uint8Array(inner.valueBlock.valueHexView) : null;
  }

  if (sid instanceof asn1js.Primitive) {
    return new Uint8Array(sid.valueBlock.valueHexView);
  }

  return null;
};

/** id-ce-subjectKeyIdentifier */
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';

/** The certificate a SignerInfo names, by issuer and serial or by key identifier. */
const signerCertificate = (signedData: pkijs.SignedData, signer: pkijs.SignerInfo): pkijs.Certificate | null => {
  const certificates = (signedData.certificates ?? []).filter(
    (candidate): candidate is pkijs.Certificate => candidate instanceof pkijs.Certificate,
  );

  if (signer.sid instanceof pkijs.IssuerAndSerialNumber) {
    const { issuer, serialNumber } = signer.sid;

    return (
      certificates.find(
        (candidate) => candidate.issuer.isEqual(issuer) && candidate.serialNumber.isEqual(serialNumber),
      ) ?? null
    );
  }

  const keyId = subjectKeyIdentifier(signer.sid);

  if (!keyId) {
    return null;
  }

  return (
    certificates.find((candidate) => {
      const extension = candidate.extensions?.find((entry) => entry.extnID === OID_SUBJECT_KEY_IDENTIFIER);
      const parsed = extension?.parsedValue;

      return parsed instanceof asn1js.OctetString && equal(new Uint8Array(parsed.valueBlock.valueHexView), keyId);
    }) ?? null
  );
};

/**
 * The digest a timestamp token says it was issued over.
 *
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint MessageImprint, ... }
 * and MessageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }.
 * So the imprint is the third element of TSTInfo, and the two we want are its
 * only members.
 */
const timestampImprint = (signedData: pkijs.SignedData): { algorithm: string; digest: Uint8Array } | null => {
  const eContent = signedData.encapContentInfo?.eContent;

  if (!eContent) {
    return null;
  }

  const hex = eContent.valueBlock.valueHexView;
  const parsed = asn1js.fromBER(hex.buffer.slice(hex.byteOffset, hex.byteOffset + hex.byteLength));

  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    return null;
  }

  const imprint = parsed.result.valueBlock.value[2];

  if (!(imprint instanceof asn1js.Sequence)) {
    return null;
  }

  const [algorithmId, hashed] = imprint.valueBlock.value;

  if (!(algorithmId instanceof asn1js.Sequence) || !(hashed instanceof asn1js.OctetString)) {
    return null;
  }

  const oid = algorithmId.valueBlock.value[0];

  if (!(oid instanceof asn1js.ObjectIdentifier)) {
    return null;
  }

  const algorithm = DIGEST_NAMES_BY_OID[oid.valueBlock.toString()];

  return algorithm ? { algorithm, digest: new Uint8Array(hashed.valueBlock.valueHexView) } : null;
};

/** /Contents is a hex string in every PDF signature in practice. */
const toBytes = (contents: { value?: string; bytes?: Uint8Array } | undefined): Uint8Array | null => {
  if (contents?.bytes instanceof Uint8Array) {
    return withoutPadding(contents.bytes);
  }

  if (typeof contents?.value !== 'string') {
    return null;
  }

  const hex = contents.value.replace(/[^0-9a-f]/gi, '');

  if (hex.length < 2) {
    return null;
  }

  const bytes = new Uint8Array(Math.floor(hex.length / 2));

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return withoutPadding(bytes);
};

/**
 * The /Contents hole is padded with zeroes to a fixed size. Cut it at the
 * length the DER header gives, since the signature itself can end in a zero
 * byte and trimming every trailing zero would truncate it.
 */
const withoutPadding = (bytes: Uint8Array): Uint8Array => {
  const first = bytes[1] ?? 0;
  const lengthBytes = first & 0x7f;

  if (first < 0x80) {
    return bytes.subarray(0, Math.min(bytes.length, 2 + first));
  }

  // Indefinite length (BER): the parser finds the end itself.
  if (first === 0x80) {
    return bytes;
  }

  let length = 0;

  for (let index = 0; index < lengthBytes; index += 1) {
    length = length * 256 + (bytes[2 + index] ?? 0);
  }

  return bytes.subarray(0, Math.min(bytes.length, 2 + lengthBytes + length));
};

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);
