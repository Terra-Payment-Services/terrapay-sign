/**
 * One ink rule on both sides (G4 spec section 4.6 and decision D1).
 *
 * Written from the G4 specification (terrapay-sign-evidence/campaign-2026-10-17/G4/spec.md)
 * before any fix, without reading the pad's validity check or any server
 * validator. The fixtures are the generated PNGs in e2e/fixtures/signature-ink/;
 * manifest.json records each one's size, D1 coverage (computed with pngjs from
 * the spec's formula) and the verdict the spec expects. The expected verdicts
 * are the spec's, not the app's.
 *
 * Client verdict: the real Upload tab of the profile page's signature dialog in
 * the test browser. The file goes through the hidden file input; "accept" means
 * Next is enabled and "Signature is too small" is not shown, "refuse" means
 * Next stays disabled. The upload pad contain-fits the image into the 16:7
 * canvas, so the client judges the image as composited into that canvas; the
 * spec requires the same verdict regardless.
 *
 * Server verdict: the image as a data URL on a fresh V2 SIGNATURE field through
 * envelope.field.sign, unauthenticated with the recipient token. "accept" is a
 * 2xx; "refuse" is 400 with data.code INVALID_REQUEST (spec 4.0) and the field
 * left uninserted. Anything else is recorded as "other" and fails.
 *
 * | Criterion | Test                                                                            |
 * | --------- | ------------------------------------------------------------------------------- |
 * | C50       | every "C50 ... <fixture>" test: client == server == spec, per fixture             |
 * | C52       | C50 C52 white-opaque, C50 C52 white-through-jpeg75                               |
 * | C53       | C50 C53 paper-noise                                                               |
 * | C54       | C50 C54 paper-noise-strokes-2pc (accept), C50 C54 paper-noise-strokes-0p5pc (refuse) |
 * | C55       | C50 C55 grey-paper-strokes-2pc (accept, recorded as passing on the paper)          |
 * | C56       | C50 C56 light-strokes-y240 (refuse), C50 C56 light-strokes-y220 (accept)           |
 * | C57       | C57 a drawing in each picker colour ...                                           |
 * | C51       | packages/lib/universal/signature/assess-signature-ink.test.ts (vitest)            |
 *
 * C1, C2, C10, C11 and C35-C38 fixtures are also in the C50 set; their own
 * criteria (storage, normalisation, shape) are tested in their own specs.
 *
 * Runs in the `ui` project.
 */
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';
import { PNG } from 'pngjs';

import { keepRecord, pause } from '../fixtures/reject-seal';
import {
  coverageOf,
  createG4Owner,
  errorOf,
  fieldState,
  IMAGE_DIR,
  imageDataUrl,
  imageManifest,
  P,
  seedOneSigner,
  seedSession,
  signV2,
} from '../fixtures/signature-ink';

test.describe.configure({ mode: 'default' });

type Verdict = 'accept' | 'refuse' | 'other';

/** The criteria whose fixtures C50 names. */
const C50_SOURCES = new Set(['C1', 'C2', 'C10', 'C11', 'C35', 'C36', 'C37', 'C38', 'C52', 'C53', 'C54', 'C55', 'C56']);

const manifest = imageManifest();

const C50_FIXTURES = Object.entries(manifest).filter(
  ([, entry]) => entry.file.endsWith('.png') && entry.criteria.some((criterion) => C50_SOURCES.has(criterion)),
);

/** The D1 criteria a fixture belongs to, for the test name. */
const d1Criteria = (criteria: string[]) => criteria.filter((criterion) => /^C5[2-6]$/.test(criterion));

// ---------------------------------------------------------------------------
// Server verdict
// ---------------------------------------------------------------------------

const serverVerdict = async (request: Parameters<typeof signV2>[0], dataUrl: string) => {
  const seeded = await seedOneSigner(2);
  const field = seeded.r.s1.fields.sig;
  const before = await fieldState(field.id);

  expect(before.inserted, 'premise: the field starts uninserted').toBe(false);

  const reply = await signV2(request, seeded.r.s1.token, field.id, { type: FieldType.SIGNATURE, value: dataUrl });
  const after = await fieldState(field.id);
  const error = errorOf(reply);

  let verdict: Verdict = 'other';

  if (reply.status >= 200 && reply.status < 300 && after.inserted) {
    verdict = 'accept';
  } else if (
    reply.status === 400 &&
    error.code === 'INVALID_REQUEST' &&
    !after.inserted &&
    after.signatureCount === 0
  ) {
    verdict = 'refuse';
  }

  return { verdict, status: reply.status, code: error.code, inserted: after.inserted };
};

// ---------------------------------------------------------------------------
// Client verdict (profile page, Upload tab)
// ---------------------------------------------------------------------------

const openProfilePad = async (page: Page) => {
  const owner = await createG4Owner();

  await seedSession(page.context(), owner.user.id);
  await page.goto('/settings/profile');
  await page.getByTestId('signature-pad-dialog-button').click();

  const dialog = page.getByRole('dialog');

  await expect(dialog, 'premise: the signature dialog opens').toBeVisible();

  return dialog;
};

const clientUploadVerdict = async (page: Page, file: string) => {
  const dialog = await openProfilePad(page);

  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog.locator('input[type="file"]').setInputFiles(path.join(IMAGE_DIR, file));

  // Premise: the pad has the image (its replace control replaces the empty-state upload button).
  await expect(dialog.getByText('Upload New Image'), 'premise: the upload pad loaded the image').toBeVisible({
    timeout: 10_000,
  });

  // The pad draws and checks asynchronously: sample until two seconds of identical readings.
  const read = async () => ({
    tooSmall: await dialog.getByText('Signature is too small').isVisible(),
    nextEnabled: await dialog.getByRole('button', { name: 'Next' }).isEnabled(),
  });

  let last = await read();
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;

  while (Date.now() - stableSince < 2_000 && Date.now() < deadline) {
    await page.waitForTimeout(200);

    const now = await read();

    if (now.tooSmall !== last.tooSmall || now.nextEnabled !== last.nextEnabled) {
      last = now;
      stableSince = Date.now();
    }
  }

  const { tooSmall, nextEnabled } = last;

  // Recorded, not asserted: the D1 coverage of what the upload canvas holds after its contain-fit, so a
  // client verdict that differs from the server's can be traced to resampling rather than to the rule.
  const uploadCanvasCoverage = await dialog
    .getByTestId('signature-pad-upload')
    .evaluate((element) => {
      const canvas = element instanceof HTMLCanvasElement ? element : element.querySelector('canvas');
      const context = canvas?.getContext('2d');

      if (!canvas || !context || canvas.width === 0 || canvas.height === 0) {
        return null;
      }

      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;

      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        const y = a * (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) + (1 - a) * 255;

        if (y < 230) {
          ink++;
        }
      }

      return { width: canvas.width, height: canvas.height, coverage: ink / (canvas.width * canvas.height) };
    })
    .catch((error: unknown) => ({ error: String(error) }));

  let verdict: Verdict = 'other';

  if (nextEnabled && !tooSmall) {
    verdict = 'accept';
  } else if (!nextEnabled) {
    verdict = 'refuse';
  }

  return { verdict, tooSmall, nextEnabled, uploadCanvasCoverage };
};

// ---------------------------------------------------------------------------
// C50, C52-C56
// ---------------------------------------------------------------------------

for (const [name, entry] of C50_FIXTURES) {
  const tags = ['C50', ...d1Criteria(entry.criteria)].join(' ');

  test(`${tags} ${name}: client and server both ${entry.expected} it`, async ({ page, request }) => {
    test.setTimeout(90_000);

    // Pace the run: each test spends a page load's tRPC calls and one sign.
    await pause(2_000);

    const server = await serverVerdict(request, imageDataUrl(name));
    const client = await clientUploadVerdict(page, entry.file);

    const record = {
      fixture: name,
      file: entry.file,
      width: entry.width,
      height: entry.height,
      d1Coverage: entry.coverage,
      expected: entry.expected,
      server,
      client,
      ...(name === 'grey-paper-strokes-2pc'
        ? {
            // C55: the D1 coverage of the whole fixture, paper and strokes together. Every pixel is ink, so
            // the fixture passes on its paper (mean 200, below Y 230) whatever its strokes cover.
            note: 'C55 passes on the paper: D1 counts the grey paper as ink',
            wholeFixtureCoverage: coverageOf(PNG.sync.read(Buffer.from(imageDataUrl(name).slice(P.length), 'base64'))),
          }
        : {}),
    };

    await keepRecord(`C50-${name}.json`, record);

    expect.soft(server.verdict, `${name}: server verdict (${JSON.stringify(server)})`).toBe(entry.expected);
    expect.soft(client.verdict, `${name}: client verdict (${JSON.stringify(client)})`).toBe(entry.expected);
    expect.soft(client.verdict, `${name}: client and server agree`).toBe(server.verdict);
  });
}

test("C50 C52 white-q75.jpg through the Upload tab (the pad's real JPEG path): client and server both refuse it", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  await pause(2_000);

  const client = await clientUploadVerdict(page, manifest['white-q75-jpeg'].file);

  // What the pad holds after decoding the JPEG, as the PNG the pad would submit.
  const padExport = await page
    .getByRole('dialog')
    .getByTestId('signature-pad-upload')
    .evaluate((element) => {
      const canvas = element instanceof HTMLCanvasElement ? element : element.querySelector('canvas');

      return canvas ? canvas.toDataURL('image/png') : null;
    });

  expect(padExport?.startsWith(P), 'premise: the upload pad exports a PNG of the JPEG').toBe(true);

  const server = await serverVerdict(request, padExport ?? '');

  await keepRecord('C50-white-q75-jpeg.json', { client, server, padExportLength: padExport?.length ?? null });

  expect.soft(client.verdict, `client verdict (${JSON.stringify(client)})`).toBe('refuse');
  expect.soft(server.verdict, `server verdict on the pad's export (${JSON.stringify(server)})`).toBe('refuse');
});

// ---------------------------------------------------------------------------
// C57
// ---------------------------------------------------------------------------

const COLOURS = ['Black', 'Red', 'Blue', 'Green'] as const;

/** The same stroke path every time: three passes across the middle of the draw canvas. */
const drawStroke = async (page: Page) => {
  const canvas = page.getByRole('dialog').getByTestId('signature-pad-draw');

  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('Signature canvas has no bounding box');
  }

  const left = box.x + box.width * 0.15;
  const right = box.x + box.width * 0.85;
  const top = box.y + box.height * 0.3;
  const bottom = box.y + box.height * 0.7;

  await page.mouse.move(left, top);
  await page.mouse.down();

  for (let pass = 0; pass < 3; pass++) {
    const y = top + ((bottom - top) * pass) / 3;

    for (let step = 0; step <= 20; step++) {
      const progress = step / 20;
      const x = pass % 2 === 0 ? left + (right - left) * progress : right - (right - left) * progress;

      await page.mouse.move(x, y + (step % 2 === 0 ? 0 : 12));
    }
  }

  await page.mouse.up();
};

/** The SIGNATURE value an envelope.field.sign request body carries (plain or batched tRPC). */
const submittedValue = (postData: string | null) => {
  const body = JSON.parse(postData ?? '{}') as Record<string, unknown>;
  const input = (body.json ?? (body['0'] as Record<string, unknown> | undefined)?.json ?? {}) as {
    fieldValue?: { value?: unknown };
  };

  return typeof input.fieldValue?.value === 'string' ? input.fieldValue.value : null;
};

/**
 * Draws the fixed stroke in `colour` on the V2 signing page's signature pad,
 * confirms, clicks the field, and returns what the browser submitted and how
 * the server answered.
 */
const drawAndSign = async (page: Page, colour: (typeof COLOURS)[number], scheme: 'light' | 'dark') => {
  const seeded = await seedOneSigner(2);
  const field = seeded.r.s1.fields.sig;

  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`/sign/${seeded.r.s1.token}`);

  if (scheme === 'dark') {
    await expect(page.locator('html'), 'premise: the page renders in dark mode').toHaveClass(/dark/);
  } else {
    await expect(page.locator('html'), 'premise: the page renders in light mode').not.toHaveClass(/dark/);
  }

  const konva = page.locator('.konva-container canvas').first();

  await expect(konva).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('signature-pad-dialog-button').click();

  const dialog = page.getByRole('dialog');

  await dialog.getByRole('tab', { name: 'Draw' }).click();

  if (colour !== 'Black') {
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: colour }).click();
  }

  await drawStroke(page);

  const drawCanvas = dialog.getByTestId('signature-pad-draw');
  const exportNow = async () => await drawCanvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const other = scheme === 'dark' ? 'light' : 'dark';

  // The same drawing exported in both schemes: switch the colour scheme on this canvas and export again.
  const exportInScheme = await exportNow();

  await page.emulateMedia({ colorScheme: other });
  await page.waitForTimeout(250);

  const exportInOtherScheme = await exportNow();

  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(250);

  const next = dialog.getByRole('button', { name: 'Next' });
  const nextEnabled = await expect(next)
    .toBeEnabled({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const tooSmall = await dialog.getByText('Signature is too small').isVisible();

  if (!nextEnabled) {
    return { nextEnabled, tooSmall, status: null, value: null, inserted: false, exportInScheme, exportInOtherScheme };
  }

  await next.click();
  await expect(dialog).toBeHidden();

  const canvasBox = await konva.boundingBox();

  if (!canvasBox) {
    throw new Error('Konva canvas has no bounding box');
  }

  // seedOneSigner lays the first field at 8%, 8% with 24% x 8%.
  const requestPromise = page.waitForRequest((req) => req.url().includes('envelope.field.sign'), { timeout: 15_000 });
  const responsePromise = page.waitForResponse((res) => res.url().includes('envelope.field.sign'), {
    timeout: 15_000,
  });

  await konva.click({ position: { x: canvasBox.width * 0.2, y: canvasBox.height * 0.12 } });

  const signRequest = await requestPromise;
  const signResponse = await responsePromise;
  const state = await fieldState(field.id);

  return {
    nextEnabled,
    tooSmall,
    status: signResponse.status(),
    value: submittedValue(signRequest.postData()),
    inserted: state.inserted,
    exportInScheme,
    exportInOtherScheme,
  };
};

/**
 * Mean RGB of the clearly opaque pixels (alpha > 200) of a PNG data URL, so the picker colour can be
 * checked from what was exported. D1's picker colours: black, red (255 0 0), blue (0 0 255), green (0 128 0).
 */
const dominantInk = (dataUrl: string | null) => {
  if (!dataUrl?.startsWith(P)) {
    return null;
  }

  const png = PNG.sync.read(Buffer.from(dataUrl.slice(P.length), 'base64'));
  const sum = [0, 0, 0];
  let count = 0;

  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] > 200) {
      sum[0] += png.data[i];
      sum[1] += png.data[i + 1];
      sum[2] += png.data[i + 2];
      count++;
    }
  }

  return count === 0 ? null : { r: sum[0] / count, g: sum[1] / count, b: sum[2] / count, count };
};

const colourMatches = (colour: (typeof COLOURS)[number], ink: ReturnType<typeof dominantInk>) => {
  if (!ink) {
    return false;
  }

  const { r, g, b } = ink;

  switch (colour) {
    case 'Black':
      return r < 60 && g < 60 && b < 60;
    case 'Red':
      return r > 150 && g < 80 && b < 80;
    case 'Blue':
      return b > 150 && r < 80 && g < 80;
    case 'Green':
      return g > 80 && r < 60 && b < 60;
  }
};

test('C57 a drawing in each picker colour, in light and dark mode, is accepted and exports the same bytes', async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);

  const rows: Array<Record<string, unknown>> = [];

  for (const colour of COLOURS) {
    for (const scheme of ['light', 'dark'] as const) {
      await pause(3_000);

      const result = await drawAndSign(page, colour, scheme);
      const ink = dominantInk(result.value);

      rows.push({
        colour,
        scheme,
        ...result,
        value: result.value ? `${result.value.length} chars` : null,
        exportInScheme: result.exportInScheme ? `${result.exportInScheme.length} chars` : null,
        exportInOtherScheme: result.exportInOtherScheme ? `${result.exportInOtherScheme.length} chars` : null,
        isSameExportInBothSchemes: result.exportInScheme === result.exportInOtherScheme,
        ink,
      });

      expect.soft(result.nextEnabled, `${colour} ${scheme}: the drawing enables Next`).toBe(true);
      expect.soft(result.status, `${colour} ${scheme}: the V2 sign answers 200`).toBe(200);
      expect.soft(result.inserted, `${colour} ${scheme}: the field is inserted`).toBe(true);
      expect.soft(result.value?.startsWith(P), `${colour} ${scheme}: an image was submitted`).toBe(true);
      expect
        .soft(
          colourMatches(colour, ink),
          `${colour} ${scheme}: the export is drawn in the picked colour (${JSON.stringify(ink)})`,
        )
        .toBe(true);
      expect
        .soft(result.exportInScheme?.startsWith('data:image/png') ?? false, `${colour} ${scheme}: the canvas exported`)
        .toBe(true);
      expect
        .soft(
          result.exportInOtherScheme,
          `${colour} ${scheme}: the same drawing exports byte-identically after switching the colour scheme`,
        )
        .toBe(result.exportInScheme);
    }
  }

  await keepRecord('C57-colours.json', { rows });
});
