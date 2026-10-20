/**
 * Uploaded signature images keep their shape.
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md,
 * section 4.4) before any fix, without reading the upload pad's fit or export
 * code. The signer opens the V2 signing page with only the recipient token,
 * clicks the SIGNATURE field, uploads a fixture through the Upload tab and
 * presses Sign. The stored Signature.signatureImageAsBase64 is decoded with
 * pngjs; ink is the spec's D1 rule (Y < 230 composited over white), computed
 * in fixtures/signature-ink.ts.
 *
 * | Criterion | Test                                                                                  |
 * | --------- | ------------------------------------------------------------------------------------- |
 * | C35       | C35 a 600 x 600 ring stamp is stored square, its ink filling the stored image          |
 * | C36       | C36 the ring signed into a square field fills 90% of the field in the sealed PDF       |
 * | C37       | C37 a 1200 x 300 upload is stored at 4:1 with no edge row or column of ink lost         |
 * | C38       | C38 a photographed signature keeps its faint edge strokes after zoom and drag          |
 * | C39       | C39 every stored image passes the server check; zoom and drag redraw before confirming |
 *
 * C37 and C38, strengthened (spec, "Round after Codex r1"): the stored image is also compared with the expected
 * crop by D1 ink mask (maskMismatches): every stored pixel's ink state must equal the expected crop's at the
 * mapped position, except a one-pixel shift at a stroke edge, so a lost stroke or edge line fails however the
 * ratios come out. The zoomed case compares masks with no density allowance.
 *
 * C38's "after the user's zoom and drag": the user zooms in, zooms back out and
 * drags the image right and back by the same distance, a net identity, so the
 * expected crop is the whole photograph and all four faint edge strokes must
 * survive.
 */
import fs from 'node:fs';

import { prisma } from '@documenso/prisma';
import { expect, type Page, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';
import type { PNG } from 'pngjs';

import { keepRecord } from '../fixtures/reject-seal';
import {
  completeWithToken,
  coverageOf,
  decodePng,
  expect2xx,
  fieldState,
  type G4Seeded,
  IMAGE_DIR,
  imageManifest,
  isInkPixel,
  opaqueBoundingBox,
  P,
  seedOneSigner,
  signV2,
} from '../fixtures/signature-ink';
import {
  boxOf,
  canvasDataUrl,
  openV2FieldDialog,
  openV2SigningPage,
  renderBox,
  sealedPdf,
  signButton,
  storedImage,
} from '../fixtures/signature-ink-pad';

test.describe.configure({ mode: 'default' });

const fixturePath = (name: string) => `${IMAGE_DIR}/${imageManifest()[name].file}`;

/** Bounding box of D1 ink pixels. */
const inkBox = (png: PNG) => {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;

      if (isInkPixel(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3])) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

const isInkAt = (png: PNG, x: number, y: number) => {
  const i = (y * png.width + x) * 4;

  return isInkPixel(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]);
};

/** The largest share of ink along any one row (or column) inside `rows` of the box. */
const bestLineShare = (
  png: PNG,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  axis: 'row' | 'column',
  lines: number[],
) => {
  let best = 0;

  for (const line of lines) {
    let ink = 0;
    let total = 0;

    if (axis === 'row') {
      for (let x = box.minX; x <= box.maxX; x++) {
        total++;
        ink += isInkAt(png, x, line) ? 1 : 0;
      }
    } else {
      for (let y = box.minY; y <= box.maxY; y++) {
        total++;
        ink += isInkAt(png, line, y) ? 1 : 0;
      }
    }

    best = Math.max(best, total > 0 ? ink / total : 0);
  }

  return best;
};

type Region = { minX: number; minY: number; width: number; height: number };

/**
 * Compares the D1 ink mask of `stored` inside `storedRegion` with that of `expected` inside `expectedRegion`, the
 * two regions mapped onto each other. Each stored pixel covers a footprint of the expected crop; it is expected to
 * be ink when its footprint holds ink. One pixel of resampling at stroke edges is allowed: stored ink is forgiven
 * when the footprint widened by one stored pixel holds ink, and a missing ink pixel is forgiven when a stored
 * neighbour within one pixel is ink. A stroke lost entirely, or ink where the crop has none nearby, is counted.
 */
const maskMismatches = (expected: PNG, expectedRegion: Region, stored: PNG, storedRegion: Region) => {
  const sx = expectedRegion.width / storedRegion.width;
  const sy = expectedRegion.height / storedRegion.height;
  // Summed-area table of the expected crop's ink, for footprint queries.
  const w = expectedRegion.width;
  const h = expectedRegion.height;
  const sums = new Int32Array((w + 1) * (h + 1));

  for (let y = 0; y < h; y++) {
    let row = 0;

    for (let x = 0; x < w; x++) {
      row += isInkAt(expected, expectedRegion.minX + x, expectedRegion.minY + y) ? 1 : 0;
      sums[(y + 1) * (w + 1) + (x + 1)] = sums[y * (w + 1) + (x + 1)] + row;
    }
  }

  /** Ink pixels of the expected crop in the footprint of stored pixels [x0, x1) x [y0, y1), relative to the region. */
  const footprintInk = (x0: number, y0: number, x1: number, y1: number) => {
    const ax = Math.min(Math.max(Math.floor(x0 * sx), 0), w);
    const ay = Math.min(Math.max(Math.floor(y0 * sy), 0), h);
    const bx = Math.min(Math.max(Math.ceil(x1 * sx), 0), w);
    const by = Math.min(Math.max(Math.ceil(y1 * sy), 0), h);

    return sums[by * (w + 1) + bx] - sums[ay * (w + 1) + bx] - sums[by * (w + 1) + ax] + sums[ay * (w + 1) + ax];
  };
  const storedAt = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < stored.width && y < stored.height && isInkAt(stored, x, y);
  let mismatches = 0;
  let forgiven = 0;
  let expectedInk = 0;
  let storedInk = 0;
  const examples: Array<{ x: number; y: number; stored: boolean }> = [];

  for (let y = 0; y < storedRegion.height; y++) {
    for (let x = 0; x < storedRegion.width; x++) {
      const px = storedRegion.minX + x;
      const py = storedRegion.minY + y;
      const want = footprintInk(x, y, x + 1, y + 1) > 0;
      const got = storedAt(px, py);

      expectedInk += want ? 1 : 0;
      storedInk += got ? 1 : 0;

      if (want === got) {
        continue;
      }

      let isForgiven = false;

      if (got) {
        isForgiven = footprintInk(x - 1, y - 1, x + 2, y + 2) > 0;
      } else {
        for (let dy = -1; dy <= 1 && !isForgiven; dy++) {
          for (let dx = -1; dx <= 1 && !isForgiven; dx++) {
            isForgiven = storedAt(px + dx, py + dy);
          }
        }
      }

      if (isForgiven) {
        forgiven++;
      } else {
        mismatches++;

        if (examples.length < 10) {
          examples.push({ x: px, y: py, stored: got });
        }
      }
    }
  }

  return { mismatches, forgiven, expectedInk, storedInk, examples };
};

const range = (from: number, to: number) => {
  const out: number[] = [];

  for (let n = Math.max(from, 0); n <= to; n++) {
    out.push(n);
  }

  return out;
};

const decodeStored = (stored: string) => {
  expect(stored.startsWith(P), `the stored value is a PNG data URL: ${stored.slice(0, 40)}`).toBe(true);

  return decodePng(Buffer.from(stored.slice(P.length), 'base64'));
};

/** Opens the V2 page, clicks the field, uploads `fixture` and returns the dialog's upload canvas. */
const uploadInDialog = async (page: Page, seeded: G4Seeded, fixture: string) => {
  await openV2SigningPage(page, seeded.r.s1.token);

  const dialog = await openV2FieldDialog(page, seeded.r.s1.fields.sig.id);

  await dialog.getByRole('tab', { name: 'Upload' }).click();

  const canvas = dialog.getByTestId('signature-pad-upload');

  await expect(canvas).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles(fixturePath(fixture));
  await expect(dialog.getByRole('button', { name: 'Upload New Image' })).toBeVisible();

  return { dialog, canvas };
};

/** Presses Sign and returns the image the server stored for the field. */
const confirmAndRead = async (page: Page, seeded: G4Seeded) => {
  await expect(signButton(page), 'premise: the uploaded image enables Sign').toBeEnabled();
  await signButton(page).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  return await storedImage(seeded.r.s1.fields.sig.id);
};

const record = async (name: string, body: Record<string, unknown>) => await keepRecord(`${name}.json`, body);

// ---------------------------------------------------------------------------
// C35
// ---------------------------------------------------------------------------

test('C35 a 600 x 600 ring stamp uploaded through the Upload tab is stored square, its ink filling the stored image', async ({
  page,
}) => {
  const seeded = await seedOneSigner(2);
  const source = decodePng(fs.readFileSync(fixturePath('ring-600x600')));

  expect(source.width, 'premise: the fixture is 600 wide').toBe(600);
  expect(source.height, 'premise: the fixture is 600 high').toBe(600);

  await uploadInDialog(page, seeded, 'ring-600x600');

  const stored = await confirmAndRead(page, seeded);

  const png = decodeStored(stored);
  const ratio = png.width / png.height;
  const opaque = opaqueBoundingBox(png);

  await record('C35-stored', {
    width: png.width,
    height: png.height,
    ratio,
    opaque,
    coverage: coverageOf(png),
  });

  expect(opaque, 'premise: the stored image has ink at all').not.toBeNull();
  expect.soft(ratio, `stored ${png.width} x ${png.height}: ratio between 0.98 and 1.02`).toBeGreaterThanOrEqual(0.98);
  expect.soft(ratio, `stored ${png.width} x ${png.height}: ratio between 0.98 and 1.02`).toBeLessThanOrEqual(1.02);
  expect
    .soft((opaque?.width ?? 0) / png.width, 'the non-transparent bounding box covers at least 90% of the stored width')
    .toBeGreaterThanOrEqual(0.9);
  expect
    .soft(
      (opaque?.height ?? 0) / png.height,
      'the non-transparent bounding box covers at least 90% of the stored height',
    )
    .toBeGreaterThanOrEqual(0.9);
});

// ---------------------------------------------------------------------------
// C36
// ---------------------------------------------------------------------------

/** The example PDF's page 1 is 596 x 842 points: 30% of the width is 178.8 pt, 21.235% of the height. */
const SQUARE_FIELD = { positionX: 10, positionY: 10, width: 30, height: (0.3 * 596 * 100) / 842 };

/** The ring's dark blue (20, 20, 120): blue well above red and green, unlike black text or grey borders. */
const isRingBlue = (r: number, g: number, b: number) => b - r > 40 && b - g > 40;

test('C36 the ring stamp signed into a square field and sealed fills at least 90% of the field in the rendered PDF', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  const seeded = await seedOneSigner(2);

  await prisma.field.update({
    where: { id: seeded.r.s1.fields.sig.id },
    data: {
      positionX: SQUARE_FIELD.positionX,
      positionY: SQUARE_FIELD.positionY,
      width: SQUARE_FIELD.width,
      height: SQUARE_FIELD.height,
    },
  });

  await uploadInDialog(page, seeded, 'ring-600x600');
  await confirmAndRead(page, seeded);

  expect2xx(await completeWithToken(request, seeded, seeded.r.s1.token), 'premise: the signer completes');

  await expect
    .poll(async () => (await prisma.envelope.findUniqueOrThrow({ where: { id: seeded.envelopeId } })).status, {
      message: 'premise: the envelope seals',
      timeout: 90_000,
    })
    .toBe(DocumentStatus.COMPLETED);

  const render = renderBox(await sealedPdf(seeded), SQUARE_FIELD);
  let minX = render.width;
  let minY = render.height;
  let maxX = -1;
  let maxY = -1;
  let blue = 0;

  for (let y = 0; y < render.height; y++) {
    for (let x = 0; x < render.width; x++) {
      const i = (y * render.width + x) * 3;

      if (isRingBlue(render.rgb[i], render.rgb[i + 1], render.rgb[i + 2])) {
        blue++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const shorterSide = Math.min(render.width, render.height);
  const extent = blue > 0 ? Math.min(maxX - minX + 1, maxY - minY + 1) : 0;

  await record('C36-sealed', { field: render.width, fieldHeight: render.height, blue, extent, shorterSide });

  expect(Math.abs(render.width - render.height), 'premise: the field renders square at 72 dpi').toBeLessThanOrEqual(1);
  expect(blue, 'premise: the ring is drawn in the field').toBeGreaterThan(0);
  expect(
    extent / shorterSide,
    `ring spans ${extent} of ${shorterSide} px: at least 90% of the shorter side`,
  ).toBeGreaterThanOrEqual(0.9);
});

// ---------------------------------------------------------------------------
// C37
// ---------------------------------------------------------------------------

test('C37 a 1200 x 300 upload is stored at 4:1 with every ink edge of the source present', async ({ page }) => {
  const seeded = await seedOneSigner(2);
  const source = decodePng(fs.readFileSync(fixturePath('wide-1200x300')));
  const sourceInk = inkBox(source);

  expect(sourceInk, 'premise: the fixture has ink touching all four edges').toEqual({
    minX: 0,
    minY: 0,
    maxX: 1199,
    maxY: 299,
    width: 1200,
    height: 300,
  });

  await uploadInDialog(page, seeded, 'wide-1200x300');

  const stored = await confirmAndRead(page, seeded);

  const png = decodeStored(stored);
  const ratio = png.width / png.height;
  const box = inkBox(png);

  expect(box, 'premise: the stored image has ink').not.toBeNull();

  if (!box) {
    return;
  }

  // The source's frame is ink along every edge, so the stored ink box must keep a near-solid line on each of its edges.
  const depth = Math.max(2, Math.ceil(box.height * 0.02));
  const shares = {
    top: bestLineShare(png, box, 'row', range(box.minY, box.minY + depth)),
    bottom: bestLineShare(png, box, 'row', range(box.maxY - depth, box.maxY)),
    left: bestLineShare(png, box, 'column', range(box.minX, box.minX + depth)),
    right: bestLineShare(png, box, 'column', range(box.maxX - depth, box.maxX)),
  };
  const inkRatio = box.width / box.height;

  // Recorded, not asserted: whether the stored image is trimmed to the frame (ink box equals image bounds within
  // 1 px). The spec leaves padding to the implementer (section 6, "the crop threshold and padding"), so a padded
  // export is allowed; ratio, ink ratio and edge lines below carry the criterion.
  const inkBoxMatchesImage = box.minX <= 1 && box.minY <= 1 && box.maxX >= png.width - 2 && box.maxY >= png.height - 2;

  // The source's ink touches all four edges, so the expected crop is the whole source and maps onto the stored ink box.
  const mask = maskMismatches(source, { minX: 0, minY: 0, width: source.width, height: source.height }, png, box);

  await record('C37-stored', {
    width: png.width,
    height: png.height,
    ratio,
    box,
    inkRatio,
    shares,
    inkBoxMatchesImage,
    mask,
  });

  expect
    .soft(mask.mismatches, `the stored ink mask equals the source's, edge strokes included (${JSON.stringify(mask)})`)
    .toBe(0);

  expect.soft(ratio, `stored ${png.width} x ${png.height}: ratio between 3.92 and 4.08`).toBeGreaterThanOrEqual(3.92);
  expect.soft(ratio, `stored ${png.width} x ${png.height}: ratio between 3.92 and 4.08`).toBeLessThanOrEqual(4.08);
  expect
    .soft(inkRatio, 'the ink keeps the source frame 4:1 (no row or column of ink lost)')
    .toBeGreaterThanOrEqual(3.92);
  expect.soft(inkRatio, 'the ink keeps the source frame 4:1 (no row or column of ink lost)').toBeLessThanOrEqual(4.08);

  for (const [edge, share] of Object.entries(shares)) {
    expect.soft(share, `the source's ${edge} frame line is present in the stored image`).toBeGreaterThanOrEqual(0.9);
  }
});

// ---------------------------------------------------------------------------
// C38
// ---------------------------------------------------------------------------

test('C38 a photographed signature with faint edge strokes keeps every stroke after the user zooms and drags', async ({
  page,
}) => {
  const seeded = await seedOneSigner(2);
  const source = decodePng(fs.readFileSync(fixturePath('photo-faint-edges')));

  // Premise: the faint strokes (Y 205, 3 px thick) are ink by D1 and sit 3 to 5 px from each edge of the paper.
  for (const t of [0, 1, 2]) {
    expect(isInkAt(source, 600, 3 + t), 'premise: the top faint stroke is ink').toBe(true);
    expect(isInkAt(source, 600, 494 + t), 'premise: the bottom faint stroke is ink').toBe(true);
    expect(isInkAt(source, 3 + t, 250), 'premise: the left faint stroke is ink').toBe(true);
    expect(isInkAt(source, 1194 + t, 250), 'premise: the right faint stroke is ink').toBe(true);
  }

  const { dialog, canvas } = await uploadInDialog(page, seeded, 'photo-faint-edges');

  await expect.poll(async () => (await canvasDataUrl(canvas))?.length ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);

  const beforeZoomAndDrag = await canvasDataUrl(canvas);

  // The user's zoom and drag, a net identity: zoom in, zoom out, drag right 40 px and back.
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom out' }).click();

  const box = await boxOf(canvas);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 4 });
  await page.mouse.move(cx + 40, cy, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(cx + 40, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 4 });
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.mouse.up();

  // The sequence is meant as a net identity, so the expected crop is the whole photograph. If the canvas does
  // not return to its starting picture the rest of this test is not measuring what it claims.
  await expect
    .poll(async () => await canvasDataUrl(canvas), {
      message: 'premise: the zoom and drag sequence returns the upload canvas to its starting picture',
      timeout: 5_000,
    })
    .toBe(beforeZoomAndDrag);

  const stored = await confirmAndRead(page, seeded);

  const png = decodeStored(stored);
  const paper = opaqueBoundingBox(png);

  expect(paper, 'premise: the stored image holds the opaque paper').not.toBeNull();

  if (!paper) {
    return;
  }

  // The top and bottom faint strokes span 95% of their edges (1140 of 1200 px), the left and right 88% (440 of
  // 500 px); in the stored paper each must still be found near its edge.
  const nearV = Math.max(3, Math.ceil(paper.height * 0.03));
  const nearH = Math.max(3, Math.ceil(paper.width * 0.03));
  const shares = {
    top: bestLineShare(png, paper, 'row', range(paper.minY, paper.minY + nearV)),
    bottom: bestLineShare(png, paper, 'row', range(paper.maxY - nearV, paper.maxY)),
    left: bestLineShare(png, paper, 'column', range(paper.minX, paper.minX + nearH)),
    right: bestLineShare(png, paper, 'column', range(paper.maxX - nearH, paper.maxX)),
  };

  // The zoom and drag is a net identity, so the expected crop is the whole photograph, mapped onto the stored paper.
  const mask = maskMismatches(source, { minX: 0, minY: 0, width: source.width, height: source.height }, png, paper);

  await record('C38-stored', {
    width: png.width,
    height: png.height,
    ratio: png.width / png.height,
    paper,
    paperRatio: paper.width / paper.height,
    shares,
    mask,
  });

  expect
    .soft(
      mask.mismatches,
      `the stored ink mask equals the photograph's, faint edge strokes included (${JSON.stringify(mask)})`,
    )
    .toBe(0);

  for (const [edge, share] of Object.entries(shares)) {
    expect.soft(share, `the faint ${edge} edge stroke is in the stored image`).toBeGreaterThanOrEqual(0.8);
  }

  expect
    .soft(paper.width / paper.height, 'the whole photograph (1200 x 500) is in the stored image, none of it cut off')
    .toBeGreaterThanOrEqual(2.35);
  expect
    .soft(paper.width / paper.height, 'the whole photograph (1200 x 500) is in the stored image, none of it cut off')
    .toBeLessThanOrEqual(2.45);
});

test('C38 left zoomed in: the D1 ink visible on the upload canvas is what is stored, none of it cut off', async ({
  page,
}) => {
  const seeded = await seedOneSigner(2);
  const { dialog, canvas } = await uploadInDialog(page, seeded, 'photo-faint-edges');

  await expect.poll(async () => (await canvasDataUrl(canvas))?.length ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);

  const initial = await canvasDataUrl(canvas);

  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await expect
    .poll(async () => await canvasDataUrl(canvas), { message: 'premise: Zoom in redraws the canvas', timeout: 5_000 })
    .not.toBe(initial);

  // What the user sees: the upload canvas's own pixels, scored with D1.
  const visibleUrl = await canvasDataUrl(canvas);

  expect(visibleUrl?.startsWith(P), 'premise: the upload canvas exports a PNG').toBe(true);

  const visible = decodePng(Buffer.from((visibleUrl ?? '').slice(P.length), 'base64'));
  const visibleInk = inkBox(visible);

  expect(visibleInk, 'premise: ink is visible on the zoomed canvas').not.toBeNull();

  const stored = await confirmAndRead(page, seeded);
  const png = decodeStored(stored);
  const storedInk = inkBox(png);

  expect(storedInk, 'premise: the stored image has ink').not.toBeNull();

  if (!visibleInk || !storedInk) {
    return;
  }

  // Ink pixels inside each ink box, as a share of that box: the same picture at another scale keeps it.
  const shareInBox = (image: PNG, box: NonNullable<ReturnType<typeof inkBox>>) => {
    let ink = 0;

    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        ink += isInkAt(image, x, y) ? 1 : 0;
      }
    }

    return ink / (box.width * box.height);
  };

  const visibleRatio = visibleInk.width / visibleInk.height;
  const storedRatio = storedInk.width / storedInk.height;
  const visibleShare = shareInBox(visible, visibleInk);
  const storedShare = shareInBox(png, storedInk);

  // The expected crop is the ink visible on the zoomed canvas, mapped onto the stored ink box.
  const mask = maskMismatches(visible, visibleInk, png, storedInk);

  await record('C38-zoomed-stored', {
    visible: { width: visible.width, height: visible.height, ink: visibleInk, share: visibleShare },
    stored: { width: png.width, height: png.height, ink: storedInk, share: storedShare },
    mask,
  });

  expect
    .soft(storedRatio / visibleRatio, `the stored ink has the visible ink's shape (${storedRatio} vs ${visibleRatio})`)
    .toBeGreaterThanOrEqual(0.95);
  expect
    .soft(storedRatio / visibleRatio, `the stored ink has the visible ink's shape (${storedRatio} vs ${visibleRatio})`)
    .toBeLessThanOrEqual(1.05);
  // No density allowance (spec, "Round after Codex r1"): the stored ink mask equals the visible one.
  expect
    .soft(
      mask.mismatches,
      `the stored ink mask equals the ink visible on the zoomed canvas (${JSON.stringify({ ...mask, storedShare, visibleShare })})`,
    )
    .toBe(0);
});

// ---------------------------------------------------------------------------
// C39
// ---------------------------------------------------------------------------

/** The C35-C38 uploads, each into its own SIGNATURE field of one V2 envelope. */
const C39_UPLOADS = [
  { key: 'ring', fixture: 'ring-600x600' },
  { key: 'wide', fixture: 'wide-1200x300' },
  { key: 'photo', fixture: 'photo-faint-edges' },
];

test('C39 zoom and drag redraw the upload before confirming, and every C35-C38 upload as stored passes the server check', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // One envelope per upload: on V2 a signature stored on an envelope is offered again, inserted on one click,
  // for the recipient's next signature field, so a second field would not open the dialog.
  const stored: Record<string, string> = {};

  for (const [index, upload] of C39_UPLOADS.entries()) {
    const seeded = await seedOneSigner(2);
    const { dialog, canvas } = await uploadInDialog(page, seeded, upload.fixture);

    if (index === 0) {
      const initial = await canvasDataUrl(canvas);

      await dialog.getByRole('button', { name: 'Zoom in' }).click();
      await expect
        .poll(async () => await canvasDataUrl(canvas), { message: 'Zoom in redraws the upload canvas', timeout: 5_000 })
        .not.toBe(initial);

      const zoomed = await canvasDataUrl(canvas);

      const box = await boxOf(canvas);

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 10, { steps: 6 });
      await page.mouse.up();

      await expect
        .poll(async () => await canvasDataUrl(canvas), { message: 'dragging moves the zoomed image', timeout: 5_000 })
        .not.toBe(zoomed);
    }

    stored[upload.key] = await confirmAndRead(page, seeded);
  }

  const checked: Record<string, number> = {};

  for (const [key, value] of Object.entries(stored)) {
    const fresh = await seedOneSigner(2);
    const reply = await signV2(request, fresh.r.s1.token, fresh.r.s1.fields.sig.id, {
      type: FieldType.SIGNATURE,
      value,
    });

    checked[key] = reply.status;
    expect
      .soft(reply.status, `the stored ${key} upload is accepted by the server: ${reply.body.slice(0, 200)}`)
      .toBe(200);
    expect.soft((await fieldState(fresh.r.s1.fields.sig.id)).inserted, `the ${key} field is inserted`).toBe(true);
  }

  await record('C39-server-check', checked);

  expect(Object.keys(checked), 'premise: every upload was stored and checked').toEqual(
    C39_UPLOADS.map((upload) => upload.key),
  );
});
