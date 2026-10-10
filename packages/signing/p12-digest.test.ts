import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DigestAlgorithm, Signer } from '@libpdf/core';
import { P12Signer, PDF } from '@libpdf/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSigningCredential } from './helpers/csc-test-support';
import { assertSignerHonoursDigest } from './helpers/digest-guard';

/**
 * These tests exist because @libpdf/core 0.4.2 signs with SHA-256 whatever
 * digest it declares. WebCrypto binds the digest to an RSA key at import, and
 * `P12Signer.importPrivateKey` imported every RSA key under SHA-256, so a
 * SHA-384 or SHA-512 signature named an algorithm it had not used. Nothing
 * threw and the returned warnings array was empty. The fix ships as
 * `patches/@libpdf+core+0.4.2.patch`.
 *
 * The assertions here go through `openssl cms -verify` rather than through
 * libpdf's own verifier, because the failure the bug produces is one an
 * independent verifier sees and the producing library does not.
 */

const DIGESTS: DigestAlgorithm[] = ['SHA-256', 'SHA-384', 'SHA-512'];

const OPENSSL_DIGEST_NAMES: Record<DigestAlgorithm, string> = {
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

let workDir = '';
let p12Bytes = new Uint8Array();
let unsignedPdf = new Uint8Array();

const openssl = (args: string[]) =>
  execFileSync('openssl', args, { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The DER object at the start of `bytes`, its tag and length header included. */
const derPrefix = (bytes: Buffer) => {
  const first = bytes[1];

  if (first < 0x80) {
    return bytes.subarray(0, 2 + first);
  }

  const lengthBytes = first & 0x7f;
  const length = bytes.subarray(2, 2 + lengthBytes).reduce((total, byte) => total * 256 + byte, 0);

  return bytes.subarray(0, 2 + lengthBytes + length);
};

/**
 * Pull the CMS blob and the bytes it covers out of a signed PDF, the way any
 * verifier does: read /ByteRange, join the two covered spans, and hex-decode
 * /Contents up to the length its DER header declares. The rest is the zero
 * padding libpdf leaves in the placeholder; stripping trailing zeros instead
 * would also cut a CMS whose last byte is 0x00.
 */
const extractSignature = (signed: Uint8Array) => {
  const buffer = Buffer.from(signed);
  const text = buffer.toString('latin1');

  const byteRange = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  const contents = /\/Contents\s*<([0-9A-Fa-f]+)>/.exec(text);

  if (!byteRange || !contents) {
    throw new Error('Signed PDF has no /ByteRange or /Contents');
  }

  const [start, firstLength, secondStart, secondLength] = byteRange.slice(1).map(Number);

  return {
    signedBytes: Buffer.concat([
      buffer.subarray(start, start + firstLength),
      buffer.subarray(secondStart, secondStart + secondLength),
    ]),
    cms: derPrefix(Buffer.from(contents[1], 'hex')),
  };
};

/**
 * Read the digest algorithm the CMS declares, in both the places a verifier
 * looks: the SignedData digestAlgorithms set and the SignerInfo. A regression
 * that silently downgrades the signature back to SHA-256 leaves these saying
 * SHA-384, so comparing them against what was asked for catches it.
 */
const declaredDigests = (cmsPath: string) => {
  const printed = openssl(['cms', '-cmsout', '-inform', 'DER', '-in', cmsPath, '-print']);
  const lines = printed.split('\n');

  const readAlgorithmAfter = (label: string) => {
    const index = lines.findIndex((line) => line.trim() === label);

    if (index === -1) {
      throw new Error(`CMS structure has no ${label} entry`);
    }

    const algorithm = /algorithm:\s*(\S+)/.exec(lines[index + 1] ?? '');

    if (!algorithm) {
      throw new Error(`No algorithm found under ${label}`);
    }

    return algorithm[1];
  };

  return {
    signedData: readAlgorithmAfter('digestAlgorithms:'),
    signerInfo: readAlgorithmAfter('digestAlgorithm:'),
  };
};

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'documenso-p12-digest-'));

  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    'key.pem',
    '-out',
    'cert.pem',
    '-days',
    '2',
    '-nodes',
    '-subj',
    '/CN=Documenso Signing Digest Test',
    '-addext',
    'keyUsage=critical,digitalSignature,nonRepudiation',
  ]);

  openssl(['pkcs12', '-export', '-out', 'test.p12', '-inkey', 'key.pem', '-in', 'cert.pem', '-passout', 'pass:']);

  p12Bytes = new Uint8Array(fs.readFileSync(path.join(workDir, 'test.p12')));
  const pdf = PDF.create();
  pdf.addPage({ size: 'a4' });
  unsignedPdf = await pdf.save();
}, 60_000);

afterAll(() => {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

const createSigner = async () => await P12Signer.create(p12Bytes, '', { buildChain: false });

describe('extractSignature', () => {
  it('keeps a CMS whose last byte is zero', () => {
    // A SEQUENCE of one INTEGER 0, ending 0x00, then the placeholder's padding.
    const pdf = Buffer.from('/ByteRange [0 1 2 1] /Contents <3003020100000000>', 'latin1');

    expect(extractSignature(pdf).cms.toString('hex')).toBe('3003020100');
  });

  it('reads a long-form length', () => {
    const cms = `3081830281800${'0'.repeat(255)}`;
    const pdf = Buffer.from(`/ByteRange [0 1 2 1] /Contents <${cms}0000>`, 'latin1');

    expect(extractSignature(pdf).cms.toString('hex')).toBe(cms);
  });
});

describe('P12 signatures verify under the digest they declare', () => {
  it.each(DIGESTS)('%s produces a CMS an independent verifier accepts', async (digestAlgorithm) => {
    const signer = await createSigner();
    const pdf = await PDF.load(unsignedPdf);

    const { bytes, warnings } = await pdf.sign({ signer, digestAlgorithm });

    expect(warnings).toEqual([]);

    const { signedBytes, cms } = extractSignature(bytes);

    const cmsPath = path.join(workDir, 'signature.der');
    const contentPath = path.join(workDir, 'content.bin');

    fs.writeFileSync(cmsPath, cms);
    fs.writeFileSync(contentPath, signedBytes);

    // -purpose any because the test certificate carries no extended key usage.
    // Everything else is the default verification an outside party performs.
    expect(() =>
      openssl([
        'cms',
        '-verify',
        '-binary',
        '-inform',
        'DER',
        '-in',
        cmsPath,
        '-content',
        contentPath,
        '-CAfile',
        'cert.pem',
        '-purpose',
        'any',
        '-out',
        os.devNull,
      ]),
    ).not.toThrow();

    // If the signature is ever computed under a weaker digest than the one it
    // names, this is what still says SHA-384 while the bytes say otherwise.
    expect(declaredDigests(cmsPath)).toEqual({
      signedData: OPENSSL_DIGEST_NAMES[digestAlgorithm],
      signerInfo: OPENSSL_DIGEST_NAMES[digestAlgorithm],
    });
  }, 30_000);
});

describe('assertSignerHonoursDigest', () => {
  /**
   * A signer that ignores the digest it is handed and always uses SHA-256,
   * which is the shape of the @libpdf/core 0.4.2 bug.
   */
  const createLyingSigner = (certificate: Uint8Array): Signer => ({
    certificate,
    certificateChain: [],
    keyType: 'RSA',
    signatureAlgorithm: 'RSASSA-PKCS1-v1_5',
    sign: (data: Uint8Array) => {
      const privateKey = fs.readFileSync(path.join(workDir, 'key.pem'), 'utf8');

      return Promise.resolve(new Uint8Array(createSign('sha256').update(data).sign(privateKey)));
    },
  });

  it('accepts a signer that signs with the digest it was asked for', async () => {
    const signer = await createSigner();

    await expect(assertSignerHonoursDigest(signer, 'SHA-384')).resolves.toBeUndefined();
  });

  it('rejects a signer whose signature does not verify under the requested digest', async () => {
    const signer = await createSigner();
    const lying = createLyingSigner(signer.certificate);

    await expect(assertSignerHonoursDigest(lying, 'SHA-384')).rejects.toThrow(/does not verify under SHA-384/);
  });

  it('accepts the same lying signer when SHA-256 is what was asked for', async () => {
    const signer = await createSigner();
    const lying = createLyingSigner(signer.certificate);

    await expect(assertSignerHonoursDigest(lying, 'SHA-256')).resolves.toBeUndefined();
  });

  /**
   * The PSS refusal. @libpdf/core writes a PKCS#1 v1.5 OID for every RSA key
   * and no PSS parameters, so a PSS signature is embedded under a label that
   * does not describe it. This guard used to verify one with PSS padding and
   * pass it through, which is how a document nobody can validate would have got
   * out of a build whose whole purpose is to stop that.
   */
  it('refuses a signer that announces RSA-PSS, which this library cannot declare', async () => {
    const signer = await createSigner();
    // `sign` is carried over explicitly: spreading the class instance leaves
    // the method on the prototype, so the spread alone does not satisfy Signer.
    const pss: Signer = {
      certificate: signer.certificate,
      certificateChain: signer.certificateChain ?? [],
      keyType: signer.keyType,
      signatureAlgorithm: 'RSA-PSS',
      sign: (data, digest) => signer.sign(data, digest),
    };

    await expect(assertSignerHonoursDigest(pss, 'SHA-384')).rejects.toThrow(/cannot declare RSA-PSS/);
  });

  it('refuses a certificate whose key is restricted to RSA-PSS, whatever the signer announces', async () => {
    // The same hole through a different door. A SubjectPublicKeyInfo carrying
    // id-RSASSA-PSS pins the key to PSS no matter what the signer claims, and
    // Node reports the type as rsa-pss.
    const credential = await createTestSigningCredential('rsa-pss-restricted');

    const restricted: Signer = {
      certificate: credential.certificateDer,
      certificateChain: [],
      keyType: 'RSA',
      signatureAlgorithm: 'RSASSA-PKCS1-v1_5',
      sign: () => Promise.reject(new Error('the guard must refuse before it asks for a signature')),
    };

    await expect(assertSignerHonoursDigest(restricted, 'SHA-256')).rejects.toThrow(/cannot declare RSA-PSS/);
  });
});
