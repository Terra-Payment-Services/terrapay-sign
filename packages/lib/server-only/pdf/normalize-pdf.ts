import {
  assertEmbeddedSignaturesIntact,
  EmbeddedSignatureBrokenError,
} from '@documenso/signing/helpers/embedded-signatures';
import { PDF } from '@libpdf/core';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { inspectExistingSignatures } from './existing-signatures';

export type NormalizePdfOptions = {
  flattenForm?: boolean;

  /**
   * Allow a document that arrived already signed by someone else to be
   * flattened and re-serialised, which destroys those signatures.
   *
   * Defaults to `false`. Leave it alone unless the caller genuinely wants a
   * flat copy and has told the user the signatures will be lost.
   */
  allowSignatureDestruction?: boolean;
};

/**
 * Flatten an uploaded PDF for storage, keeping any signature it arrived with.
 *
 * The file is parsed once. The arrival signature check reads that same
 * document before flattening modifies it.
 */
export const normalizePdf = async (pdf: Buffer, options: NormalizePdfOptions = {}) => {
  const shouldFlattenForm = options.flattenForm ?? true;
  const allowSignatureDestruction = options.allowSignatureDestruction ?? false;

  const pdfDoc = await PDF.load(pdf).catch((e) => {
    console.error(`PDF normalization error: ${e.message}`);

    throw new AppError('INVALID_DOCUMENT_FILE', {
      message: 'The document is not a valid PDF',
    });
  });

  // A file that opens without a password but carries owner restrictions is
  // still encrypted, and is what Adobe and DocuSign commonly return once
  // somebody has signed. It is kept encrypted: removing the protection means a
  // full rewrite, which breaks any signature already on it.
  if (pdfDoc.isEncrypted && !pdfDoc.isAuthenticated) {
    throw new AppError(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, {
      message: 'The document needs a password to open. Remove the password and upload it again.',
    });
  }

  // Checked on the document as loaded, before anything below modifies it.
  await assertSignaturesValidOnArrival(pdf, pdfDoc);

  // Read this before touching the document. Flattening is one of the things
  // that destroys the evidence it looks for.
  const existingSignatures = inspectExistingSignatures(pdfDoc);
  const hasExistingSignatures = existingSignatures.signedFieldCount > 0;

  if (hasExistingSignatures && !allowSignatureDestruction && !existingSignatures.canPreserve) {
    // Refuse rather than accept the file and quietly strip a counterparty's
    // signature. Losing their cryptographic evidence without telling anyone is
    // worse than not accepting the upload.
    throw new AppError('INVALID_DOCUMENT_FILE', {
      message:
        'This document is already signed, and that signature cannot be preserved ' +
        `because the file ${describeBlocker(existingSignatures.blocker)}. ` +
        'Ask the sender for a copy that has not been through that processing, or ' +
        'flatten the document deliberately before uploading it.',
    });
  }

  const preserveSignatures = hasExistingSignatures && !allowSignatureDestruction;

  pdfDoc.flattenLayers();

  const form = pdfDoc.getForm();

  if (shouldFlattenForm && form) {
    // `skipSignatures` keeps the signature fields in the AcroForm. Without it
    // the /Fields array is emptied and /SigFlags deleted, so a reader finds no
    // signature even though the signed bytes are still present.
    form.flatten({ skipSignatures: preserveSignatures });
    pdfDoc.flattenAnnotations();
  }

  // An incremental save appends; a plain save rewrites every byte offset and
  // invalidates the /ByteRange the existing signature is computed over.
  const normalizedPdfBytes = await pdfDoc.save({ incremental: preserveSignatures });

  const output = Buffer.from(normalizedPdfBytes);

  if (preserveSignatures) {
    assertSignedBytesUntouched(pdf, output);
  }

  return output;
};

/**
 * Refuse a PDF whose existing signature no longer verifies as it arrived.
 *
 * Such a signature was broken before the file reached us, for example by
 * protection applied over it, so it is refused as such rather than left for
 * the storage check to report as damage done here. Call it on the bytes as
 * received, before anything changes them.
 *
 * A signature Sign cannot evaluate (no usable /ByteRange, or contents that are
 * not a CMS signature carrying a digest) counts as broken too, since accepting
 * it would leave a signature nobody has checked.
 *
 * @param pdf the bytes as received.
 * @param loaded optionally, `pdf` already parsed and not yet modified, so the
 *   caller's parse is reused instead of parsing again. Pass it before filling,
 *   flattening or anything else changes the document.
 */
export const assertSignaturesValidOnArrival = async (pdf: Uint8Array, loaded?: PDF) => {
  let report: Awaited<ReturnType<typeof assertEmbeddedSignaturesIntact>>;

  try {
    report = await assertEmbeddedSignaturesIntact(new Uint8Array(pdf), loaded);
  } catch (error) {
    if (!(error instanceof EmbeddedSignatureBrokenError)) {
      throw error;
    }

    throw new AppError(AppErrorCode.SIGNATURE_ALREADY_INVALID, {
      message:
        "This document's existing signature is already invalid: the file was changed after it was signed. " +
        'Ask the sender for a copy whose signature still verifies.',
    });
  }

  if (report.intact < report.checked) {
    throw new AppError(AppErrorCode.SIGNATURE_ALREADY_INVALID, {
      message:
        "This document's existing signature cannot be verified: it is in a format Sign cannot check, " +
        'so it is treated as already invalid. Ask the sender for a copy with a standard PDF signature.',
    });
  }
};

/**
 * Refuse a PDF a legacy (V1) envelope cannot carry to completion.
 *
 * Its sealing path round-trips the file through pdf-lib, which drops /Encrypt
 * when it decrypts, so an owner-protected upload would be sealed with its
 * protection silently removed. Called where a V1 envelope is created, so the
 * sender learns at creation rather than after everyone has signed, and at send
 * for a document whose file was uploaded after creation.
 *
 * The file is parsed once, and the signature check reuses that parse.
 */
export const assertLegacyEnvelopeAcceptsPdf = async (pdf: Uint8Array) => {
  const pdfDoc = await PDF.load(pdf).catch(() => {
    throw new AppError('INVALID_DOCUMENT_FILE', {
      message: 'The document is not a valid PDF',
    });
  });

  if (pdfDoc.isEncrypted && !pdfDoc.isAuthenticated) {
    throw new AppError(AppErrorCode.PASSWORD_PROTECTED_DOCUMENT, {
      message: 'The document needs a password to open. Remove the password and upload it again.',
    });
  }

  // A broken signature is the file's own fault, whatever else it carries, so
  // it is reported before the owner restrictions.
  await assertSignaturesValidOnArrival(pdf, pdfDoc);

  if (pdfDoc.isEncrypted) {
    throw new AppError(AppErrorCode.ENVELOPE_LEGACY, {
      message:
        'This PDF carries owner restrictions, which the legacy document flow cannot keep. ' +
        'Recreate it as a V2 envelope.',
    });
  }
};

/**
 * Check the outcome rather than trusting the request.
 *
 * `save({ incremental: true })` does not fail when an incremental save turns
 * out to be impossible. It records an internal warning and silently performs a
 * full rewrite instead, which is exactly the outcome this module exists to
 * prevent. An incremental save appends, so the original file must still be a
 * byte-for-byte prefix of the result; if it is not, every existing signature
 * has just been invalidated and we would rather fail than hand back the file.
 */
export const assertSignedBytesUntouched = (before: Uint8Array, after: Uint8Array) => {
  if (after.length >= before.length && Buffer.from(after.subarray(0, before.length)).equals(before)) {
    return;
  }

  throw new AppError('INVALID_DOCUMENT_FILE', {
    message:
      'This document carries a signature, and processing it rewrote the bytes that ' +
      'signature covers. Refusing to continue rather than return a document whose ' +
      'existing signature is silently broken.',
  });
};

const describeBlocker = (blocker: string | null) => {
  switch (blocker) {
    case 'linearized':
      return 'is linearized for fast web viewing';
    case 'brute-force-recovery':
      return 'is damaged and had to be recovered';
    case 'newly-created':
      return 'has no original revision to append to';
    default:
      return `cannot take an incremental update (${blocker ?? 'unknown reason'})`;
  }
};
