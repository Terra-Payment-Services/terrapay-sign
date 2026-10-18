/**
 * C9 patch guard: @libpdf/core reads page boxes and Rotate inherited from /Pages.
 *
 * Failure modes this guards, one line each:
 * - a page whose MediaBox sits only on /Pages reads as 612x792 instead of its real size;
 * - a page whose Rotate sits only on /Pages reads as rotation 0;
 * - a libpdf upgrade drops the local patch that makes both of the above hold.
 *
 * What this seam catches that the E2E specs do not: the patch going missing,
 * before any server starts. What it misses: every reader in Sign that uses the
 * page size (overlay, placeholders, appended pages), which the E2E spec
 * packages/app-tests/e2e/api/v2/inherited-page-box.spec.ts covers.
 *
 * The fixtures duplicate packages/app-tests/e2e/fixtures/inherited-page-box.ts,
 * which this package may not import, including its check that the saved bytes
 * really carry the box on /Pages and not on the page.
 */

import type { PdfRef } from '@libpdf/core';
import { PDF, PdfArray, PdfDict, PdfName, PdfNull, PdfNumber } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

const buildInheritedA4 = async (rotate?: number) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ width: A4_WIDTH, height: A4_HEIGHT });
  const parentRef = page.dict.getRef('Parent');
  const parent = parentRef ? pdf.getObject(parentRef) : null;
  const mediaBox = page.dict.get('MediaBox');

  if (!(parent instanceof PdfDict) || !mediaBox) {
    throw new Error('fixture: no /Pages dictionary or no MediaBox to move');
  }

  parent.set('MediaBox', mediaBox);
  page.dict.delete('MediaBox');
  page.dict.delete('CropBox');
  page.dict.delete('Rotate');

  if (rotate !== undefined) {
    parent.set('Rotate', PdfNumber.of(rotate));
  }

  const bytes = Buffer.from(await pdf.save());
  const text = bytes.toString('latin1');
  const objects = text.split(/\bendobj\b/);
  const pageObjects = objects.filter((body) => /\/Type\s*\/Page(?![s\w])/.test(body));
  const pagesObjects = objects.filter((body) => /\/Type\s*\/Pages\b/.test(body));

  if (text.includes('/ObjStm') || pageObjects.length !== 1 || pagesObjects.length !== 1) {
    throw new Error('fixture: cannot find exactly one plain /Page and one plain /Pages object');
  }

  if (/\/(MediaBox|CropBox|Rotate)\b/.test(pageObjects[0])) {
    throw new Error('fixture: a box or Rotate is still on the page dictionary');
  }

  if (!/\/MediaBox\s*\[\s*0\s+0\s+595\.28\s+841\.89\s*\]/.test(pagesObjects[0])) {
    throw new Error('fixture: the A4 MediaBox is not on the /Pages node');
  }

  if (rotate !== undefined && !new RegExp(`/Rotate\\s+${rotate}\\b`).test(pagesObjects[0])) {
    throw new Error(`fixture: /Rotate ${rotate} is not on the /Pages node`);
  }

  return bytes;
};

describe('C9 @libpdf/core reads page geometry inherited from /Pages', () => {
  it('C9 reads an A4 MediaBox that sits only on /Pages as 595.28 x 841.89', async () => {
    const page = (await PDF.load(await buildInheritedA4())).getPage(0);

    expect(page).toBeDefined();
    expect({ width: page?.width, height: page?.height }).toEqual({ width: A4_WIDTH, height: A4_HEIGHT });
  });

  it('C9 reads a Rotate 90 that sits only on /Pages as rotation 90', async () => {
    const page = (await PDF.load(await buildInheritedA4(90))).getPage(0);

    expect(page?.rotation).toBe(90);
  });
});

type TreeParts = {
  pdf: PDF;
  page: PdfDict;
  pageRef: PdfRef;
  root: PdfDict;
  rootRef: PdfRef;
};

const box = (x: number, y: number, width: number, height: number) =>
  PdfArray.of(PdfNumber.of(x), PdfNumber.of(y), PdfNumber.of(x + width), PdfNumber.of(y + height));

/**
 * Builds a one-page document, lets the caller rewrite the page and /Pages dictionaries, then saves
 * and reloads it, so the reader sees what a parser sees. The page starts with no boxes and no Rotate.
 */
const buildTree = async (configure: (parts: TreeParts) => void) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ width: A4_WIDTH, height: A4_HEIGHT });
  const rootRef = page.dict.getRef('Parent');
  const root = rootRef ? pdf.getObject(rootRef) : null;

  if (!rootRef || !(root instanceof PdfDict)) {
    throw new Error('fixture: no /Pages dictionary');
  }

  for (const key of ['MediaBox', 'CropBox', 'Rotate']) {
    page.dict.delete(key);
  }

  configure({ pdf, page: page.dict, pageRef: page.ref, root, rootRef });

  const reloaded = await PDF.load(Buffer.from(await pdf.save()));
  const reloadedPage = reloaded.getPage(0);

  if (!reloadedPage) {
    throw new Error('fixture: the reloaded document has no page 0');
  }

  return reloadedPage;
};

/** Inserts an intermediate /Pages node between the root and the page and returns it. */
const insertMiddleNode = ({ pdf, page, pageRef, root, rootRef }: TreeParts) => {
  const mid = PdfDict.of({
    Type: PdfName.of('Pages'),
    Parent: rootRef,
    Kids: PdfArray.of(pageRef),
    Count: PdfNumber.of(1),
  });
  const midRef = pdf.register(mid);

  root.set('Kids', PdfArray.of(midRef));
  page.set('Parent', midRef);

  return { mid, midRef };
};

const DEFAULTS = { width: 612, height: 792, rotation: 0 };

/** Reads the MediaBox size, which Rotate does not swap, and the rotation. */
const readGeometry = (page: { getMediaBox: () => { width: number; height: number }; rotation: number }) => ({
  width: page.getMediaBox().width,
  height: page.getMediaBox().height,
  rotation: page.rotation,
});

describe('C10 a PDF null entry is the same as an absent one', () => {
  it('C10 reads /MediaBox null and /Rotate null on the page as the values inherited from /Pages', async () => {
    const page = await buildTree(({ page, root }) => {
      page.set('MediaBox', PdfNull.instance);
      page.set('Rotate', PdfNull.instance);
      root.set('MediaBox', box(0, 0, A4_WIDTH, A4_HEIGHT));
      root.set('Rotate', PdfNumber.of(90));
    });

    expect(readGeometry(page)).toEqual({ width: A4_WIDTH, height: A4_HEIGHT, rotation: 90 });
  });
});

describe('C11 the inheritance contract', () => {
  it('C11 reads a CropBox that sits only on /Pages', async () => {
    const page = await buildTree(({ root }) => {
      root.set('MediaBox', box(0, 0, A4_WIDTH, A4_HEIGHT));
      root.set('CropBox', box(0, 0, 300, 400));
    });

    expect(page.getCropBox()).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });

  it('C11 takes MediaBox and Rotate from the nearest ancestor, not a farther one', async () => {
    const page = await buildTree((parts) => {
      parts.root.set('MediaBox', box(0, 0, 100, 100));
      parts.root.set('Rotate', PdfNumber.of(90));

      const { mid } = insertMiddleNode(parts);

      mid.set('MediaBox', box(0, 0, A4_WIDTH, A4_HEIGHT));
      mid.set('Rotate', PdfNumber.of(180));
    });

    expect(readGeometry(page)).toEqual({ width: A4_WIDTH, height: A4_HEIGHT, rotation: 180 });
  });

  it('C11 prefers the page own MediaBox over an inherited one', async () => {
    const page = await buildTree(({ page, root }) => {
      page.set('MediaBox', box(0, 0, 300, 400));
      root.set('MediaBox', box(0, 0, A4_WIDTH, A4_HEIGHT));
    });

    expect({ width: page.width, height: page.height }).toEqual({ width: 300, height: 400 });
  });

  it('C11 prefers the page own Rotate 0 over an inherited Rotate 90', async () => {
    const page = await buildTree(({ page, root }) => {
      page.set('Rotate', PdfNumber.of(0));
      root.set('Rotate', PdfNumber.of(90));
    });

    expect(page.rotation).toBe(0);
  });

  it('C11 resolves inherited values that are held as indirect references', async () => {
    const page = await buildTree(({ pdf, root }) => {
      root.set('MediaBox', pdf.register(box(0, 0, A4_WIDTH, A4_HEIGHT)));
      root.set('Rotate', pdf.register(PdfNumber.of(270)));
    });

    expect(readGeometry(page)).toEqual({ width: A4_WIDTH, height: A4_HEIGHT, rotation: 270 });
  });

  it('C11 ends the walk at a /Parent that is a number and returns the defaults', async () => {
    const page = await buildTree(({ page }) => {
      page.set('Parent', PdfNumber.of(5));
    });

    expect(readGeometry(page)).toEqual(DEFAULTS);
  });

  it('C11 ends the walk at a /Parent that is a reference to a non-dictionary and returns the defaults', async () => {
    const page = await buildTree(({ pdf, page }) => {
      page.set('Parent', pdf.register(PdfArray.of(PdfNumber.of(1))));
    });

    expect(readGeometry(page)).toEqual(DEFAULTS);
  });

  it('C11 keeps the page own values when /Parent is not a dictionary', async () => {
    const page = await buildTree(({ page }) => {
      page.set('MediaBox', box(0, 0, 300, 400));
      page.set('Rotate', PdfNumber.of(180));
      page.set('Parent', PdfNumber.of(5));
    });

    expect(readGeometry(page)).toEqual({ width: 300, height: 400, rotation: 180 });
  });

  it('C11 ends the walk when /Pages is its own /Parent and returns the defaults', async () => {
    const page = await buildTree(({ root, rootRef }) => {
      root.set('Parent', rootRef);
    });

    expect(readGeometry(page)).toEqual(DEFAULTS);
  });

  it('C11 ends the walk on a two-node /Parent cycle and returns the defaults', async () => {
    const page = await buildTree((parts) => {
      const { midRef } = insertMiddleNode(parts);

      parts.root.set('Parent', midRef);
    });

    expect(readGeometry(page)).toEqual(DEFAULTS);
  });

  it('C11 keeps the page own values on a /Parent cycle', async () => {
    const page = await buildTree((parts) => {
      parts.page.set('MediaBox', box(0, 0, 300, 400));
      parts.page.set('Rotate', PdfNumber.of(90));

      const { midRef } = insertMiddleNode(parts);

      parts.root.set('Parent', midRef);
    });

    expect(readGeometry(page)).toEqual({ width: 300, height: 400, rotation: 90 });
  });
});
