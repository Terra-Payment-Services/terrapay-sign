/**
 * Size limits on a signature image, and what every real decoder makes of the
 * stored value (G4).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the sign routes. Signs go to
 * field.signFieldWithToken on V1 envelopes and envelope.field.sign on V2
 * envelopes, unauthenticated, with only the recipient token ("both routes",
 * spec 4.0). The decoders are the ones section 1.3 names: @cantoo/pdf-lib
 * embedPng (V1 seal), @documenso/skia-canvas Image (V2 seal, certificate) and a
 * Chromium <img> (signing page, HTML certificate).
 *
 * | Criterion | Test                                                                                   |
 * | --------- | -------------------------------------------------------------------------------------- |
 * | C9        | C9 the largest image the real pad produces (profile, 1920 x 1080, DPR 2) is accepted   |
 * | C9        | C9 a 5000 x 5000 image and a 4 MiB + 1 byte payload are refused fast, server stays up  |
 * | C11       | C11 every accepted fixture, as stored, decodes in pdf-lib, skia and Chromium (V1, V2)  |
 *
 * The oversized C9 cases run last in the file: if one takes the server down,
 * the PID check records it and nothing after it is affected.
 */
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

import { prisma } from '@documenso/prisma';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { keepRecord } from '../fixtures/reject-seal';
import {
  expect2xx,
  expectCallRefused,
  expectSignatureAccepted,
  fieldState,
  type G4Seeded,
  imageBytes,
  imageDataUrl,
  imageManifest,
  P,
  seedOneSigner,
  seedSession,
  serverPid,
  signSignature,
  WEBAPP_BASE_URL,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

const require = createRequire(__filename);

// ---------------------------------------------------------------------------
// The three decoders of section 1.3
// ---------------------------------------------------------------------------

type DecodeResult = { ok: boolean; detail: string };

const decodePdfLib = async (dataUrl: string): Promise<DecodeResult> => {
  const { PDFDocument } = require('@cantoo/pdf-lib') as typeof import('@cantoo/pdf-lib');

  try {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(dataUrl);

    return { ok: image.width > 0 && image.height > 0, detail: `${image.width}x${image.height}` };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 120) };
  }
};

const decodeSkia = (dataUrl: string): DecodeResult => {
  const { Image } = require('@documenso/skia-canvas') as {
    Image: new (src: string) => { width: number; height: number };
  };

  try {
    const image = new Image(dataUrl);

    return { ok: image.width > 0 && image.height > 0, detail: `${image.width}x${image.height}` };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 120) };
  }
};

const decodeChromium = async (page: Page, dataUrl: string): Promise<DecodeResult> =>
  await page.evaluate(
    async (src) =>
      await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const image = new Image();

        image.onload = () =>
          resolve({ ok: image.naturalWidth > 0, detail: `${image.naturalWidth}x${image.naturalHeight}` });
        image.onerror = () => resolve({ ok: false, detail: 'error' });
        image.src = src;
      }),
    dataUrl,
  );

// ---------------------------------------------------------------------------
// C11
// ---------------------------------------------------------------------------

/** The C11 encoding variants signed on both routes; the shape fixtures on V2 as well. */
const C11_VARIANTS = ['palette-trns', 'sixteen-bit', 'interlaced', 'grey-alpha'];
const C11_OTHERS = [
  'valid-inked',
  'ink-1p1-1000x438',
  'trailing-bytes',
  'text-chunk',
  // The accepted D1 fixtures (section 7).
  'paper-noise-strokes-2pc',
  'grey-paper-strokes-2pc',
  'light-strokes-y220',
];
const C11_SHAPES = ['ring-600x600', 'wide-1200x300', 'photo-faint-edges'];

test('C11 every accepted fixture, as stored, decodes in pdf-lib, skia and Chromium', async ({ page, request }) => {
  test.setTimeout(240_000);

  const manifest = imageManifest();
  const cases: Array<{ name: string; version: 1 | 2 }> = [
    ...[...C11_VARIANTS, ...C11_OTHERS].flatMap((name) => [
      { name, version: 1 as const },
      { name, version: 2 as const },
    ]),
    ...C11_SHAPES.map((name) => ({ name, version: 2 as const })),
  ];

  await page.goto('about:blank');

  const records: Array<Record<string, unknown>> = [];

  for (const { name, version } of cases) {
    expect(manifest[name].expected, `premise: ${name} is an accepted fixture`).toBe('accept');

    const seeded = await seedOneSigner(version);
    const field = seeded.r.s1.fields.sig;
    const reply = await signSignature(request, seeded, seeded.r.s1.token, field.id, imageDataUrl(name));

    // The criterion is about accepted fixtures; a refusal here is a C2/C10 failure, recorded and checked there.
    expect.soft(reply.status, `V${version} ${name}: the accepted fixture is signed (200)`).toBe(200);

    const stored = (await fieldState(field.id)).signature?.image ?? null;

    if (!stored) {
      records.push({ name, version, status: reply.status, stored: null });
      expect.soft(stored, `V${version} ${name}: an image is stored`).not.toBeNull();
      continue;
    }

    const results = {
      pdfLib: await decodePdfLib(stored),
      skia: decodeSkia(stored),
      chromium: await decodeChromium(page, stored),
    };

    records.push({
      name,
      version,
      status: reply.status,
      storedIsUpload: stored === imageDataUrl(name),
      storedBytes: Buffer.from(stored.slice(P.length), 'base64').length,
      ...results,
    });

    for (const [decoder, result] of Object.entries(results)) {
      expect
        .soft(result.ok, `V${version} ${name}: the stored value decodes in ${decoder} (${result.detail})`)
        .toBe(true);
    }
  }

  await keepRecord('C11-decoders.json', records);
});

// ---------------------------------------------------------------------------
// C9, the pad half: the largest real pad image is accepted
// ---------------------------------------------------------------------------

const drawEdgeToEdge = async (page: Page) => {
  const canvas = page.getByTestId('signature-pad-draw');

  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('The draw pad has no bounding box');
  }

  // A dense zig-zag across the whole pad, edge to edge, as large an image as a person can draw.
  const rows = 14;

  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();

  for (let row = 0; row <= rows; row++) {
    const y = box.y + 2 + ((box.height - 4) * row) / rows;

    for (let step = 0; step <= 30; step++) {
      const progress = step / 30;
      const x =
        row % 2 === 0 ? box.x + 2 + (box.width - 4) * progress : box.x + box.width - 2 - (box.width - 4) * progress;

      await page.mouse.move(x, y + (step % 2 === 0 ? 0 : 6));
    }
  }

  await page.mouse.up();

  return box;
};

const padImageFromProfile = async (browser: Browser) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const seeded = await seedOneSigner(2);

  await seedSession(context, seeded.owner.user.id);
  await page.goto('/settings/profile');

  await page.getByTestId('signature-pad-dialog-button').click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Draw' }).click();

  const box = await drawEdgeToEdge(page);
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Next' });

  await expect(confirm, 'premise: the drawing passes the pad check').toBeEnabled();
  await confirm.click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Update profile' }).click();
  await expect(page.getByText('Profile updated').first()).toBeVisible({ timeout: 15_000 });

  // What the pad produced, as the profile save stored it.
  const value = (await prisma.user.findUniqueOrThrow({ where: { id: seeded.owner.user.id } })).signature ?? '';

  await context.close();

  return { value, box };
};

test('C9 the largest image the real pad produces (profile, 1920 x 1080, DPR 2) is accepted on both routes', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);

  const { value, box } = await padImageFromProfile(browser);

  expect(value.startsWith(P), `premise: the profile save carries a PNG data URL (${value.slice(0, 30)})`).toBe(true);

  const png = PNG.sync.read(Buffer.from(value.slice(P.length), 'base64'));

  await keepRecord('C9-pad-image.json', {
    padCssBox: box,
    width: png.width,
    height: png.height,
    decodedBytes: Buffer.from(value.slice(P.length), 'base64').length,
    dataUrlLength: value.length,
  });

  expect(png.width, 'premise: the pad exports at device scale (twice the CSS width)').toBeGreaterThan(box.width * 1.5);

  for (const version of [1, 2] as const) {
    const seeded = await seedOneSigner(version);
    const reply = await signSignature(request, seeded, seeded.r.s1.token, seeded.r.s1.fields.sig.id, value);

    await expectSignatureAccepted(
      reply,
      seeded,
      seeded.r.s1.fields.sig,
      { image: { width: png.width, height: png.height } },
      `V${version}: the largest pad image is accepted`,
    );
  }
});

// ---------------------------------------------------------------------------
// C9, the oversized half (last in the file)
// ---------------------------------------------------------------------------

const MIB4_PLUS_1 = 4 * 1024 * 1024 + 1;

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);

  return Buffer.concat([length, body, crc]);
};

/** valid-inked with a private ancillary chunk after IHDR, sized so the PNG is exactly 4 MiB + 1 byte. */
const pngOf4MibPlus1 = () => {
  const base = imageBytes('valid-inked');
  const padding = Buffer.alloc(MIB4_PLUS_1 - base.length - 12, 0x5a);
  const bytes = Buffer.concat([base.subarray(0, 33), chunk('tpAd', padding), base.subarray(33)]);

  expect(bytes.length, 'premise: the payload decodes to exactly 4 MiB + 1 byte').toBe(MIB4_PLUS_1);
  expect(PNG.sync.read(bytes).width, 'premise: the padded PNG is still a valid PNG').toBe(400);

  return `${P}${bytes.toString('base64')}`;
};

test('C9 a 5000 x 5000 image and a 4 MiB + 1 byte payload are refused within 2 s on both routes, server PID unchanged', async ({
  request,
}) => {
  test.setTimeout(180_000);

  const pidBefore = await serverPid();

  expect(pidBefore, 'premise: the app server is listening').toBeTruthy();

  const huge = imageManifest()['huge-5000x5000'];
  const hugeBytes = imageBytes('huge-5000x5000');

  expect([huge.width, huge.height], 'premise: the fixture declares 5000 x 5000').toEqual([5000, 5000]);
  expect(PNG.sync.read(hugeBytes).width, 'premise: the fixture really decodes at 5000 wide').toBe(5000);
  expect(hugeBytes.length, 'premise: compressed under the 4 MiB cap').toBeLessThan(4 * 1024 * 1024);

  const cases = [
    { name: '5000x5000', value: imageDataUrl('huge-5000x5000') },
    { name: '4MiB+1', value: pngOf4MibPlus1() },
  ];
  const records: Array<Record<string, unknown>> = [];

  for (const { name, value } of cases) {
    for (const version of [1, 2] as const) {
      const seeded: G4Seeded = await seedOneSigner(version);
      const field = seeded.r.s1.fields.sig;
      let elapsedMs = 0;

      try {
        await expectCallRefused(
          seeded,
          field,
          async () => {
            const started = Date.now();
            // No retry: a 429 would add its back-off to the timing; expectRefusedWith reports a 429 as a test defect.
            const reply = await signSignature(request, seeded, seeded.r.s1.token, field.id, value, { retry: false });

            elapsedMs = Date.now() - started;
            records.push({ name, version, status: reply.status, elapsedMs, body: reply.body.slice(0, 200) });

            return reply;
          },
          `V${version} ${name}`,
        );
      } catch (error) {
        // Keep going so every case and the PID check are recorded; the soft failure keeps the test red.
        expect.soft(String(error), `V${version} ${name}: refused with the 4.0 bundle`).toBe('');
      }

      expect.soft(elapsedMs, `V${version} ${name}: answered within 2 s`).toBeLessThan(2_000);

      // 4.0: the same field can afterwards be signed with a valid value.
      const control = await signSignature(request, seeded, seeded.r.s1.token, field.id, 'Control Signer');

      try {
        await expectSignatureAccepted(
          control,
          seeded,
          field,
          { typed: 'Control Signer' },
          `V${version} ${name}: control sign afterwards`,
        );
      } catch (error) {
        expect.soft(String(error), `V${version} ${name}: the field signs with a valid value afterwards`).toBe('');
      }
    }
  }

  const health = await request.get(`${WEBAPP_BASE_URL}/api/health`);

  expect.soft(health.status(), 'the server still answers its health check').toBe(200);

  const pidAfter = await serverPid();
  const storedRows = await prisma.signature.count({ where: { signatureImageAsBase64: { startsWith: P } } });

  await keepRecord('C9-oversized.json', { records, pidBefore, pidAfter, storedImageRowsInDatabase: storedRows });

  expect(pidAfter, 'the server is still the same process (no out-of-memory restart)').toBe(pidBefore);
});
