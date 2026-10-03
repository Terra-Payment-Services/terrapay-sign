import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as asn1js from 'asn1js';
import { describe, expect, it } from 'vitest';

import { TimestampVerificationError, verifyTimestampToken } from './verify';

/**
 * Against a real token, recorded from Sectigo on 15 September 2026, rather
 * than one this code produced itself.
 *
 * A verifier tested only against its own idea of a token proves nothing: the
 * defect being guarded against is that @libpdf/core accepts anything
 * ASN.1-shaped, and a home-made fixture would share whatever assumptions the
 * verifier makes. The recorded pair also pins two real-world details that both
 * broke this on the way in: Sectigo signs its attributes under SHA-384 while
 * the imprint is SHA-256, and the SignerInfo names bare rsaEncryption, which
 * carries no hash at all.
 */
const FIXTURES = path.join(__dirname, '__fixtures__');

const read = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

/** The digest and nonce actually sent, read back out of the recorded request. */
const request = () => {
  const fields = (asn1js.fromBER(read('request.tsq').buffer as ArrayBuffer).result as asn1js.Sequence).valueBlock.value;
  const imprint = fields[1] as asn1js.Sequence;

  return {
    digest: new Uint8Array((imprint.valueBlock.value[1] as asn1js.OctetString).valueBlock.valueHexView),
    nonce: new Uint8Array((fields[2] as asn1js.Integer).valueBlock.valueHexView),
  };
};

/** The token, unwrapped from the recorded TimeStampResp. */
const token = () => {
  const response = asn1js.fromBER(read('response.tsr').buffer as ArrayBuffer).result as asn1js.Sequence;

  return new Uint8Array(response.valueBlock.value[1].toBER(false));
};

/** The fixture is fixed in time, so "now" has to be too. */
const now = new Date('2026-09-15T14:00:00Z');

describe('verifyTimestampToken', () => {
  it('accepts a real token for the request that produced it', async () => {
    const { digest, nonce } = request();

    const { genTime } = await verifyTimestampToken({
      token: token(),
      digest,
      digestAlgorithm: 'SHA-256',
      nonce,
      now,
    });

    expect(genTime.toISOString()).toBe('2026-09-15T13:02:10.000Z');
  });

  it('refuses a token made for a different document', async () => {
    // The whole point. A valid timestamp over a different document is still a
    // valid timestamp, and embedding it would claim it covers ours.
    const { nonce } = request();
    const other = new Uint8Array(32).fill(7);

    await expect(
      verifyTimestampToken({ token: token(), digest: other, digestAlgorithm: 'SHA-256', nonce, now }),
    ).rejects.toThrow(/over a different digest/);
  });

  it('refuses a token that answers a different request', async () => {
    const { digest } = request();

    await expect(
      verifyTimestampToken({
        token: token(),
        digest,
        digestAlgorithm: 'SHA-256',
        nonce: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        now,
      }),
    ).rejects.toThrow(/nonce that does not match/);
  });

  it('refuses a token whose imprint algorithm is not the one requested', async () => {
    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({ token: token(), digest, digestAlgorithm: 'SHA-512', nonce, now }),
    ).rejects.toThrow(/but SHA-512 was requested/);
  });

  it('refuses a token whose signature has been tampered with', async () => {
    // Flip a byte late in the token, inside the signature rather than the
    // structure, so it still parses and only the cryptography catches it.
    const tampered = token();

    tampered[tampered.length - 20] ^= 0xff;

    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({ token: tampered, digest, digestAlgorithm: 'SHA-256', nonce, now }),
    ).rejects.toThrow(TimestampVerificationError);
  });

  it('refuses bytes that are not a token at all', async () => {
    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({
        token: new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
        digest,
        digestAlgorithm: 'SHA-256',
        nonce,
        now,
      }),
    ).rejects.toThrow(TimestampVerificationError);
  });

  it('refuses a token dated in the future', async () => {
    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({
        token: token(),
        digest,
        digestAlgorithm: 'SHA-256',
        nonce,
        now: new Date('2020-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/claims a time in the future/);
  });
});
