import type { PdfRef } from '@libpdf/core';
import { PDF } from '@libpdf/core';

/**
 * What a conforming reader finds as the value of an existing signature: the
 * /Contents of the newest definition of its signature dictionary, read as raw
 * hex. Read straight from the bytes on purpose. libpdf decrypts /Contents of an
 * encrypted document on load, where readers such as poppler take it raw, so a
 * check made through libpdf can pass on a file other readers call broken.
 */
export const rawSignatureContents = (bytes: Uint8Array, objectNumber: number) => {
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.lastIndexOf(`\n${objectNumber} 0 obj`);
  const match = /\/Contents\s*<([0-9A-Fa-f]+)>/.exec(text.slice(start));

  return match?.[1].toUpperCase().replace(/(00)+$/, '');
};

export const signatureObjectNumber = async (bytes: Uint8Array) => {
  const doc = await PDF.load(bytes);
  const field = doc.getForm()?.getSignatureFields()[0];

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return (field?.getDict().get('V') as PdfRef).objectNumber;
};
