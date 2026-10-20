/**
 * Certificate and partial PDF downloads draw the prepared image (G4 spec, "Round after Codex r2", C104).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md) before any fix,
 * without reading the certificate or partial PDF renderers. The three consumers named by the spec's enumeration:
 *
 * - the certificate from the download API, GET /api/v2-beta/envelope/:envelopeId/certificate/download
 *   (apps/remix/server/api/download/download.ts:297);
 * - the tRPC certificate download, document.downloadCertificate
 *   (packages/trpc/server/document-router/download-document-certificate.ts:69);
 * - the pending-document partial PDF, GET /api/v2-beta/envelope/item/:itemId/download?version=pending
 *   (apps/remix/server/api/files/files.helpers.ts:208).
 *
 * | Criterion | Test                                                                                       |
 * | --------- | ------------------------------------------------------------------------------------------ |
 * | C104      | C104 <consumer> control: a stored valid PNG renders as ink                                  |
 * | C104      | C104 <consumer>: the inked fixture stored as TIFF renders as ink                            |
 * | C104      | C104 <consumer>: the inked fixture stored as AVIF renders as ink                            |
 * | C104      | C104 <consumer>: an undecodable stored value answers a 4xx AppError without echoing it      |
 * | C104b     | C104b <consumer>: "!!!!" and the prefix alone, which decode to nothing, answer a 4xx AppError |
 *
 * The TIFF and AVIF values are built from the committed inked fixture with sharp (the TIFF flattened onto white,
 * since TIFF keeps no alpha) and stored directly under the PNG prefix, as D2 leaves legacy rows. Each test proves
 * its own premise, as C100 does: sharp reads the value as a 400 x 175 image with ink on a light field in roughly
 * the fixture's proportion, and Skia's Image refuses it. The envelopes are seeded through Prisma: a COMPLETED envelope with
 * s1 SIGNED for the certificates, and a V2 PENDING envelope with s1 SIGNED and s2 still to sign for the partial
 * PDF (the pending download serves V2 envelopes only). Ink in a certificate is a raster with D1 ink above 1% and
 * below 50% (its soft mask as alpha) and the fixture's 16:7 aspect within 5%, as in C102. Unlike C102 a JPEG counts: the
 * Skia certificate has no JPEG page graphics, and Skia writes an opaque image, such as the TIFF, as a JPEG. Ink in
 * the partial PDF is the share of s1's field rectangle at least 40 grey levels darker than in the example PDF,
 * above 1%, as in C61.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@documenso/prisma';
import { Image } from '@documenso/skia-canvas';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SendStatus, SigningStatus } from '@prisma/client';
import sharp from 'sharp';

import { keepRecord, type Reply, send } from '../fixtures/reject-seal';
import {
  API_V2,
  decodePng,
  errorOf,
  type G4Seeded,
  imageBytes,
  imageManifest,
  isInkPixel,
  P,
  seedG4Envelope,
  seedSessionCookie,
  trpcAsUser,
  validInkedDataUrl,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const EXAMPLE_PDF = fs.readFileSync(path.join(__dirname, '../../../../assets/example.pdf'));

/** F02's payload: the text "not-an-image". No decoder reads it. */
const JUNK_PAYLOAD = 'bm90LWFuLWltYWdl';
const JUNK = `${P}${JUNK_PAYLOAD}`;

/** C104b: stored values whose payload decodes to an empty buffer (spec, "Round after Codex r3"). */
const EMPTY_PAYLOADS = [
  { key: 'bangs', label: 'the payload "!!!!"', value: `${P}!!!!` },
  { key: 'prefix-only', label: 'the prefix alone', value: P },
];

/** Aspect ratio of the 400 x 175 fixture. */
const SIGNATURE_ASPECT = 400 / 175;

type Encoding = 'tiff' | 'avif';

/**
 * The committed inked fixture re-encoded by sharp, stored under the PNG prefix. sharp writes the TIFF with three
 * channels and no alpha, and the fixture keeps its transparent pixels black, so the TIFF is built from the fixture
 * flattened onto white; otherwise it is an opaque black rectangle with no ink to find. AVIF keeps the alpha.
 */
const reEncoded = async (encoding: Encoding) => {
  const source = sharp(imageBytes('valid-inked'));
  const bytes =
    encoding === 'tiff'
      ? await source.flatten({ background: '#ffffff' }).tiff().toBuffer()
      : await source.avif().toBuffer();

  return `${P}${bytes.toString('base64')}`;
};

/** D1 coverage of the decoded value composited over white: ink pixels over all pixels. */
const inkOnWhite = async (bytes: Buffer) => {
  const { data, info } = await sharp(bytes)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let ink = 0;

  for (let i = 0; i < info.width * info.height; i++) {
    ink += isInkPixel(data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255) ? 1 : 0;
  }

  return ink / (info.width * info.height);
};

/**
 * The premise, proved by the test itself: sharp reads the value as the fixture, with dark ink on a light field in
 * roughly the fixture's proportion (within half to double its manifest coverage), and Skia's Image refuses it.
 */
const expectSharpReadsAndSkiaRefuses = async (value: string, encoding: Encoding) => {
  const metadata = await sharp(Buffer.from(value.slice(P.length), 'base64')).metadata();

  expect(
    `${metadata.format} ${metadata.width}x${metadata.height}`,
    `premise: sharp reads the ${encoding} value as the 400 x 175 fixture`,
  ).toBe(`${encoding === 'tiff' ? 'tiff' : 'heif'} 400x175`);

  const fixtureCoverage = imageManifest()['valid-inked'].coverage ?? 0;
  const coverage = await inkOnWhite(Buffer.from(value.slice(P.length), 'base64'));

  expect(
    coverage,
    `premise: the ${encoding} value has ink on a light field (fixture ${fixtureCoverage}), not a solid block`,
  ).toBeGreaterThanOrEqual(fixtureCoverage / 2);
  expect(coverage, `premise: the ${encoding} value is mostly light field`).toBeLessThanOrEqual(fixtureCoverage * 2);

  const skia = (() => {
    try {
      const image = new Image(value);

      return `loaded ${image.width}x${image.height}`;
    } catch {
      return 'refused';
    }
  })();

  expect(skia, `premise: Skia's Image refuses the ${encoding} value as stored`).toBe('refused');
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const storeSignature = async (seeded: G4Seeded, stored: string) => {
  await prisma.signature.create({
    data: { fieldId: seeded.r.s1.fields.sig.id, recipientId: seeded.r.s1.id, signatureImageAsBase64: stored },
  });
};

const seedCompleted = async (stored: string) => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    status: DocumentStatus.COMPLETED,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        sendStatus: SendStatus.SENT,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
    ],
  });

  await prisma.envelope.update({ where: { id: seeded.envelopeId }, data: { completedAt: new Date() } });
  await storeSignature(seeded, stored);

  return seeded;
};

const seedPending = async (stored: string) => {
  const seeded = await seedG4Envelope({
    internalVersion: 2,
    recipients: [
      {
        key: 's1',
        signingOrder: 1,
        signingStatus: SigningStatus.SIGNED,
        fields: [{ key: 'sig', type: FieldType.SIGNATURE, inserted: true }],
      },
      { key: 's2', signingOrder: 2, fields: [{ key: 'sig', type: FieldType.SIGNATURE }] },
    ],
  });

  await storeSignature(seeded, stored);

  return seeded;
};

// ---------------------------------------------------------------------------
// The three consumers
// ---------------------------------------------------------------------------

type Download = { reply: Reply; pdf: Buffer | null };

const pdfOf = (bytes: Buffer) => (bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? bytes : null);

const getRaw = async (request: APIRequestContext, url: string, apiToken: string, what: string) => {
  let bytes = Buffer.alloc(0);
  const reply = await send(
    async () => {
      const res = await request.get(url, { headers: { Authorization: `Bearer ${apiToken}` } });

      bytes = await res.body();

      return res;
    },
    what,
    true,
  );

  return { reply, pdf: reply.status === 200 ? pdfOf(bytes) : null };
};

const apiCertificate = async (request: APIRequestContext, seeded: G4Seeded): Promise<Download> =>
  await getRaw(
    request,
    `${API_V2}/envelope/${seeded.envelopeId}/certificate/download`,
    seeded.owner.apiToken,
    'API certificate download',
  );

const trpcCertificate = async (request: APIRequestContext, seeded: G4Seeded): Promise<Download> => {
  const cookie = await seedSessionCookie(seeded.owner.user.id);
  const reply = await trpcAsUser(
    request,
    'document.downloadCertificate',
    { envelopeId: seeded.envelopeId },
    { cookie, teamId: seeded.owner.team.id },
  );

  if (reply.status !== 200) {
    return { reply, pdf: null };
  }

  const body = JSON.parse(reply.body) as { result?: { data?: { json?: { data?: string } } } };
  const data = body.result?.data?.json?.data;

  return { reply, pdf: typeof data === 'string' ? pdfOf(Buffer.from(data, 'base64')) : null };
};

const partialPdf = async (request: APIRequestContext, seeded: G4Seeded): Promise<Download> =>
  await getRaw(
    request,
    `${API_V2}/envelope/item/${seeded.itemId}/download?version=pending`,
    seeded.owner.apiToken,
    'pending partial PDF download',
  );

// ---------------------------------------------------------------------------
// Ink measurements
// ---------------------------------------------------------------------------

/** The PDF's raster images, each with its size, encoding and D1 ink coverage with its soft mask as alpha. */
const rastersOf = (pdf: Buffer) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-c104-'));
  const file = path.join(dir, 'doc.pdf');

  fs.writeFileSync(file, pdf);

  const list = spawnSync('pdfimages', ['-list', file], { encoding: 'utf8' }).stdout;
  // pdfimages -list columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio.
  const listed = list
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length > 4)
    .map((cols) => ({
      page: Number(cols[0]),
      num: Number(cols[1]),
      type: cols[2],
      width: Number(cols[3]),
      height: Number(cols[4]),
      enc: cols[8],
    }));

  spawnSync('pdfimages', ['-png', '-p', file, path.join(dir, 'img')]);

  const files = fs.readdirSync(dir).filter((name) => name.startsWith('img') && name.endsWith('.png'));
  const read = (num: number) => {
    const name = files.find((candidate) => candidate.endsWith(`-${String(num).padStart(3, '0')}.png`));

    try {
      return name ? decodePng(fs.readFileSync(path.join(dir, name))) : null;
    } catch {
      return null;
    }
  };
  const rasters = listed
    .filter((entry) => entry.type === 'image')
    .map((entry) => {
      const mask = listed.find(
        (other) => other.type === 'smask' && other.page === entry.page && other.num === entry.num + 1,
      );
      const image = read(entry.num);
      const alpha = mask ? read(mask.num) : null;
      let coverage: number | null = null;

      if (image) {
        let ink = 0;

        for (let i = 0; i < image.width * image.height; i++) {
          const a = alpha && alpha.width === image.width && alpha.height === image.height ? alpha.data[i * 4] : 255;

          ink += isInkPixel(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2], a) ? 1 : 0;
        }

        coverage = ink / (image.width * image.height);
      }

      return { ...entry, hasAlpha: Boolean(mask), coverage };
    });

  fs.rmSync(dir, { recursive: true });

  return { rasters, list: list.split('\n').filter(Boolean) };
};

/**
 * Rasters that can be s1's signature: inked above 1% and below 50% (a solid block is not a signature), with the
 * fixture's aspect ratio within 5%. The certificate's logo (720 x 146) fails the aspect test; a JPEG is kept, since Skia encodes an opaque signature image that way.
 */
const signatureRasters = (pdf: Buffer | null) =>
  (pdf ? rastersOf(pdf).rasters : []).filter(
    (raster) =>
      (raster.coverage ?? 0) > 0.01 &&
      (raster.coverage ?? 1) < 0.5 &&
      Math.abs(raster.width / raster.height / SIGNATURE_ASPECT - 1) <= 0.05,
  );

/** Page 1 cropped to `box` (percentages of the page), as 72 dpi grey bytes. */
const renderBox = (pdf: Buffer, box: { x: number; y: number; w: number; h: number }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-c104-'));
  const file = path.join(dir, 'doc.pdf');

  fs.writeFileSync(file, pdf);

  const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout;
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);

  if (!size) {
    fs.rmSync(dir, { recursive: true });

    throw new Error(`pdfinfo gave no page size: ${info}`);
  }

  const [pw, ph] = [Number(size[1]), Number(size[2])];
  const crop = [
    ['-x', Math.round((box.x / 100) * pw)],
    ['-y', Math.round((box.y / 100) * ph)],
    ['-W', Math.round((box.w / 100) * pw)],
    ['-H', Math.round((box.h / 100) * ph)],
  ].flatMap(([flag, value]) => [String(flag), String(value)]);
  const result = spawnSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '72', '-gray', ...crop, file], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });

  fs.rmSync(dir, { recursive: true });

  if (result.status !== 0) {
    throw new Error(`pdftoppm failed: ${result.stderr.toString()}`);
  }

  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(result.stdout.subarray(0, 32).toString('latin1'));

  if (!header) {
    throw new Error('pdftoppm did not write a binary PGM');
  }

  return result.stdout.subarray(header[0].length);
};

/** Share of s1's field rectangle at least 40 grey levels darker in `pdf` than in the example PDF. */
const drawnShare = async (seeded: G4Seeded, pdf: Buffer | null) => {
  if (!pdf) {
    return 0;
  }

  const field = await prisma.field.findUniqueOrThrow({ where: { id: seeded.r.s1.fields.sig.id } });
  const box = {
    x: Number(field.positionX),
    y: Number(field.positionY),
    w: Number(field.width),
    h: Number(field.height),
  };
  const original = renderBox(EXAMPLE_PDF, box);
  const drawn = renderBox(pdf, box);
  let darker = 0;

  for (let i = 0; i < Math.min(original.length, drawn.length); i++) {
    if (original[i] - drawn[i] >= 40) {
      darker++;
    }
  }

  return darker / drawn.length;
};

// ---------------------------------------------------------------------------
// Consumers under test
// ---------------------------------------------------------------------------

type Consumer = {
  key: string;
  label: string;
  seed: (stored: string) => Promise<G4Seeded>;
  fetch: (request: APIRequestContext, seeded: G4Seeded) => Promise<Download>;
  /** Ink measured in the downloaded PDF; positive when s1's signature is drawn as ink. */
  ink: (seeded: G4Seeded, pdf: Buffer | null) => Promise<number>;
  inkWhat: string;
  /** The AppError code in a 4xx reply body, or undefined when there is none. */
  appErrorCode: (reply: Reply) => string | undefined;
};

const restErrorCode = (reply: Reply) => {
  try {
    const body = JSON.parse(reply.body) as Record<string, unknown>;

    return typeof body.code === 'string' && body.code.length > 0 ? body.code : undefined;
  } catch {
    return undefined;
  }
};

const certificateInk = async (_seeded: G4Seeded, pdf: Buffer | null) => signatureRasters(pdf).length;

const CONSUMERS: Consumer[] = [
  {
    key: 'api-certificate',
    label: 'API certificate download',
    seed: seedCompleted,
    fetch: apiCertificate,
    ink: certificateInk,
    inkWhat: 'inked 16:7 rasters in the certificate',
    appErrorCode: restErrorCode,
  },
  {
    key: 'trpc-certificate',
    label: 'tRPC certificate download',
    seed: seedCompleted,
    fetch: trpcCertificate,
    ink: certificateInk,
    inkWhat: 'inked 16:7 rasters in the certificate',
    appErrorCode: (reply) => errorOf(reply).code,
  },
  {
    key: 'partial-pdf',
    label: 'pending partial PDF',
    seed: seedPending,
    fetch: partialPdf,
    ink: async (seeded, pdf) => ((await drawnShare(seeded, pdf)) > 0.01 ? 1 : 0),
    inkWhat: "s1's field rectangle at least 1% darker than the example PDF",
    appErrorCode: restErrorCode,
  },
];

const record = async (name: string, seeded: G4Seeded, download: Download, ink: number) => {
  await keepRecord(name, {
    envelopeId: seeded.envelopeId,
    itemId: seeded.itemId,
    status: download.reply.status,
    body: download.pdf ? `<PDF ${download.pdf.length} bytes>` : download.reply.body.slice(0, 2000),
    rasters: download.pdf ? rastersOf(download.pdf).list : [],
    ink,
  });

  if (download.pdf) {
    fs.writeFileSync(test.info().outputPath(`${name.replace(/\.json$/, '')}.pdf`), download.pdf);
  }
};

for (const consumer of CONSUMERS) {
  test(`C104 ${consumer.label} control: a stored valid PNG renders as ink`, async ({ request }) => {
    test.setTimeout(120_000);

    const seeded = await consumer.seed(validInkedDataUrl());
    const download = await consumer.fetch(request, seeded);
    const ink = await consumer.ink(seeded, download.pdf);

    await record(`C104-${consumer.key}-control.json`, seeded, download, ink);

    expect(download.reply.status, `premise: the ${consumer.label} answers 200`).toBe(200);
    expect(download.pdf, `premise: the ${consumer.label} is a PDF`).not.toBeNull();
    expect(ink, `premise: the measurement sees the valid PNG (${consumer.inkWhat})`).toBeGreaterThanOrEqual(1);
  });

  for (const encoding of ['tiff', 'avif'] as const) {
    test(`C104 ${consumer.label}: the inked fixture stored as ${encoding.toUpperCase()} renders as ink`, async ({
      request,
    }) => {
      test.setTimeout(120_000);

      const stored = await reEncoded(encoding);

      await expectSharpReadsAndSkiaRefuses(stored, encoding);

      const seeded = await consumer.seed(stored);
      const download = await consumer.fetch(request, seeded);
      const ink = await consumer.ink(seeded, download.pdf);
      const row = await prisma.signature.findFirstOrThrow({ where: { fieldId: seeded.r.s1.fields.sig.id } });

      await record(`C104-${consumer.key}-${encoding}.json`, seeded, download, ink);

      expect.soft(download.reply.status, `${consumer.label}: answers 200`).toBe(200);
      expect.soft(download.pdf, `${consumer.label}: the reply is a PDF`).not.toBeNull();
      expect
        .soft(ink, `${consumer.label}: the ${encoding} signature is drawn as ink (${consumer.inkWhat})`)
        .toBeGreaterThanOrEqual(1);
      expect.soft(row.signatureImageAsBase64, `${consumer.label}: the stored row is unchanged (D2)`).toBe(stored);
    });
  }

  test(`C104 ${consumer.label}: an undecodable stored value answers a 4xx AppError without echoing it`, async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const seeded = await consumer.seed(JUNK);
    const download = await consumer.fetch(request, seeded);

    await record(`C104-${consumer.key}-undecodable.json`, seeded, download, 0);

    expect
      .soft(download.reply.status, `${consumer.label}: answers 4xx, not ${download.reply.status}`)
      .toBeGreaterThanOrEqual(400);
    expect
      .soft(download.reply.status, `${consumer.label}: answers 4xx, not ${download.reply.status}`)
      .toBeLessThan(500);
    expect.soft(download.pdf, `${consumer.label}: no PDF is served`).toBeNull();
    expect
      .soft(consumer.appErrorCode(download.reply), `${consumer.label}: the body carries an AppError code`)
      .toBeTruthy();
    expect
      .soft(download.reply.body, `${consumer.label}: the body does not echo the stored value`)
      .not.toContain(JUNK_PAYLOAD);
  });

  for (const empty of EMPTY_PAYLOADS) {
    test(`C104b ${consumer.label}: ${empty.label}, which decodes to nothing, answers a 4xx AppError without echoing it`, async ({
      request,
    }) => {
      test.setTimeout(120_000);

      expect(
        Buffer.from(empty.value.slice(P.length), 'base64').length,
        'premise: the payload decodes to an empty buffer',
      ).toBe(0);

      const seeded = await consumer.seed(empty.value);
      const download = await consumer.fetch(request, seeded);

      await record(`C104b-${consumer.key}-${empty.key}.json`, seeded, download, 0);

      expect
        .soft(download.reply.status, `${consumer.label}: answers 4xx, not ${download.reply.status}`)
        .toBeGreaterThanOrEqual(400);
      expect
        .soft(download.reply.status, `${consumer.label}: answers 4xx, not ${download.reply.status}`)
        .toBeLessThan(500);
      expect.soft(download.pdf, `${consumer.label}: no PDF is served`).toBeNull();
      expect
        .soft(consumer.appErrorCode(download.reply), `${consumer.label}: the body carries an AppError code`)
        .toBeTruthy();
      expect
        .soft(download.reply.body, `${consumer.label}: the body does not echo the stored value`)
        .not.toContain(empty.value);
    });
  }
}
