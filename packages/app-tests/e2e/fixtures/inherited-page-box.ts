/**
 * PDFs whose page size and rotation are inherited from the /Pages node.
 *
 * PDF 1.7 (ISO 32000-1, 7.7.3.4) lets MediaBox, CropBox and Rotate sit on an
 * ancestor /Pages node instead of on the page. These builders draw an A4 page
 * with @libpdf/core, move its MediaBox (and, for the rotated variant, a
 * /Rotate 90) up to the parent /Pages node, and save. Nothing is committed as
 * a binary.
 *
 * Every builder checks the saved bytes before returning them. If the box is
 * still on the page dictionary, or the /Pages object cannot be found in plain
 * text (an object stream would hide it), the builder throws, so a fixture that
 * no longer reproduces the condition cannot let a test pass silently.
 */
import { PDF, PdfDict, PdfNumber, StandardFonts } from '@libpdf/core';

/** A4 in points, as written into the MediaBox. */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

/** The placeholder the PDF placeholders guide gives for signer 1's signature. */
export const INHERITED_PLACEHOLDER = '{{signature, r1}}';

/** Where the placeholder is drawn, in PDF user space (origin bottom left, baseline at y). */
export const PLACEHOLDER_ORIGIN = { x: 50, y: 600, size: 12 } as const;

type BuildOptions = {
  rotate?: 90;
  placeholder?: boolean;
  /** Leave MediaBox (and Rotate) on the page dictionary: a control with the same drawing. */
  onPage?: boolean;
};

const buildA4 = async ({ rotate, placeholder = false, onPage = false }: BuildOptions = {}) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ width: A4_WIDTH, height: A4_HEIGHT });

  if (placeholder) {
    page.drawText(INHERITED_PLACEHOLDER, {
      x: PLACEHOLDER_ORIGIN.x,
      y: PLACEHOLDER_ORIGIN.y,
      font: StandardFonts.Helvetica,
      size: PLACEHOLDER_ORIGIN.size,
    });
  }

  if (onPage) {
    if (rotate !== undefined) {
      page.dict.set('Rotate', PdfNumber.of(rotate));
    }

    return Buffer.from(await pdf.save());
  }

  const parentRef = page.dict.getRef('Parent');

  if (!parentRef) {
    throw new Error('inherited-page-box fixture: the page has no /Parent');
  }

  const parent = pdf.getObject(parentRef);
  const mediaBox = page.dict.get('MediaBox');

  if (!(parent instanceof PdfDict) || !mediaBox) {
    throw new Error('inherited-page-box fixture: no /Pages dictionary or no MediaBox to move');
  }

  parent.set('MediaBox', mediaBox);
  page.dict.delete('MediaBox');
  page.dict.delete('CropBox');
  page.dict.delete('Rotate');

  if (rotate !== undefined) {
    parent.set('Rotate', PdfNumber.of(rotate));
  }

  const bytes = Buffer.from(await pdf.save());

  assertInherited(bytes, { rotate });

  return bytes;
};

/**
 * Throw unless the saved file has exactly one /Type /Page object carrying no
 * MediaBox, CropBox or Rotate, and a /Type /Pages object carrying the A4
 * MediaBox (and the Rotate, when asked for).
 */
const assertInherited = (bytes: Buffer, { rotate }: { rotate?: number }) => {
  const text = bytes.toString('latin1');

  if (text.includes('/ObjStm')) {
    throw new Error('inherited-page-box fixture: saved with object streams, so its structure cannot be checked');
  }

  const objects = text.split(/\bendobj\b/);
  const pageObjects = objects.filter((body) => /\/Type\s*\/Page(?![s\w])/.test(body));
  const pagesObjects = objects.filter((body) => /\/Type\s*\/Pages\b/.test(body));

  if (pageObjects.length !== 1 || pagesObjects.length !== 1) {
    throw new Error(
      `inherited-page-box fixture: expected one /Page and one /Pages object, found ${pageObjects.length} and ${pagesObjects.length}`,
    );
  }

  const [pageObject] = pageObjects;
  const [pagesObject] = pagesObjects;

  for (const key of ['MediaBox', 'CropBox', 'Rotate']) {
    if (new RegExp(`/${key}\\b`).test(pageObject)) {
      throw new Error(`inherited-page-box fixture: /${key} is still on the page dictionary`);
    }
  }

  if (!/\/MediaBox\s*\[\s*0\s+0\s+595\.28\s+841\.89\s*\]/.test(pagesObject)) {
    throw new Error('inherited-page-box fixture: the A4 MediaBox is not on the /Pages node');
  }

  if (rotate !== undefined && !new RegExp(`/Rotate\\s+${rotate}\\b`).test(pagesObject)) {
    throw new Error(`inherited-page-box fixture: /Rotate ${rotate} is not on the /Pages node`);
  }
};

/** An A4 page whose MediaBox is only on /Pages. */
export const buildInheritedA4Pdf = async () => await buildA4();

/** The same, with /Rotate 90 on /Pages as well. */
export const buildInheritedRotatedA4Pdf = async () => await buildA4({ rotate: 90 });

/** The inherited A4 page with `{{signature, r1}}` drawn at PLACEHOLDER_ORIGIN. */
export const buildInheritedPlaceholderPdf = async () => await buildA4({ placeholder: true });

/** Control: the same placeholder page with its MediaBox on the page, as most PDFs are written. */
export const buildOnPagePlaceholderPdf = async () => await buildA4({ placeholder: true, onPage: true });
