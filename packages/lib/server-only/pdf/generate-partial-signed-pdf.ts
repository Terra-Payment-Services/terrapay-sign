import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import { PDF } from '@libpdf/core';
import { groupBy } from 'remeda';

import { AppError } from '../../errors/app-error';
import { inspectExistingSignatures } from './existing-signatures';
import { insertFieldInPDFV2 } from './insert-field-in-pdf-v2';
import { assertSignedBytesUntouched } from './normalize-pdf';

type GeneratePartialSignedPdfOptions = {
  pdfData: Uint8Array;
  fields: FieldWithSignature[];
};

/**
 * Generates a PDF with all currently-inserted fields burned in. Used to serve
 * partially signed envelopes during the `PENDING` window before the seal job
 * has had a chance to produce the final sealed PDF.
 *
 * No PKI signature, no certificate page, no audit log appendix - this is a
 * preview of the in-progress envelope, not a final executed document.
 */
export const generatePartialSignedPdf = async ({ pdfData, fields }: GeneratePartialSignedPdfOptions) => {
  const pdfDoc = await PDF.load(pdfData);

  // A counterparty's signature survives only if the form is flattened around it
  // and the result is appended rather than rewritten, as in `normalizePdf`.
  const existingSignatures = inspectExistingSignatures(pdfDoc);
  const preserveSignatures = existingSignatures.signedFieldCount > 0;

  if (preserveSignatures && !existingSignatures.canPreserve) {
    throw new AppError('INVALID_DOCUMENT_FILE', {
      message:
        'This document carries an existing signature that a pending copy cannot preserve ' +
        `(${existingSignatures.blocker ?? 'unknown reason'}).`,
    });
  }

  pdfDoc.flattenAll({ form: { skipSignatures: preserveSignatures } });
  pdfDoc.upgradeVersion('1.7');

  const fieldsGroupedByPage = groupBy(fields, (field) => field.page);

  for (const [pageNumber, pageFields] of Object.entries(fieldsGroupedByPage)) {
    const page = pdfDoc.getPage(Number(pageNumber) - 1);

    if (!page) {
      throw new Error(`Page ${pageNumber} does not exist`);
    }

    const pageWidth = page.width;
    const pageHeight = page.height;
    const overlayBytes = await insertFieldInPDFV2({
      pageWidth,
      pageHeight,
      fields: pageFields,
    });

    const overlayPdf = await PDF.load(overlayBytes);
    const embeddedPage = await pdfDoc.embedPage(overlayPdf, 0);

    let translateX = 0;
    let translateY = 0;

    switch (page.rotation) {
      case 90:
        translateX = pageHeight;
        translateY = 0;
        break;
      case 180:
        translateX = pageWidth;
        translateY = pageHeight;
        break;
      case 270:
        translateX = 0;
        translateY = pageWidth;
        break;
    }

    page.drawPage(embeddedPage, {
      x: translateX,
      y: translateY,
      rotate: {
        angle: page.rotation,
      },
    });
  }

  pdfDoc.flattenAll({ form: { skipSignatures: preserveSignatures } });

  if (!preserveSignatures) {
    return await pdfDoc.save({ useXRefStream: true });
  }

  const bytes = await pdfDoc.save({ incremental: true });

  assertSignedBytesUntouched(pdfData, bytes);

  return bytes;
};
