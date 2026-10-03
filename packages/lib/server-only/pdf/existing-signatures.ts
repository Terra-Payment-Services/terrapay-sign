import type { PDF } from '@libpdf/core';

/**
 * What we know about signatures a third party applied before the document
 * reached us.
 *
 * A PDF signature covers a byte range of the file. It survives further editing
 * only if every later change is written as an incremental update, appended
 * after the signed bytes rather than rewritten over them. Two things must hold
 * for that to work, and both are easy to lose:
 *
 *   1. The file must be saved with `{ incremental: true }`. A plain `save()`
 *      re-serialises the whole document, every byte offset moves, and the
 *      signature's /ByteRange no longer describes the file.
 *   2. Form flattening must be told to leave signature fields alone. The
 *      default empties the AcroForm /Fields array and deletes /SigFlags, so
 *      even with the signed bytes intact a reader no longer finds the
 *      signature and shows the document as unsigned.
 *
 * Getting one right and the other wrong still loses the signature, so both are
 * asserted together by the callers of this module.
 */
export type ExistingSignatureInfo = {
  /** Signature fields that already carry a signature. */
  signedFieldCount: number;
  /** Whether those signatures can be carried through further edits. */
  canPreserve: boolean;
  /** When `canPreserve` is false, the reason reported by the PDF library. */
  blocker: string | null;
};

/**
 * Report whether a loaded document arrived already signed, and whether we are
 * able to keep those signatures valid.
 *
 * Call this before any flattening, because flattening is one of the things
 * that destroys the evidence this looks for.
 */
export const inspectExistingSignatures = (pdfDoc: PDF): ExistingSignatureInfo => {
  const form = pdfDoc.getForm();

  const signedFieldCount = form ? form.getSignatureFields().filter((field) => field.isSigned).length : 0;

  if (signedFieldCount === 0) {
    return { signedFieldCount: 0, canPreserve: true, blocker: null };
  }

  // `canSaveIncrementally` reports conditions under which an append-only save
  // is impossible, such as a linearized file or one recovered by brute force
  // after a parse failure.
  const blocker = pdfDoc.canSaveIncrementally();

  return {
    signedFieldCount,
    canPreserve: blocker === null,
    blocker,
  };
};
