import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PdfRef } from '@libpdf/core';
import { PDF } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { signer } from './__fixtures__/protected-pdfs';
import { rawSignatureContents } from './__fixtures__/signature-bytes';

/**
 * Characterisation of @libpdf/core 0.4.2 as patched by
 * `patches/@libpdf+core+0.4.2.patch`, through its public API only.
 *
 * Pinned: once an owner-protected (encrypted, opens without a password) PDF is
 * loaded and a signer has read its pages, form fields and signature
 * dictionary, an incremental save appends nothing for what was only read. The
 * patch hunk in `DocumentParser` that clears dirty flags after decryption is
 * what makes that true. Without it every decrypted object is written again,
 * the signature dictionary among them, and its /Contents goes out
 * re-encrypted, which poppler's pdfsig no longer reports as a valid signature.
 * Run against an unpatched 0.4.2 both tests here fail.
 *
 * Only AES-256 is covered. `setProtection` in 0.4.2 throws "Only AES-256
 * encryption is supported for new documents" for RC4-128 and AES-128, and no
 * other tool that could produce them is part of this toolchain.
 *
 * Reading the signature dictionary makes libpdf log "Failed to decrypt object
 * N 0" with a stack trace. The signature /Contents is stored unencrypted, so
 * decrypting it fails; libpdf logs that and keeps the raw bytes. It is
 * expected output, not a failure.
 */

const TEXT_FIELD = 'name';

const signedOwnerProtectedPdfWithTextField = async () => {
  const doc = PDF.create();
  doc.addPage({ size: 'a4' });
  doc.getOrCreateForm().createTextField(TEXT_FIELD);
  doc.setProtection({ ownerPassword: 'owner-only', permissions: { modify: false }, algorithm: 'AES-256' });

  const protectedPdf = await PDF.load(await doc.save());
  const { bytes } = await protectedPdf.sign({ signer: await signer(), subFilter: 'ETSI.CAdES.detached' });

  return Buffer.from(bytes);
};

/** Everything a signer looks at before adding its own signature. */
const loadAndReadEverything = async (bytes: Uint8Array) => {
  const doc = await PDF.load(bytes);

  for (const page of doc.getPages()) {
    expect(page.width).toBeGreaterThan(0);
    expect(page.height).toBeGreaterThan(0);
  }

  const form = doc.getForm();

  for (const field of form?.getFields() ?? []) {
    field.getValue();
  }

  for (const field of form?.getSignatureFields() ?? []) {
    expect(field.isSigned()).toBe(true);

    const dict = field.getSignatureDict();

    expect(dict?.get('Contents')).toBeDefined();
    expect(dict?.get('ByteRange')).toBeDefined();
    expect(dict?.get('SubFilter')).toBeDefined();
  }

  return doc;
};

/**
 * The object numbers an incremental save appended, read from the raw bytes of
 * the new revision. A cross-reference stream is bookkeeping rather than a
 * re-emitted object, so it is left out.
 */
const objectsAppended = (input: Buffer, output: Buffer) => {
  expect(output.subarray(0, input.length).equals(input)).toBe(true);

  const revision = output.subarray(input.length).toString('latin1');

  return [...revision.matchAll(/(\d+) \d+ obj([\s\S]*?)endobj/g)]
    .filter(([, , body]) => !/\/Type\s*\/XRef\b/.test(body))
    .map(([, objectNumber]) => Number(objectNumber));
};

const signatureObjectNumber = (doc: PDF) => {
  const field = doc.getForm()?.getSignatureFields()[0];

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return (field?.getDict().get('V') as PdfRef).objectNumber;
};

/** poppler's verdict, or null where pdfsig is not installed (the CI image has none). */
const pdfsigVerdict = (bytes: Buffer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-protected-incremental-'));
  const file = path.join(dir, 'document.pdf');

  try {
    fs.writeFileSync(file, bytes);

    return execFileSync('pdfsig', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const failure = error as NodeJS.ErrnoException & { stdout?: string };

    if (failure.code === 'ENOENT') {
      console.warn('pdfsig not installed; skipping the poppler check');

      return null;
    }

    // pdfsig exits non-zero when a signature does not verify; its verdict is still on stdout.
    if (typeof failure.stdout === 'string') {
      return failure.stdout;
    }

    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('incremental save of a signed owner-protected (AES-256) PDF', () => {
  it('appends no object when every object was only read', async () => {
    const input = await signedOwnerProtectedPdfWithTextField();
    const doc = await loadAndReadEverything(input);

    const output = Buffer.from(await doc.save({ incremental: true }));

    expect(objectsAppended(input, output)).toEqual([]);
  });

  it('appends the edited field and leaves the existing signature untouched', async () => {
    const input = await signedOwnerProtectedPdfWithTextField();
    const doc = await loadAndReadEverything(input);
    const signatureObject = signatureObjectNumber(doc);
    const signatureBefore = rawSignatureContents(input, signatureObject);
    const textField = doc.getForm()?.getTextField(TEXT_FIELD);

    textField?.setValue('Ada Lovelace');

    const output = Buffer.from(await doc.save({ incremental: true }));
    const appended = objectsAppended(input, output);

    expect(appended).toContain(textField?.getRef()?.objectNumber);
    expect(appended).not.toContain(signatureObject);
    expect(signatureBefore).toMatch(/^[0-9A-F]{64,}$/);
    expect(rawSignatureContents(output, signatureObject)).toBe(signatureBefore);
    expect((await PDF.load(output)).getForm()?.getTextField(TEXT_FIELD)?.getValue()).toBe('Ada Lovelace');

    const verdict = pdfsigVerdict(output);

    if (verdict !== null) {
      expect(verdict).toContain('Signature Validation: Signature is Valid.');
    }
  });
});
