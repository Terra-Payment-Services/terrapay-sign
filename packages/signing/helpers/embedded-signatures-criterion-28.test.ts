import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { P12Signer, PDF } from '@libpdf/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertEmbeddedSignaturesIntact, EmbeddedSignatureBrokenError } from './embedded-signatures';

/**
 * Criterion 28 (F24), isolated: E2E cannot reach it, because the arrival
 * check already refuses such files before they reach storage.
 *
 * Written from the specification and the export's signature and JSDoc only.
 *
 * A signature whose signer certificate and algorithm are known but whose
 * signature value cannot be decoded, here a malformed ECDSA value, is broken,
 * not unevaluable. The storage and seal check must refuse it.
 *
 * Failure modes:
 * - F24: decoding the value throws, the signature is recorded as skipped, and
 *   the call resolves.
 * - False refusal: a valid ECDSA P-256 signature is refused (the control).
 * - The corruption reaches the covered bytes, so a digest mismatch, not the
 *   undecodable value, causes the refusal. Guarded by the precondition that
 *   the bytes the /ByteRange covers are unchanged.
 * - The fixture is not ECDSA, or the corruption did not take. Guarded by the
 *   preconditions on the CMS algorithm and on pdfsig.
 * - A generic error is thrown instead of the documented
 *   EmbeddedSignatureBrokenError.
 *
 * The ECDSA P-256 key and certificate are made by openssl for each run and
 * signed with by @libpdf/core. No mocks.
 */

const UNSIGNED_PDF = path.join(__dirname, '../../lib/server-only/pdf/__fixtures__/unsigned.pdf');

/** ecdsa-with-SHA256, 1.2.840.10045.4.3.2, as DER. */
const ECDSA_WITH_SHA256_OID = Buffer.from('06082a8648ce3d040302', 'hex');

let workDir: string;
let validSigned: Buffer;
let corrupted: Buffer;

const byteRange = (bytes: Buffer) => {
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(bytes.toString('latin1'));

  if (!match) {
    throw new Error('no /ByteRange');
  }

  const [a, b, c, d] = match.slice(1).map(Number);

  return {
    a,
    b,
    c,
    covered: Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]),
    contents: Buffer.from(bytes.subarray(a + b + 1, c - 1).toString('latin1'), 'hex'),
  };
};

const derLength = (der: Buffer) => {
  if (der[1] < 0x80) {
    return 2 + der[1];
  }

  const lengthBytes = der[1] & 0x7f;

  return 2 + lengthBytes + der.subarray(2, 2 + lengthBytes).reduce((total, byte) => total * 256 + byte, 0);
};

/**
 * Find the SignerInfo signature value: the last element of the CMS, an OCTET
 * STRING wrapping the ECDSA SEQUENCE { r, s }.
 */
const locateEcdsaSignatureValue = (der: Buffer, end: number) => {
  for (let length = 0x40; length <= 0x50; length++) {
    const start = end - length;

    if (der[start - 2] === 0x04 && der[start - 1] === length && der[start] === 0x30 && der[start + 1] === length - 2) {
      return { start, length };
    }
  }

  throw new Error('no ECDSA signature value at the end of the CMS');
};

const pdfsigValidation = (bytes: Buffer) => {
  const file = path.join(workDir, `pdfsig-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

  fs.writeFileSync(file, bytes);

  const { stdout } = spawnSync('pdfsig', [file], { encoding: 'utf8' });

  return /- Signature Validation: (.*)$/m.exec(stdout)?.[1]?.trim() ?? '';
};

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'criterion-28-'));

  const key = path.join(workDir, 'key.pem');
  const cert = path.join(workDir, 'cert.pem');
  const p12 = path.join(workDir, 'ecdsa.p12');

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '30',
      '-subj',
      '/CN=Counterparty ECDSA',
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      key,
      '-in',
      cert,
      '-out',
      p12,
      '-passout',
      'pass:',
      '-keypbe',
      'AES-256-CBC',
      '-certpbe',
      'AES-256-CBC',
      '-macalg',
      'sha256',
    ],
    { stdio: 'pipe' },
  );

  const signer = await P12Signer.create(new Uint8Array(fs.readFileSync(p12)), '');
  const doc = await PDF.load(new Uint8Array(fs.readFileSync(UNSIGNED_PDF)));
  const { bytes } = await doc.sign({ signer, fieldName: 'CounterpartySignature' });

  validSigned = Buffer.from(bytes);

  // Replace the ECDSA value with 0xFF bytes of the same length: no longer a
  // DER SEQUENCE, so it cannot be decoded, while the CMS keeps its length.
  const { a, b, contents } = byteRange(validSigned);
  const end = derLength(contents);
  const { start, length } = locateEcdsaSignatureValue(contents, end);
  const broken = Buffer.from(contents);

  broken.fill(0xff, start, start + length);
  corrupted = Buffer.from(validSigned);
  corrupted.write(broken.toString('hex').toUpperCase(), a + b + 1, 'latin1');
}, 60_000);

describe('criterion 28: an undecodable ECDSA signature value is broken, not skipped', () => {
  it('fixture preconditions: ECDSA, covered bytes unchanged, pdfsig rejects only the corrupted file', () => {
    const valid = byteRange(validSigned);
    const bad = byteRange(corrupted);

    expect(valid.contents.includes(ECDSA_WITH_SHA256_OID), 'the CMS is signed with ecdsa-with-SHA256').toBe(true);
    expect(corrupted.length, 'same length').toBe(validSigned.length);
    expect(bad.covered.equals(valid.covered), 'every byte the /ByteRange covers is unchanged').toBe(true);
    expect(bad.contents.equals(valid.contents), 'the /Contents changed').toBe(false);
    expect(pdfsigValidation(validSigned), 'pdfsig verifies the valid file').toBe('Signature is Valid.');
    expect(pdfsigValidation(corrupted), 'pdfsig does not verify the corrupted file').not.toBe('Signature is Valid.');
  });

  it('control: the valid ECDSA-signed file passes, with nothing skipped', async () => {
    const report = await assertEmbeddedSignaturesIntact(new Uint8Array(validSigned));

    expect(report.checked).toBe(1);
    expect(report.intact).toBe(1);
    expect(report.skipped).toEqual([]);
  });

  it('criterion_28_malformed_ecdsa_signature_value_throws_embedded_signature_broken_error', async () => {
    const outcome = await assertEmbeddedSignaturesIntact(new Uint8Array(corrupted)).then(
      (report) => ({ resolved: report }),
      (error: unknown) => ({ rejected: error }),
    );

    expect('rejected' in outcome, `the check must refuse it; it resolved with ${JSON.stringify(outcome)}`).toBe(true);
    expect((outcome as { rejected: unknown }).rejected).toBeInstanceOf(EmbeddedSignatureBrokenError);
  });
});
