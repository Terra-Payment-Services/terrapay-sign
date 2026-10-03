import { PDF } from '@libpdf/core';

import { AppError } from '../../errors/app-error';
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

export const normalizePdf = async (pdf: Buffer, options: NormalizePdfOptions = {}) => {
  const shouldFlattenForm = options.flattenForm ?? true;
  const allowSignatureDestruction = options.allowSignatureDestruction ?? false;

  const pdfDoc = await PDF.load(pdf).catch((e) => {
    console.error(`PDF normalization error: ${e.message}`);

    throw new AppError('INVALID_DOCUMENT_FILE', {
      message: 'The document is not a valid PDF',
    });
  });

  if (pdfDoc.isEncrypted) {
    throw new AppError('INVALID_DOCUMENT_FILE', {
      message: 'The document is encrypted',
    });
  }

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
 * Check the outcome rather than trusting the request.
 *
 * `save({ incremental: true })` does not fail when an incremental save turns
 * out to be impossible. It records an internal warning and silently performs a
 * full rewrite instead, which is exactly the outcome this module exists to
 * prevent. An incremental save appends, so the original file must still be a
 * byte-for-byte prefix of the result; if it is not, every existing signature
 * has just been invalidated and we would rather fail than hand back the file.
 */
const assertSignedBytesUntouched = (before: Buffer, after: Buffer) => {
  if (after.length >= before.length && after.subarray(0, before.length).equals(before)) {
    return;
  }

  throw new AppError('INVALID_DOCUMENT_FILE', {
    message:
      'This document is already signed, and processing it rewrote the bytes that ' +
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
