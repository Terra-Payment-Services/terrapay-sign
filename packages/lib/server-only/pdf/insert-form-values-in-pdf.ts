import { PDF } from '@libpdf/core';

import { inspectExistingSignatures } from './existing-signatures';
import { assertSignaturesValidOnArrival, assertSignedBytesUntouched } from './normalize-pdf';

export type InsertFormValuesInPdfOptions = {
  pdf: Buffer;
  formValues: Record<string, string | boolean | number>;
};

/**
 * Fill an uploaded PDF's form fields, appending the change so an existing
 * signature still covers the bytes it was made over.
 *
 * The file is parsed once. The arrival signature check runs on the original
 * bytes and that parse, before `fill` modifies the document.
 */
export const insertFormValuesInPdf = async ({ pdf, formValues }: InsertFormValuesInPdfOptions) => {
  const doc = await PDF.load(pdf);

  // Judge an existing signature on the bytes as they arrived, before filling
  // changes them, so the file is blamed only for damage it arrived with.
  await assertSignaturesValidOnArrival(pdf, doc);

  const form = doc.getForm();

  if (!form) {
    return pdf;
  }

  const filledForm = Object.entries(formValues).map(([key, value]) => [
    key,
    typeof value === 'boolean' ? value : value.toString(),
  ]);

  const isSigned = inspectExistingSignatures(doc).signedFieldCount > 0;

  form.fill(Object.fromEntries(filledForm));

  const bytes = await doc.save({ incremental: true });

  // `incremental` silently becomes a full rewrite when the file cannot take an
  // appended update, which would break a signature that was valid on arrival.
  if (isSigned) {
    assertSignedBytesUntouched(pdf, bytes);
  }

  return Buffer.from(bytes);
};
