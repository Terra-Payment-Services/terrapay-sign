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
const request = (name = 'request.tsq') => {
  const fields = (asn1js.fromBER(read(name).buffer as ArrayBuffer).result as asn1js.Sequence).valueBlock.value;
  const imprint = fields[1] as asn1js.Sequence;

  return {
    digest: new Uint8Array((imprint.valueBlock.value[1] as asn1js.OctetString).valueBlock.valueHexView),
    nonce: new Uint8Array((fields[2] as asn1js.Integer).valueBlock.valueHexView),
  };
};

/** The token, unwrapped from the recorded TimeStampResp. */
const token = (name = 'response.tsr') => {
  const response = asn1js.fromBER(read(name).buffer as ArrayBuffer).result as asn1js.Sequence;

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

/**
 * The keys production pins: the roots of the two authorities it uses. Taken
 * from the chains the authorities return, with
 * `openssl x509 -pubkey | openssl pkey -pubin -outform DER | sha256sum`.
 */
const SECTIGO_ROOT_R46 = 'a4db8668c6796ebf476ddc5ace453a9260dbd4dbb09f51ecec9a839003824795';
const DIGICERT_ROOT_G4 = '59df317bfa9f4f0ab7ca514d7772296aa2c765b87664d08b96e57399e364729c';

describe('verifyTimestampToken with pinned keys', () => {
  it('accepts a Sectigo token that chains to the pinned Sectigo root', async () => {
    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({
        token: token(),
        digest,
        digestAlgorithm: 'SHA-256',
        nonce,
        now,
        pinnedKeySha256: [DIGICERT_ROOT_G4, SECTIGO_ROOT_R46],
      }),
    ).resolves.toMatchObject({ genTime: expect.any(Date) });
  });

  it('accepts a DigiCert token, recorded 3 October 2026, that chains to the pinned DigiCert root', async () => {
    const { digest, nonce } = request('digicert-request.tsq');

    const { genTime } = await verifyTimestampToken({
      token: token('digicert-response.tsr'),
      digest,
      digestAlgorithm: 'SHA-256',
      nonce,
      now: new Date('2026-10-03T05:00:00Z'),
      pinnedKeySha256: [SECTIGO_ROOT_R46, DIGICERT_ROOT_G4],
    });

    expect(genTime.toISOString()).toBe('2026-10-03T04:07:05.000Z');
  });

  it('refuses a valid token whose signer chains to no pinned key', async () => {
    // A well-formed token from a real authority, refused only because that
    // authority is not one we chose. This is the case an impersonator is in.
    const { digest, nonce } = request();

    await expect(
      verifyTimestampToken({
        token: token(),
        digest,
        digestAlgorithm: 'SHA-256',
        nonce,
        now,
        pinnedKeySha256: [DIGICERT_ROOT_G4],
      }),
    ).rejects.toThrow(/does not chain to a pinned key/);
  });
});
