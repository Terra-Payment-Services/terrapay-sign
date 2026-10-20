/**
 * Page helpers for the G4 pad specs (the upload shape, the press that opened
 * the dialog): opening the V2 and V1 signing pages for a Prisma-seeded
 * envelope, finding a field on the V2 Konva canvas, reading a pad canvas's
 * pixels, and rendering a box of a sealed PDF with pdftoppm.
 *
 * Elements are located by the test ids, roles and labels the pages render; the
 * pad's own logic is not read.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { expect, type Locator, type Page } from '@playwright/test';

import type { G4Seeded } from './signature-ink';

export const PDF_PAGE_SELECTOR = 'img[data-page-number]';

/** Opens the V2 signing page for `token` and waits for the Konva canvas. */
export const openV2SigningPage = async (page: Page, token: string) => {
  await page.goto(`/sign/${token}`);
  await expect(page.locator(PDF_PAGE_SELECTOR).first()).toBeVisible({ timeout: 30_000 });

  const konva = page.locator('.konva-container canvas').first();

  await expect(konva).toBeVisible({ timeout: 30_000 });

  return konva;
};

/** The page coordinates of the centre of a field, from its stored box (percent of the page). */
export const fieldCentre = async (page: Page, fieldId: number) => {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: fieldId } });
  const konva = page.locator('.konva-container canvas').first();
  const box = await konva.boundingBox();

  if (!box) {
    throw new Error('The signing canvas has no bounding box');
  }

  return {
    x: box.x + ((Number(field.positionX) + Number(field.width) / 2) / 100) * box.width,
    y: box.y + ((Number(field.positionY) + Number(field.height) / 2) / 100) * box.height,
  };
};

export const signDialog = (page: Page) => page.getByRole('dialog');

export const signButton = (page: Page) => signDialog(page).getByRole('button', { name: 'Sign', exact: true });

/** Clicks the field on the V2 page and waits for the signature dialog. */
export const openV2FieldDialog = async (page: Page, fieldId: number) => {
  const centre = await fieldCentre(page, fieldId);

  await page.mouse.click(centre.x, centre.y);
  await expect(signDialog(page)).toBeVisible();

  return signDialog(page);
};

export const boxOf = async (locator: Locator) => {
  await expect(locator).toBeVisible();

  const box = await locator.boundingBox();

  if (!box) {
    throw new Error('Element has no bounding box');
  }

  return box;
};

/** Pixels of a pad canvas with alpha > 0, overall and inside an x-range given as fractions of the canvas width. */
export const canvasInk = async (canvas: Locator, ranges: Array<[number, number]> = []) =>
  await canvas.evaluate((element, xRanges) => {
    const node = element as HTMLCanvasElement;
    const context = node.getContext('2d');

    if (!context) {
      return { total: -1, inRanges: [] as number[], width: 0, height: 0 };
    }

    const { data } = context.getImageData(0, 0, node.width, node.height);
    const inRanges = xRanges.map(() => 0);
    let total = 0;

    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        total++;

        const x = ((i - 3) / 4) % node.width;

        xRanges.forEach(([from, to], index) => {
          if (x >= from * node.width && x < to * node.width) {
            inRanges[index]++;
          }
        });
      }
    }

    return { total, inRanges, width: node.width, height: node.height };
  }, ranges);

/** The canvas's backing store as a data URL, to tell whether a zoom or drag redrew it. */
export const canvasDataUrl = async (canvas: Locator) =>
  await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL('image/png'));

/** A zig-zag stroke inside `box` between the given fractions, mouse already down. */
export const zigZag = async (
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  from: number,
  to: number,
  passes = 3,
) => {
  for (let pass = 0; pass < passes; pass++) {
    const y = box.y + box.height * (0.25 + (0.5 * pass) / Math.max(passes - 1, 1));

    for (let step = 0; step <= 12; step++) {
      const t = pass % 2 === 0 ? step / 12 : 1 - step / 12;

      await page.mouse.move(box.x + box.width * (from + (to - from) * t), y + (step % 2 === 0 ? 0 : 10));
    }
  }
};

/** A full stroke that clears the 1% coverage threshold on its own. */
export const drawStroke = async (page: Page, canvas: Locator) => {
  const box = await boxOf(canvas);

  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.25);
  await page.mouse.down();
  await zigZag(page, box, 0.15, 0.85);
  await page.mouse.up();
};

/** Waits for the Signature row of a field and returns its stored image. */
export const storedImage = async (fieldId: number) => {
  await expect
    .poll(async () => (await prisma.signature.findUnique({ where: { fieldId } }))?.signatureImageAsBase64 ?? null, {
      message: `a stored signature image for field ${fieldId}`,
      timeout: 15_000,
    })
    .not.toBeNull();

  return (await prisma.signature.findUniqueOrThrow({ where: { fieldId } })).signatureImageAsBase64 ?? '';
};

/** The sealed PDF of the envelope's first item. */
export const sealedPdf = async (seeded: G4Seeded) => {
  const item = await prisma.envelopeItem.findFirstOrThrow({
    where: { envelopeId: seeded.envelopeId },
    include: { documentData: true },
  });

  return Buffer.from(
    await getFileServerSide({ type: item.documentData.type, data: item.documentData.data } as Parameters<
      typeof getFileServerSide
    >[0]),
  );
};

/**
 * Renders a box of page 1 (percent of the page) at 72 dpi in colour and
 * returns its RGB pixels with the box's size in pixels.
 */
export const renderBox = (
  pdf: Buffer,
  box: { positionX: number; positionY: number; width: number; height: number },
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-seal-'));
  const file = path.join(dir, 'sealed.pdf');

  fs.writeFileSync(file, pdf);

  const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout;
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);

  if (!size) {
    throw new Error(`pdfinfo gave no page size: ${info}`);
  }

  const pageWidth = Number(size[1]);
  const pageHeight = Number(size[2]);
  const x = Math.round((box.positionX / 100) * pageWidth);
  const y = Math.round((box.positionY / 100) * pageHeight);
  const width = Math.round((box.width / 100) * pageWidth);
  const height = Math.round((box.height / 100) * pageHeight);

  const result = spawnSync(
    'pdftoppm',
    [
      '-f',
      '1',
      '-l',
      '1',
      '-r',
      '72',
      '-x',
      String(x),
      '-y',
      String(y),
      '-W',
      String(width),
      '-H',
      String(height),
      file,
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );

  fs.rmSync(dir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr.toString()}`);
  }

  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(result.stdout.subarray(0, 32).toString('latin1'));

  if (!header) {
    throw new Error('pdftoppm did not write a binary PPM');
  }

  return {
    width: Number(header[1]),
    height: Number(header[2]),
    rgb: result.stdout.subarray(header[0].length),
  };
};
