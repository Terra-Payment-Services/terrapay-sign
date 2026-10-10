/**
 * Fixtures and oracles for the placeholder-field specs.
 *
 * Written from the specification alone, without reading the implementation of
 * create-envelope-fields.ts.
 *
 * Whether a placeholder still shows is judged by poppler, never by Sign: the
 * page is rendered with pdftoppm and the placeholder's own rectangle (the
 * saved field's position) is checked for ink. The specification names
 * pdftotext for this, but pdftotext reads text that a white rectangle merely
 * covers: on the unfixed code, a single uncontested request whose whiteout is
 * visibly in place still yields the placeholder text through pdftotext (probe
 * run 2026-10-07), so it cannot tell a covered placeholder from a visible one.
 * Rendering answers the criterion's own question, whether the PDF shows it.
 *
 * Database state is read through Prisma for assertions only.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';
import { PDF, StandardFonts } from '@libpdf/core';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiCreateEnvelope, apiCreateRecipients, apiCreateTestContext } from './api-seeds';
import { API_BASE_URL, readPageTextWithPdftotext } from './protected-pdfs';

/** Placeholder A and placeholder B, each reserved for API placement (no recipient). */
export const PLACEHOLDER_A = '{{signature}}';
export const PLACEHOLDER_B = '{{initials}}';

/** The field type each placeholder is placed as, so a saved field maps back to its placeholder. */
export const PLACEHOLDER_FIELD_TYPE = {
  [PLACEHOLDER_A]: FieldType.SIGNATURE,
  [PLACEHOLDER_B]: FieldType.INITIALS,
} as const;

/** A lowercase marker unique to one test, drawn into its PDF so its DocumentData rows can be told apart. */
export const uniqueMarker = () =>
  `pfmarker${Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;

/**
 * A one-page PDF carrying the marker as ordinary text and each placeholder on
 * its own line, written by @libpdf/core in the same way as the repository's
 * other placeholder fixtures.
 */
export const buildPlaceholderPdf = async (marker: string, placeholders: string[] = [PLACEHOLDER_A, PLACEHOLDER_B]) => {
  const pdf = PDF.create();
  const page = pdf.addPage({ size: 'letter' });

  page.drawText(`Agreement reference ${marker}`, { x: 50, y: 720, font: StandardFonts.Helvetica, size: 14 });

  placeholders.forEach((placeholder, index) => {
    page.drawText(placeholder, { x: 50, y: 600 - index * 150, font: StandardFonts.Helvetica, size: 12 });
  });

  return Buffer.from(await pdf.save());
};

export const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.documenso.com`;

/** A fresh user, team and token, a draft holding `file` as its only item, and one signer. */
export const seedPlaceholderDraft = async (request: APIRequestContext, label: string, file: Buffer) => {
  const context = await apiCreateTestContext(label);
  const { id: envelopeId } = await apiCreateEnvelope(request, context.token, {
    title: `Placeholder fields ${label}`,
    pdfFile: { name: `${label}.pdf`, data: file },
  });
  const { data: recipients } = await apiCreateRecipients(request, context.token, envelopeId, [
    { email: uniqueEmail(label), name: 'Placeholder Signer' },
  ]);

  return { ...context, envelopeId, recipientId: recipients[0].id };
};

export const createFields = async (
  request: APIRequestContext,
  token: string,
  envelopeId: string,
  data: Array<Record<string, unknown>>,
) =>
  await request.post(`${API_BASE_URL}/envelope/field/create-many`, {
    headers: jsonHeaders(token),
    data: { envelopeId, data },
  });

export const placeholderField = (recipientId: number, placeholder: keyof typeof PLACEHOLDER_FIELD_TYPE) => ({
  recipientId,
  type: PLACEHOLDER_FIELD_TYPE[placeholder],
  placeholder,
});

export const bodyOf = async (res: APIResponse) => {
  const text = await res.text();

  try {
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { text, body: {} as Record<string, unknown> };
  }
};

/** The bytes the envelope item currently points at. */
export const readCurrentItemPdf = async (envelopeItemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({
    where: { id: envelopeItemId },
    include: { documentData: true },
  });

  return { documentDataId: item.documentDataId, bytes: new Uint8Array(await getFileServerSide(item.documentData)) };
};

const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-placeholder-render-'));

let renderCounter = 0;

/** A greyscale rendering of one page at 72 dpi by poppler pdftoppm, one byte per pixel. */
export const renderPageGrey = (bytes: Uint8Array, page = 1) => {
  renderCounter += 1;

  const base = path.join(renderDir, `${process.pid}-${renderCounter}`);

  fs.writeFileSync(`${base}.pdf`, bytes);

  const result = spawnSync('pdftoppm', ['-gray', '-r', '72', '-f', `${page}`, '-l', `${page}`, `${base}.pdf`, base], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr}`);
  }

  const file = fs
    .readdirSync(renderDir)
    .find((name) => name.startsWith(`${path.basename(base)}-`) && name.endsWith('.pgm'));

  if (!file) {
    throw new Error('pdftoppm wrote no page image');
  }

  const pgm = fs.readFileSync(path.join(renderDir, file));
  const [magic, size, maxValue] = pgm.subarray(0, 64).toString('latin1').split('\n');
  const headerLength = `${magic}\n${size}\n${maxValue}\n`.length;
  const [width, height] = size.split(' ').map(Number);

  if (magic !== 'P5') {
    throw new Error(`pdftoppm wrote ${magic}, not a binary greyscale image`);
  }

  return { width, height, pixels: pgm.subarray(headerLength) };
};

export type FieldRect = {
  positionX: unknown;
  positionY: unknown;
  width: unknown;
  height: unknown;
};

/** Pixels darker than mid-grey inside a field's rectangle, which is given in percent of the page. */
export const inkInRect = (render: ReturnType<typeof renderPageGrey>, rect: FieldRect) => {
  const { width, height, pixels } = render;
  const [x, y, w, h] = [rect.positionX, rect.positionY, rect.width, rect.height].map(Number);
  const x0 = Math.floor((x / 100) * width);
  const y0 = Math.floor((y / 100) * height);
  const x1 = Math.min(width, Math.ceil(((x + w) / 100) * width));
  const y1 = Math.min(height, Math.ceil(((y + h) / 100) * height));

  let ink = 0;

  for (let row = y0; row < y1; row += 1) {
    for (let column = x0; column < x1; column += 1) {
      if (pixels[row * width + column] < 160) {
        ink += 1;
      }
    }
  }

  return ink;
};

export const compact = (text: string) => text.replace(/\s+/g, '');

/** The database clock, so row timestamps are compared with the clock that wrote them. */
export const databaseNow = async () => {
  const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;

  return row.now;
};

/**
 * The ids of every DocumentData row that belongs to this test: rows owned by
 * the test's user or team, and rows written since `since` whose PDF carries
 * the test's marker (pdftotext). The second set catches a row whatever owner
 * columns the request filled in, including none.
 */
export const documentDataOfTest = async ({
  userId,
  teamId,
  marker,
  since,
}: {
  userId: number;
  teamId: number;
  marker: string;
  since: Date;
}) => {
  const owned = await prisma.documentData.findMany({
    where: { OR: [{ userId }, { teamId }] },
    select: { id: true },
  });
  const recent = await prisma.documentData.findMany({ where: { createdAt: { gte: since } } });
  const ids = new Set(owned.map((row) => row.id));

  for (const row of recent) {
    if (ids.has(row.id)) {
      continue;
    }

    try {
      const bytes = new Uint8Array(await getFileServerSide(row));

      if (compact(readPageTextWithPdftotext(bytes)).includes(marker)) {
        ids.add(row.id);
      }
    } catch {
      // A row that is not a readable PDF is not this test's PDF.
    }
  }

  return ids;
};

/** Retryable refusals a concurrency fix may answer with: conflict, locked, too many requests, unavailable. */
export const RETRYABLE_STATUSES = [409, 423, 429, 503];
