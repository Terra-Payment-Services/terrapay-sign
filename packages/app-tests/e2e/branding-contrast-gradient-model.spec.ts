/**
 * Branding contrast, criterion 44: the gradient model matches what Chromium paints.
 *
 * Written from terrapay-sign-evidence/campaign-2026-10-17/G3/spec.md, section "Added after
 * Codex round 1", without reading the checker. The first test paints gradients in a plain
 * page, reads the screenshot pixels along the gradient line, and compares them with three
 * interpolation models: gamma-encoded sRGB with premultiplied alpha, sRGB with straight
 * alpha, and Oklab with premultiplied alpha. Since Codex round 2 the checker no longer
 * evaluates gradients, so this oracle documents the test's own readability measure, which
 * still samples any gradient left on the signing page. The second saves gradients either
 * side of 3:1 and asserts both pairs are dropped with a warning, as C45 decides.
 *
 * | Criterion | Test                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | 44        | C44 painted gradient pixels match sRGB premultiplied interpolation    |
 * | 44, 45    | C44 a near-threshold gradient pair is dropped either side of 3:1      |
 */
import { expect, type Page, test } from '@playwright/test';

import {
  type AdminSession,
  type CssCase,
  contrast,
  openAdminSession,
  type Rgba,
  resetBranding,
  runStylesheetCases,
  THRESHOLD,
  writeEvidence,
} from './fixtures/branding-contrast';

// The tests in this file share one organisation (fixtures/branding-contrast.ts), so they run in
// order in one worker; the config's fullyParallel would otherwise interleave their branding rows.
test.describe.configure({ mode: 'default' });

let admin: AdminSession;

test.beforeAll(async ({ browser }, testInfo) => {
  admin = await openAdminSession(browser, testInfo, 'gradient-model');
});

test.beforeEach(async () => {
  await resetBranding(admin);
});

test.afterAll(async () => {
  await admin?.context.close();
});

const WIDTH = 200;
const TOLERANCE = 3;

type Rgb = [number, number, number];
type Stop = [number, number, number, number];
type Layer = [Stop, Stop];
type Model = 'srgb-premultiplied' | 'srgb-straight' | 'oklab-premultiplied';

const MODELS: Model[] = ['srgb-premultiplied', 'srgb-straight', 'oklab-premultiplied'];

const toLinear = (c: number) => {
  const v = c / 255;

  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const toEncoded = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

  return Math.min(255, Math.max(0, v * 255));
};

const toOklab = ([r, g, b]: Rgb): Rgb => {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([lightness, a, b]: Rgb): Rgb => {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    toEncoded(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toEncoded(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toEncoded(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
};

const lerp = (x: number, y: number, t: number) => x + (y - x) * t;

/** The colour and alpha a two-stop layer has at position t under `model`. */
const sampleLayer = ([from, to]: Layer, t: number, model: Model): Stop => {
  const alpha = lerp(from[3], to[3], t);

  if (alpha === 0) {
    return [0, 0, 0, 0];
  }

  if (model === 'srgb-straight') {
    return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t), alpha];
  }

  const space = model === 'oklab-premultiplied' ? toOklab : (c: Rgb) => c;
  const back = model === 'oklab-premultiplied' ? fromOklab : (c: Rgb) => c;
  const p = space([from[0], from[1], from[2]]).map((v) => v * from[3]);
  const q = space([to[0], to[1], to[2]]).map((v) => v * to[3]);

  return [...back([0, 1, 2].map((i) => lerp(p[i], q[i], t) / alpha) as Rgb), alpha];
};

/** Layers listed top first, as in CSS, composited bottom-up over an opaque white page. */
const modelPixel = (layers: Layer[], t: number, model: Model): Rgb =>
  [...layers].reverse().reduce<Rgb>(
    (under, layer) => {
      const [r, g, b, a] = sampleLayer(layer, t, model);

      return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
    },
    [255, 255, 255],
  );

const cssOf = (layers: Layer[]) =>
  layers.map(([from, to]) => `linear-gradient(to right, rgba(${from.join(', ')}), rgba(${to.join(', ')}))`).join(', ');

/** Paints `background` on a WIDTH x 20 box on a white page and returns its middle row of pixels. */
const paintRow = async (page: Page, background: string): Promise<Rgb[]> => {
  await page.setContent(
    `<html><body style="margin:0;background:#fff"><div id="g" style="width:${WIDTH}px;height:20px;background:${background}"></div></body></html>`,
  );

  const png = await page.locator('#g').screenshot({ scale: 'css' });

  const row = await page.evaluate(async (b64) => {
    const image = new Image();

    image.src = `data:image/png;base64,${b64}`;
    await image.decode();

    const canvas = document.createElement('canvas');

    canvas.width = image.width;
    canvas.height = image.height;

    const context = canvas.getContext('2d');

    if (!context) {
      return { width: 0, pixels: [] };
    }

    context.drawImage(image, 0, 0);

    const data = context.getImageData(0, Math.floor(image.height / 2), image.width, 1).data;

    return {
      width: image.width,
      pixels: Array.from({ length: image.width }, (_, x) => [data[x * 4], data[x * 4 + 1], data[x * 4 + 2]]),
    };
  }, png.toString('base64'));

  expect(row.width, 'screenshot is one pixel per CSS pixel').toBe(WIDTH);

  return row.pixels as Rgb[];
};

const worstError = (pixels: Rgb[], layers: Layer[], model: Model) =>
  Math.max(
    ...pixels.map((pixel, x) => {
      const predicted = modelPixel(layers, (x + 0.5) / WIDTH, model);

      return Math.max(...pixel.map((v, i) => Math.abs(v - predicted[i])));
    }),
  );

const toRgba = ([r, g, b]: Rgb): Rgba => ({ r, g, b, a: 1 });

const lowestContrast = (colours: Rgb[], text: Rgb) =>
  Math.min(...colours.map((c) => contrast(toRgba(c), toRgba(text))));

const modelRow = (layers: Layer[], model: Model) =>
  Array.from({ length: WIDTH }, (_, x) => modelPixel(layers, (x + 0.5) / WIDTH, model));

const OPAQUE = 1;

const red: Stop = [255, 0, 0, OPAQUE];
const blue: Stop = [0, 0, 255, OPAQUE];

const GRADIENTS: { id: string; layers: Layer[]; mustReject: Model[] }[] = [
  { id: 'red-to-blue', layers: [[red, blue]], mustReject: ['oklab-premultiplied'] },
  {
    id: 'black-to-white',
    layers: [
      [
        [0, 0, 0, OPAQUE],
        [255, 255, 255, OPAQUE],
      ],
    ],
    mustReject: ['oklab-premultiplied'],
  },
  {
    id: 'red-to-transparent-blue',
    layers: [
      [
        [255, 0, 0, 1],
        [0, 0, 255, 0],
      ],
    ],
    // A fully transparent end contributes no colour once premultiplied, so Oklab and sRGB
    // agree here; only straight alpha is distinguishable.
    mustReject: ['srgb-straight'],
  },
  {
    id: 'semi-red-to-semi-blue',
    layers: [
      [
        [255, 0, 0, 0.8],
        [0, 0, 255, 0.4],
      ],
    ],
    mustReject: ['srgb-straight', 'oklab-premultiplied'],
  },
  {
    id: 'two-layer-stack',
    layers: [
      [
        [0, 0, 0, 0.5],
        [0, 0, 0, 0],
      ],
      [red, blue],
    ],
    mustReject: ['oklab-premultiplied'],
  },
];

const NEAR_TEXT: Rgb = [0, 0, 0];

const NEAR_CASES: { id: string; layers: Layer[]; models: 'disagree' | 'agree' }[] = [
  {
    // sRGB lowest 2.69:1, Oklab lowest 3.64:1, both endpoints above 3:1.
    id: 'c44-near-disagree',
    layers: [
      [
        [204, 34, 17, OPAQUE],
        [17, 102, 187, OPAQUE],
      ],
    ],
    models: 'disagree',
  },
  {
    // Control: sRGB lowest 3.31:1, Oklab lowest 3.80:1; both models pass.
    id: 'c44-near-control',
    layers: [
      [
        [204, 34, 17, OPAQUE],
        [51, 136, 221, OPAQUE],
      ],
    ],
    models: 'agree',
  },
];

test.describe('[BRANDING_CONTRAST]: gradient model', () => {
  test('C44 painted gradient pixels match sRGB premultiplied interpolation', async ({ page }, testInfo) => {
    const results: Record<string, Record<Model, number>> = {};

    for (const gradient of GRADIENTS) {
      const pixels = await paintRow(page, cssOf(gradient.layers));

      results[gradient.id] = Object.fromEntries(
        MODELS.map((model) => [model, worstError(pixels, gradient.layers, model)]),
      ) as Record<Model, number>;
    }

    await writeEvidence(testInfo, 'c44-pixels', {
      tolerance: TOLERANCE,
      width: WIDTH,
      gradients: GRADIENTS.map((g) => ({ id: g.id, css: cssOf(g.layers), worstChannelError: results[g.id] })),
    });

    for (const gradient of GRADIENTS) {
      const errors = results[gradient.id];

      expect
        .soft(errors['srgb-premultiplied'], `${gradient.id}: pixels within ${TOLERANCE} of sRGB premultiplied`)
        .toBeLessThanOrEqual(TOLERANCE);

      for (const model of gradient.mustReject) {
        expect
          .soft(errors[model], `${gradient.id}: pixels differ from ${model} by more than ${3 * TOLERANCE}`)
          .toBeGreaterThan(3 * TOLERANCE);
      }
    }
  });

  test('C44 a near-threshold gradient pair is dropped either side of 3:1', async ({ page }, testInfo) => {
    const text = `rgb(${NEAR_TEXT.join(', ')})`;
    const judged: Record<string, Record<string, number>> = {};
    const cases: CssCase[] = [];

    for (const near of NEAR_CASES) {
      const background = cssOf(near.layers);
      const painted = lowestContrast(await paintRow(page, background), NEAR_TEXT);
      const srgb = lowestContrast(modelRow(near.layers, 'srgb-premultiplied'), NEAR_TEXT);
      const oklab = lowestContrast(modelRow(near.layers, 'oklab-premultiplied'), NEAR_TEXT);

      judged[near.id] = { painted, srgb, oklab };

      if (near.models === 'disagree') {
        expect(srgb < THRESHOLD, `${near.id}: sRGB model is below 3:1 (${srgb})`).toBe(true);
        expect(oklab >= THRESHOLD, `${near.id}: Oklab model is at or above 3:1 (${oklab})`).toBe(true);
      } else {
        expect(Math.min(srgb, oklab), `${near.id}: both models pass`).toBeGreaterThanOrEqual(THRESHOLD);
      }

      const selector = `.g3-${near.id}`;

      // Gradient pairs are no longer measured (C45): dropped whatever the browser paints.
      cases.push({
        id: near.id,
        selector,
        css: `${selector} { color: ${text}; background: ${background}; }`,
        expected: 'refused',
      });
    }

    await writeEvidence(testInfo, 'c44-near-threshold', {
      text,
      judged,
      expected: cases.map((c) => ({ id: c.id, expected: c.expected })),
    });

    await runStylesheetCases({ admin, page, testInfo, name: 'c44-near', cases });
  });
});
