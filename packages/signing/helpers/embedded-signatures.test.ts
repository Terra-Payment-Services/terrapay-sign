import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { EmbeddedSignatureBrokenError, inspectEmbeddedSignatures } from './embedded-signatures';

/**
 * The fixture is a real document signed by somebody else, which is the only
 * kind that matters here. The tests are written as the operations that
 * actually reach storage in this codebase rather than as abstract mutations,
 * because a review found four separate routes doing them and the point of
 * this check is that it does not care which route it was.
 */
const fixture = readFileSync(path.join(__dirname, '../../lib/server-only/pdf/__fixtures__/externally-signed.pdf'));

const original = () => new Uint8Array(fixture);

/**
 * One of ours, sealed the way we seal everything at B-LT and above: an
 * ordinary CAdES signature followed by an RFC 3161 document timestamp in an
 * incremental update. Committed rather than produced on demand so the check
 * runs without reaching a timestamp authority.
 */
const timestampedFixture = readFileSync(
  path.join(__dirname, '../../lib/server-only/pdf/__fixtures__/timestamped-signature.pdf'),
);

const timestamped = () => new Uint8Array(timestampedFixture);

describe('inspectEmbeddedSignatures', () => {
  it('finds the counterparty signature intact in the document as received', async () => {
    expect(await inspectEmbeddedSignatures(original())).toEqual({ checked: 1, intact: 1, skipped: [] });
  });

  it('accepts an incremental save, which is what preserving a signature means', async () => {
    const doc = await PDF.load(original());

    doc.flattenAll({ form: { skipSignatures: true } });

    const saved = await doc.save({ incremental: true });

    expect(await inspectEmbeddedSignatures(saved)).toEqual({ checked: 1, intact: 1, skipped: [] });
  });

  it('refuses a full rewrite, which is what placeholder removal does', async () => {
    // removePlaceholdersFromPDF draws over the page and calls a bare save().
    // Skipping signature fields on the flatten is not enough: the field
    // survives and still reports isSigned, while every byte offset moves.
    const doc = await PDF.load(original());

    doc.flattenAll({ form: { skipSignatures: true } });

    const saved = await doc.save();

    await expect(inspectEmbeddedSignatures(saved)).rejects.toThrow(EmbeddedSignatureBrokenError);
  });

  it('refuses a rewrite with an xref stream, which is what the AES path does', async () => {
    // The AES path flattens first and then saves with an xref stream. Saving
    // an untouched document does not necessarily rewrite it, so the mutation
    // is part of the shape being tested.
    const doc = await PDF.load(original());

    doc.flattenAll({ form: { skipSignatures: true } });

    const saved = await doc.save({ useXRefStream: true });

    await expect(inspectEmbeddedSignatures(saved)).rejects.toThrow(/rewritten after it was signed/);
  });

  it('says nothing about a document that carries no signature', async () => {
    const unsigned = readFileSync(path.join(__dirname, '../../lib/server-only/pdf/__fixtures__/unsigned.pdf'));

    expect(await inspectEmbeddedSignatures(new Uint8Array(unsigned))).toEqual({
      checked: 0,
      intact: 0,
      skipped: [],
    });
  });

  it('does not accuse a file that simply will not parse', async () => {
    // A corrupt upload is rejected elsewhere, with a message about the file.
    // Reporting it as a broken signature would send the reader somewhere else
    // entirely.
    const report = await inspectEmbeddedSignatures(new Uint8Array([1, 2, 3, 4]));

    expect(report.checked).toBe(0);
    expect(report.skipped).toEqual(['document did not load']);
  });

  it('catches a single byte changed under the signature', async () => {
    // The narrowest case. Everything above alters the structure; this proves
    // the check is on the covered content rather than on the offsets.
    //
    // The byte has to sit inside a covered span. /ByteRange on this fixture is
    // [0, 1104, 25682, 666], so the middle of the file is the /Contents hole,
    // which is excluded by design and changing it proves nothing.
    const tampered = original();

    tampered[500] = tampered[500] === 0x41 ? 0x42 : 0x41;

    await expect(inspectEmbeddedSignatures(tampered)).rejects.toThrow(EmbeddedSignatureBrokenError);
  });

  // A document timestamp records the digest of the bytes it covers in the
  // imprint inside its TSTInfo. Its CMS signed attributes cover that TSTInfo
  // rather than the PDF, so reading the message-digest attribute and comparing
  // it to the covered bytes calls every timestamped document broken. Sealing
  // stores the document it has just signed, so with a timestamp authority
  // configured this refused everything: the seal job failed, retried, exhausted
  // its retries, and the envelope stayed PENDING with no sealed PDF.
  it('accepts a document timestamp by checking the imprint it actually carries', async () => {
    expect(await inspectEmbeddedSignatures(timestamped())).toEqual({ checked: 2, intact: 2, skipped: [] });
  });

  it('still catches a rewrite under a timestamped signature', async () => {
    const rewritten = timestamped();

    // Inside the second covered span of the first signature, so both the
    // signature and the timestamp over it are made to disagree with the file.
    rewritten[66_500] = rewritten[66_500] ^ 0xff;

    await expect(inspectEmbeddedSignatures(rewritten)).rejects.toThrow(EmbeddedSignatureBrokenError);
  });

  it('ignores a change inside the signature hole, which is not covered', async () => {
    // The other side of the same coin, so the test above is not passing by
    // accident. The bytes between the two covered spans hold the signature
    // itself and are excluded from what it hashes.
    const inHole = original();

    inHole[13000] = inHole[13000] === 0x41 ? 0x42 : 0x41;

    expect(await inspectEmbeddedSignatures(inHole)).toEqual({ checked: 1, intact: 1, skipped: [] });
  });
});
