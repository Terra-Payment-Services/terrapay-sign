/**
 * Pages that inherit their MediaBox or Rotate from /Pages are sized correctly.
 *
 * Written from the specification before
 * any fix, without reading the patch. Envelopes go in through API V2,
 * recipients sign through their own endpoints, the seal job runs inside the
 * server, and the sealed PDF is read with poppler, which honours inherited
 * boxes and so shows what any PDF reader shows.
 *
 * | Test                                                        | Criterion |
 * | ----------------------------------------------------------- | --------- |
 * | C1 hand-placed field on an inherited A4 page                | C1        |
 * | C2 the same field near the top of the page                  | C2        |
 * | C3 a placeholder is stored at its position on the A4 page   | C3        |
 * | C4 the placeholder field seals over the placeholder         | C4        |
 * | C5 appended certificate and audit pages are A4              | C5        |
 * | C6 an inherited Rotate 90 survives and fields land on it    | C6        |
 * | C7 inherited bytes stored before the fix seal correctly     | C7        |
 * | C8 the A4, letter and tabloid assets still seal correctly   | C8        |
 *
 * "None in the same-size box 50pt lower": an 8 percent field on A4 is about
 * 67pt tall, so the box 50pt lower shares its top 17pt with the placed box,
 * where a correctly placed signature may well have ink. The check therefore
 * covers the part of the lower box outside the placed box, the 50pt strip
 * under the placed box's bottom edge. A field drawn as if the page were
 * 612x792 sits about 16pt low at positionY 68 and about 48pt low at
 * positionY 5, and its ink reaches into that strip in both cases.
 *
 * Needs poppler-utils (pdfinfo, pdftoppm) on PATH.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { measureText, StandardFonts } from '@libpdf/core';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentDataType, DocumentStatus, FieldType } from '@prisma/client';

import {
  apiCreateEnvelope,
  apiCreateRecipients,
  apiDistributeEnvelope,
  apiSeedPendingDocument,
} from '../../fixtures/api-seeds';
import {
  A4_HEIGHT,
  A4_WIDTH,
  buildInheritedA4Pdf,
  buildInheritedPlaceholderPdf,
  buildInheritedRotatedA4Pdf,
  buildOnPagePlaceholderPdf,
  INHERITED_PLACEHOLDER,
  PLACEHOLDER_ORIGIN,
} from '../../fixtures/inherited-page-box';
import { API_BASE_URL, downloadEnvelopeItem, trpcMutation } from '../../fixtures/protected-pdfs';

test.describe.configure({ mode: 'parallel' });

const ASSETS_DIR = path.join(__dirname, '../../../../../assets');

/** A field box in percent of the page as a viewer shows it. */
type Box = { positionX: number; positionY: number; width: number; height: number };

const FIELD_LOW = { positionX: 10, positionY: 68, width: 30, height: 8 };
const FIELD_TOP = { positionX: 10, positionY: 5, width: 30, height: 8 };

/** Pixels darker than mid-grey that a filled signature must at least reach. */
const MIN_INK = 20;

// ---------------------------------------------------------------------------
// Seeding and driving the envelope
// ---------------------------------------------------------------------------

const apiContext = async (name: string) => {
  const { user, team } = await seedUser();
  const { token } = await createApiToken({ userId: user.id, teamId: team.id, tokenName: name, expiresIn: null });

  return { user, team, token };
};

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** One signer with one signature field at `box` on page 1 of `pdf`, distributed. */
const seedOneSigner = async (request: APIRequestContext, label: string, pdf: Buffer, box: Box) => {
  const context = await apiContext(label);
  const id = stamp();

  const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
    context,
    title: `Inherited page box ${label} ${id}`,
    recipients: [{ email: `${label}-${id}@test.documenso.com`, name: 'Box Signer' }],
    fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, ...box }]],
    pdfFile: { name: `${label}.pdf`, data: pdf },
  });

  const [recipient] = distributeResult.recipients;
  const field = envelope.fields.find((candidate) => candidate.recipientId === recipient.id);

  if (!field) {
    throw new Error(`No field for recipient ${recipient.id}`);
  }

  return {
    envelopeId: envelope.id,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
    itemId: envelope.envelopeItems[0].id,
    token: context.token,
    recipientToken: recipient.token,
    fieldId: field.id,
  };
};

const signAndComplete = async (
  request: APIRequestContext,
  { recipientToken, fieldId, documentId }: { recipientToken: string; fieldId: number; documentId: number },
) => {
  await trpcMutation(request, 'envelope.field.sign', {
    token: recipientToken,
    fieldId,
    fieldValue: { type: FieldType.SIGNATURE, value: 'Alice Signer' },
  });

  await trpcMutation(request, 'recipient.completeDocumentWithToken', { token: recipientToken, documentId });
};

const waitForStatus = async (envelopeId: string, status: DocumentStatus) => {
  await expect(async () => {
    const current = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });

    expect(current.status).toBe(status);
  }).toPass({ timeout: 60_000 });
};

/** Seed, sign, wait for the seal and return the sealed bytes of the item. */
const sealWithField = async (request: APIRequestContext, label: string, pdf: Buffer, box: Box) => {
  const seeded = await seedOneSigner(request, label, pdf, box);

  await signAndComplete(request, seeded);
  await waitForStatus(seeded.envelopeId, DocumentStatus.COMPLETED);

  const sealed = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');

  await attachPdf(`${label}-sealed.pdf`, sealed);

  return sealed;
};

/** Keep the sealed PDF with the run, so a failure can be looked at rather than guessed at. */
const attachPdf = async (name: string, bytes: Uint8Array) =>
  await test.info().attach(name, { body: Buffer.from(bytes), contentType: 'application/pdf' });

const readItemBytes = async (itemId: string) => {
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: itemId }, include: { documentData: true } });

  return new Uint8Array(await getFileServerSide(item.documentData));
};

// ---------------------------------------------------------------------------
// Reading the PDF with poppler
// ---------------------------------------------------------------------------

const withTempPdf = <T>(bytes: Uint8Array, use: (file: string, dir: string) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-box-'));
  const file = path.join(dir, 'doc.pdf');

  fs.writeFileSync(file, bytes);

  try {
    return use(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

type Render = { width: number; height: number; pixels: Buffer };

/**
 * Page 1 rendered to grey at 72 dpi, so one pixel is one point. pdftoppm
 * applies /Rotate as pdf.js does, so the raster is the page as a viewer shows
 * it, and percentages are taken against the raster's own size. (pdfinfo's
 * "Page size" is unrotated, which is why the seal spec's inkInBox is not
 * copied as it stands.)
 */
const renderFirstPage = (bytes: Uint8Array): Render =>
  withTempPdf(bytes, (file, dir) => {
    const base = path.join(dir, 'page');
    const result = spawnSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '72', '-gray', file, base], { encoding: 'utf8' });

    if (result.status !== 0) {
      throw new Error(`pdftoppm failed: ${result.stderr}`);
    }

    const image = fs.readdirSync(dir).find((name) => name.endsWith('.pgm'));

    if (!image) {
      throw new Error('pdftoppm wrote no page image');
    }

    const pgm = fs.readFileSync(path.join(dir, image));
    const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 32).toString('latin1'));

    if (!header) {
      throw new Error('pdftoppm did not write a binary PGM');
    }

    return { width: Number(header[1]), height: Number(header[2]), pixels: pgm.subarray(header[0].length) };
  });

/** Dark pixels inside a rectangle given in raster pixels (points), clipped to the page. */
const inkInPixels = (render: Render, rect: { x0: number; y0: number; x1: number; y1: number }) => {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(render.width, Math.ceil(rect.x1));
  const y1 = Math.min(render.height, Math.ceil(rect.y1));

  let ink = 0;

  for (let row = y0; row < y1; row += 1) {
    for (let column = x0; column < x1; column += 1) {
      if (render.pixels[row * render.width + column] < 128) {
        ink += 1;
      }
    }
  }

  return ink;
};

const boxToPixels = (render: Render, box: Box) => ({
  x0: (box.positionX / 100) * render.width,
  y0: (box.positionY / 100) * render.height,
  x1: ((box.positionX + box.width) / 100) * render.width,
  y1: ((box.positionY + box.height) / 100) * render.height,
});

/** Ink inside the placed box. */
const inkInBox = (render: Render, box: Box) => inkInPixels(render, boxToPixels(render, box));

/**
 * Ink in the same-size box 50pt lower, outside the placed box: the 50pt strip
 * under the box's bottom edge. By default the strip starts one point below
 * the edge, to leave anti-aliasing on the edge out; `gap` moves its start
 * further down for a field whose text may legitimately overhang the box.
 */
const inkBelowBox = (render: Render, box: Box, gap = 1) => {
  const placed = boxToPixels(render, box);

  return inkInPixels(render, { x0: placed.x0, y0: placed.y1 + gap, x1: placed.x1, y1: placed.y1 + 50 });
};

/** The typed-signature font size Sign draws at when the field sets none (DEFAULT_SIGNATURE_TEXT_FONT_SIZE). */
const SIGNATURE_FONT_SIZE = 18;

const expectInkInPlacedBoxOnly = (sealed: Uint8Array, box: Box, label: string) => {
  const render = renderFirstPage(sealed);

  expect(inkInBox(render, box), `${label}: ink inside the placed box`).toBeGreaterThan(MIN_INK);
  expect(inkBelowBox(render, box), `${label}: no ink in the box 50pt lower`).toBe(0);
};

const pdfinfoPages = (bytes: Uint8Array) =>
  withTempPdf(bytes, (file) => {
    const result = spawnSync('pdfinfo', ['-f', '1', '-l', '9999', file], { encoding: 'utf8' });

    if (result.status !== 0) {
      throw new Error(`pdfinfo failed: ${result.stderr}`);
    }

    const sizes = [...result.stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)].map((match) => ({
      page: Number(match[1]),
      width: Math.round(Number(match[2])),
      height: Math.round(Number(match[3])),
    }));
    const rotations = new Map(
      [...result.stdout.matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)].map((match) => [Number(match[1]), Number(match[2])]),
    );

    return sizes.map((size) => ({ ...size, rotation: rotations.get(size.page) }));
  });

// ---------------------------------------------------------------------------
// The placeholder, located from the fixture's own constants
// ---------------------------------------------------------------------------

/** Placeholder glyph box in percent of a 595.28 x 841.89 page, top-left origin. */
const placeholderGlyphBox = () => {
  const width = measureText(INHERITED_PLACEHOLDER, StandardFonts.Helvetica, PLACEHOLDER_ORIGIN.size);
  // Helvetica ascender 718 and descender -207 per 1000 em (Adobe AFM).
  const top = PLACEHOLDER_ORIGIN.y + 0.718 * PLACEHOLDER_ORIGIN.size;
  const bottom = PLACEHOLDER_ORIGIN.y - 0.207 * PLACEHOLDER_ORIGIN.size;

  return {
    positionX: (PLACEHOLDER_ORIGIN.x / A4_WIDTH) * 100,
    positionY: ((A4_HEIGHT - top) / A4_HEIGHT) * 100,
    width: (width / A4_WIDTH) * 100,
    height: ((top - bottom) / A4_HEIGHT) * 100,
  };
};

/** The band positionY may fall in for the placeholder: from a full em above the baseline to the baseline, 3pt slack. */
const PLACEHOLDER_Y_BAND = {
  min: ((A4_HEIGHT - (PLACEHOLDER_ORIGIN.y + PLACEHOLDER_ORIGIN.size + 3)) / A4_HEIGHT) * 100,
  max: ((A4_HEIGHT - (PLACEHOLDER_ORIGIN.y - 3)) / A4_HEIGHT) * 100,
};

/** 50 / 595.28, in percent. */
const PLACEHOLDER_X_PERCENT = 8.4;

/**
 * The route the placeholders guide gives for `r1` to land on a signer: an
 * envelope with an ordinary PDF, one signer, then the placeholder PDF added
 * as a second item.
 */
const uploadPlaceholderItem = async (request: APIRequestContext, label: string, file: Buffer) => {
  const context = await apiContext(label);
  const id = stamp();
  const { id: envelopeId } = await apiCreateEnvelope(request, context.token, {
    title: `Inherited placeholder ${label} ${id}`,
    pdfFile: { name: 'a4-size.pdf', data: fs.readFileSync(path.join(ASSETS_DIR, 'a4-size.pdf')) },
  });
  const { data: recipients } = await apiCreateRecipients(request, context.token, envelopeId, [
    { email: `${label}-${id}@test.documenso.com`, name: 'Placeholder Signer' },
  ]);

  const formData = new FormData();

  formData.append('payload', JSON.stringify({ envelopeId }));
  formData.append('files', new File([file], `${label}.pdf`, { type: 'application/pdf' }));

  const added = await request.post(`${API_BASE_URL}/envelope/item/create-many`, {
    headers: { Authorization: `Bearer ${context.token}` },
    multipart: formData,
  });

  expect(added.status(), `item/create-many refused the placeholder PDF: ${await added.text()}`).toBe(200);

  const item = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId, order: { gt: 1 } } });
  const fields = await prisma.field.findMany({ where: { envelopeItemId: item.id } });

  expect(fields.length, `${label}: one field placed from the placeholder`).toBe(1);
  expect(fields[0].recipientId, `${label}: r1 maps to the signer`).toBe(recipients[0].id);

  return { context, envelopeId, itemId: item.id, field: fields[0] };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeAll(() => {
  for (const tool of ['pdftoppm', 'pdfinfo']) {
    const found = spawnSync(tool, ['-v'], { encoding: 'utf8' });

    expect(found.error, `${tool} (poppler-utils) must be on PATH`).toBeUndefined();
  }
});

test('C1 a hand-placed field on an inherited A4 page seals inside its box', async ({ request }) => {
  test.setTimeout(120_000);

  // Control: low on the page the US Letter offset is about 12pt, inside the box, so this passes on
  // main too. C2 and C7 place the field near the top, where the offset shows.

  const sealed = await sealWithField(request, 'c1', await buildInheritedA4Pdf(), FIELD_LOW);

  expectInkInPlacedBoxOnly(sealed, FIELD_LOW, 'C1');
});

test('C2 a field near the top of an inherited A4 page seals inside its box', async ({ request }) => {
  test.setTimeout(120_000);

  const sealed = await sealWithField(request, 'c2', await buildInheritedA4Pdf(), FIELD_TOP);

  expectInkInPlacedBoxOnly(sealed, FIELD_TOP, 'C2');
});

test('C3 a placeholder on an inherited A4 page is stored at its position on the A4 page', async ({ request }) => {
  test.setTimeout(120_000);

  // positionX alone would not tell the pages apart (50/612 is 8.17, inside
  // the tolerance of 8.40); positionY differs by over 4 points, and carries
  // the criterion.
  const control = await uploadPlaceholderItem(request, 'c3-control', await buildOnPagePlaceholderPdf());
  const controlY = Number(control.field.positionY);

  expect(Number(control.field.positionX), 'control positionX').toBeGreaterThan(PLACEHOLDER_X_PERCENT - 0.5);
  expect(Number(control.field.positionX), 'control positionX').toBeLessThan(PLACEHOLDER_X_PERCENT + 0.5);
  expect(controlY, 'control positionY is the placeholder on an A4 page').toBeGreaterThan(PLACEHOLDER_Y_BAND.min);
  expect(controlY, 'control positionY is the placeholder on an A4 page').toBeLessThan(PLACEHOLDER_Y_BAND.max);

  const inherited = await uploadPlaceholderItem(request, 'c3', await buildInheritedPlaceholderPdf());
  const x = Number(inherited.field.positionX);
  const y = Number(inherited.field.positionY);

  expect(x, 'positionX within 0.5 points of 50/595.28').toBeGreaterThan(PLACEHOLDER_X_PERCENT - 0.5);
  expect(x, 'positionX within 0.5 points of 50/595.28').toBeLessThan(PLACEHOLDER_X_PERCENT + 0.5);
  expect(Math.abs(y - controlY), `positionY ${y} within 0.5 points of the A4 control's ${controlY}`).toBeLessThan(0.5);
});

test('C4 the placeholder field on an inherited A4 page seals over the placeholder', async ({ request }) => {
  test.setTimeout(120_000);

  const { context, envelopeId, itemId, field } = await uploadPlaceholderItem(
    request,
    'c4',
    await buildInheritedPlaceholderPdf(),
  );
  const glyphs = placeholderGlyphBox();

  // The guide covers placeholder text once the field exists, so any ink found
  // there after sealing is the signature.
  expect(inkInBox(renderFirstPage(await readItemBytes(itemId)), glyphs), 'premise: placeholder covered').toBe(0);

  const distributed = await apiDistributeEnvelope(request, context.token, envelopeId);
  const envelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId } });
  const recipient = distributed.recipients.find((candidate) => candidate.id === field.recipientId);

  if (!recipient) {
    throw new Error('The placeholder field has no distributed recipient');
  }

  await signAndComplete(request, {
    recipientToken: recipient.token,
    fieldId: field.id,
    documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
  });
  await waitForStatus(envelopeId, DocumentStatus.COMPLETED);

  const sealed = await downloadEnvelopeItem(request, context.token, itemId, 'signed');

  await attachPdf('c4-sealed.pdf', sealed);

  const render = renderFirstPage(sealed);

  expect(inkInBox(render, glyphs), 'ink over the placeholder position').toBeGreaterThan(MIN_INK);

  // The stored field may be taller than the glyphs, so the strip starts under
  // the field's own bottom edge, which C3 pins to the placeholder.
  const fieldBox = {
    positionX: Number(field.positionX),
    positionY: Number(field.positionY),
    width: Number(field.width),
    height: Number(field.height),
  };

  // A placeholder field is only as tall as its text, 12pt here, and the
  // typed signature is drawn at 18pt centred on it, so a correctly placed
  // signature's descenders overhang the box bottom by a few points. The strip
  // therefore starts one signature font size below the box bottom.
  expect(
    inkBelowBox(render, fieldBox, SIGNATURE_FONT_SIZE),
    'no ink from 18pt to 50pt below the placeholder field',
  ).toBe(0);
});

test('C5 certificate and audit pages appended to an inherited A4 document are A4', async ({ request }) => {
  test.setTimeout(120_000);

  const sealed = await sealWithField(request, 'c5', await buildInheritedA4Pdf(), FIELD_LOW);
  const pages = pdfinfoPages(sealed);

  expect(pages.length, 'the sealed PDF has appended pages').toBeGreaterThan(1);

  for (const page of pages.slice(1)) {
    expect({ page: page.page, width: page.width, height: page.height }, `appended page ${page.page}`).toEqual({
      page: page.page,
      width: 595,
      height: 842,
    });
  }
});

test('C6 an inherited Rotate 90 survives the seal and a field lands where a viewer shows it', async ({ request }) => {
  test.setTimeout(120_000);

  const sealed = await sealWithField(request, 'c6', await buildInheritedRotatedA4Pdf(), FIELD_LOW);
  const [first] = pdfinfoPages(sealed);

  expect(first.rotation, 'sealed page 1 rotation').toBe(90);

  const render = renderFirstPage(sealed);

  // Shown rotated, the page is landscape A4.
  expect({ width: render.width, height: render.height }, 'rendered page 1 is landscape').toEqual({
    width: 842,
    height: expect.any(Number),
  });
  expect(inkInBox(render, FIELD_LOW), 'C6: ink inside the placed box').toBeGreaterThan(MIN_INK);
  expect(inkBelowBox(render, FIELD_LOW), 'C6: no ink in the box 50pt lower').toBe(0);
});

test('C7 an inherited A4 document stored before the fix seals with ink in the placed box', async ({ request }) => {
  test.setTimeout(120_000);

  // Near the top, where reading the page as US Letter puts the overlay furthest off; lower down the
  // offset stays inside the box and cannot tell a fixed seal from a broken one.

  const fixture = await buildInheritedA4Pdf();
  const seeded = await seedOneSigner(request, 'c7', fs.readFileSync(path.join(ASSETS_DIR, 'a4-size.pdf')), FIELD_TOP);
  const item = await prisma.envelopeItem.findUniqueOrThrow({ where: { id: seeded.itemId } });
  const base64 = fixture.toString('base64');

  // As uploaded before any normalisation existed: the bytes straight into DocumentData.
  await prisma.documentData.update({
    where: { id: item.documentDataId },
    data: { type: DocumentDataType.BYTES_64, data: base64, initialData: base64 },
  });

  expect(Buffer.from(await readItemBytes(seeded.itemId)).equals(fixture), 'premise: stored bytes are the fixture').toBe(
    true,
  );

  await signAndComplete(request, seeded);
  await waitForStatus(seeded.envelopeId, DocumentStatus.COMPLETED);

  const sealed = await downloadEnvelopeItem(request, seeded.token, seeded.itemId, 'signed');

  await attachPdf('c7-sealed.pdf', sealed);

  expectInkInPlacedBoxOnly(sealed, FIELD_TOP, 'C7');
});

test('C8 the A4, letter and tabloid landscape assets still seal with ink in the placed boxes', async ({ request }) => {
  test.setTimeout(300_000);

  for (const asset of ['a4-size.pdf', 'letter-size.pdf', 'tabloid-landscape.pdf']) {
    const sealed = await sealWithField(
      request,
      `c8-${asset.replace('.pdf', '')}`,
      fs.readFileSync(path.join(ASSETS_DIR, asset)),
      FIELD_LOW,
    );

    expectInkInPlacedBoxOnly(sealed, FIELD_LOW, `C8 ${asset}`);
  }
});
