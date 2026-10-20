/**
 * C51 (G4 spec, section 3 and decision D1): the one shared ink rule.
 *
 * Written from the G4 specification before the function exists. The import
 * path packages/lib/universal/signature/assess-signature-ink.ts and the name
 * `assessSignatureInk(rgba, width, height)` are this test's proposal from
 * section 3; the implementer may move the module and this test together.
 * The result may be a boolean or an object carrying the verdict (`isValid`,
 * `valid`, `passes`, `ok` or `hasEnoughInk`) and optionally `coverage`; the
 * `verdictOf` and `coverageOf` readers below accept either shape.
 *
 * The rule (D1): a pixel is ink when, composited over white, it is darker
 * than near-white: Y = a * (0.299 R + 0.587 G + 0.114 B) + (1 - a) * 255 with
 * a = alpha / 255; ink when Y < 230. Coverage is ink pixels over all pixels and
 * must exceed SIGNATURE_MIN_COVERAGE_THRESHOLD (0.01).
 *
 * Failure modes, one test each:
 *  F1 threshold: exactly 1% passes (>= instead of >), or just over 1% fails.
 *  F2 alpha: a fully transparent pixel counts as ink whatever its RGB.
 *  F3 alpha only: any alpha > 0 counts as ink (today's rule), so white or
 *     near-white opaque paper passes.
 *  F4 luminance cut: Y 229 not counted, or Y 230 counted (off by one, <=).
 *  F5 compositing: partial alpha not composited over white (black at alpha 25
 *     of 255 composites to Y 230 and is not ink; at alpha 26 to Y 229 and is).
 *  F6 luminance weights: channels averaged or weighted wrongly, so a picker
 *     colour or a light colour lands on the wrong side.
 *  F7 picker colours: black, red, blue or green (CSS green, 0 128 0) not ink.
 *  F8 denominator: coverage over the inked area, one row, or width alone
 *     instead of every pixel; ink at the end of the buffer not seen.
 *  F9 non-square buffers: width and height swapped or misused.
 *
 * What this seam catches and misses: it pins the arithmetic on literal
 * buffers. It cannot show that the client and the server both call it on the
 * same pixels; C50 in e2e/signature-ink/ink-rule.spec.ts checks that end to end.
 *
 * Red today: the module does not exist (import fails). The mutation half of
 * C51 can run only once it does. The implementer runs, from packages/lib:
 *   npx stryker run --mutate universal/signature/assess-signature-ink.ts \
 *     --jsonReporter.fileName reports/mutation/assess-signature-ink.json
 * (stryker.config.json already uses the vitest runner) and every surviving
 * mutant on the threshold comparison, the alpha test or the luminance test
 * either gets a new failure mode and test here, or is recorded as equivalent.
 */
import { describe, expect, it } from 'vitest';

import { assessSignatureInk } from './assess-signature-ink';

type Rgba = [number, number, number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];
const BLACK: Rgba = [0, 0, 0, 255];

/** A width x height buffer of `background`, with `ink` written at the given pixel indexes. */
const buffer = (width: number, height: number, background: Rgba, ink: Rgba, indexes: number[]) => {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    data.set(indexes.includes(i) ? ink : background, i * 4);
  }

  return data;
};

/** Every pixel `rgba`. */
const solid = (width: number, height: number, rgba: Rgba) => buffer(width, height, rgba, rgba, []);

const verdictOf = (result: unknown): boolean => {
  if (typeof result === 'boolean') {
    return result;
  }

  const record = (result ?? {}) as Record<string, unknown>;

  for (const key of ['isValid', 'valid', 'passes', 'ok', 'hasEnoughInk']) {
    if (typeof record[key] === 'boolean') {
      return record[key] as boolean;
    }
  }

  throw new Error(`assessSignatureInk returned no boolean verdict: ${JSON.stringify(result)}`);
};

const coverageOf = (result: unknown): number | undefined => {
  const value = (result as Record<string, unknown> | null)?.coverage;

  return typeof value === 'number' ? value : undefined;
};

const assess = (data: Uint8ClampedArray, width: number, height: number) =>
  assessSignatureInk(data as never, width, height) as unknown;

/** 100 pixels, the first `n` of them `rgba`, the rest transparent. */
const hundredWith = (n: number, rgba: Rgba) =>
  buffer(
    10,
    10,
    TRANSPARENT,
    rgba,
    Array.from({ length: n }, (_, i) => i),
  );

describe('C51 assessSignatureInk (D1)', () => {
  it('F1 exactly 1% coverage is not enough; 2% is', () => {
    expect(verdictOf(assess(hundredWith(1, BLACK), 10, 10)), '1 of 100 pixels').toBe(false);
    expect(verdictOf(assess(hundredWith(2, BLACK), 10, 10)), '2 of 100 pixels').toBe(true);
  });

  it('F1 the cut sits at the fraction, not a pixel count: 10 of 1000 fails, 11 of 1000 passes', () => {
    const ten = buffer(
      40,
      25,
      TRANSPARENT,
      BLACK,
      Array.from({ length: 10 }, (_, i) => i * 7),
    );
    const eleven = buffer(
      40,
      25,
      TRANSPARENT,
      BLACK,
      Array.from({ length: 11 }, (_, i) => i * 7),
    );

    expect(verdictOf(assess(ten, 40, 25))).toBe(false);
    expect(verdictOf(assess(eleven, 40, 25))).toBe(true);
  });

  it('F2 a fully transparent pixel is never ink, whatever its colour', () => {
    expect(verdictOf(assess(solid(10, 10, [0, 0, 0, 0]), 10, 10)), 'transparent black').toBe(false);
    expect(verdictOf(assess(solid(10, 10, [12, 34, 56, 0]), 10, 10)), 'transparent dark colour').toBe(false);
  });

  it('F3 opaque white and near-white paper are not ink', () => {
    expect(verdictOf(assess(solid(10, 10, [255, 255, 255, 255]), 10, 10)), 'white').toBe(false);
    expect(verdictOf(assess(solid(10, 10, [240, 240, 240, 255]), 10, 10)), 'Y 240').toBe(false);
  });

  it('F4 opaque grey 229 is ink and 231 is not', () => {
    // Opaque grey 230 is not used: the spec's formula in floating point gives 229.99999999999997 for it, so
    // its verdict depends on evaluation order rather than on the rule. The exact Y 230 boundary (the `<=`
    // mutant) is pinned by F5, where black at alpha 25 computes to exactly 230.
    expect(verdictOf(assess(solid(10, 10, [229, 229, 229, 255]), 10, 10)), 'Y 229').toBe(true);
    expect(verdictOf(assess(solid(10, 10, [231, 231, 231, 255]), 10, 10)), 'Y 231').toBe(false);
  });

  it('F5 partial alpha is composited over white: black at alpha 26 is ink, at alpha 25 it is not', () => {
    expect(verdictOf(assess(solid(10, 10, [0, 0, 0, 26]), 10, 10)), 'alpha 26: Y 229').toBe(true);
    expect(verdictOf(assess(solid(10, 10, [0, 0, 0, 25]), 10, 10)), 'alpha 25: Y 230').toBe(false);
    expect(verdictOf(assess(solid(10, 10, [0, 0, 0, 128]), 10, 10)), 'alpha 128').toBe(true);
  });

  it('F6 the luminance weights are 0.299, 0.587, 0.114', () => {
    // Pure yellow (255, 255, 0): Y 225.9, ink. An unweighted mean would give 170 (ink too), so pair it
    // with colours the weights put on opposite sides of 230 where a mean would not.
    // (0, 255, 255): Y 178.8, ink. (255, 255, 120): Y 239.6, not ink; mean 210 would call it ink.
    expect(verdictOf(assess(solid(10, 10, [255, 255, 0, 255]), 10, 10)), 'yellow Y 225.9').toBe(true);
    expect(verdictOf(assess(solid(10, 10, [255, 255, 120, 255]), 10, 10)), 'pale yellow Y 239.6').toBe(false);
    // (200, 255, 255): Y 238.6, not ink. (255, 200, 255): Y 222.7, ink. A swap of R and G weights flips both.
    expect(verdictOf(assess(solid(10, 10, [200, 255, 255, 255]), 10, 10)), 'Y 238.6').toBe(false);
    expect(verdictOf(assess(solid(10, 10, [255, 200, 255, 255]), 10, 10)), 'Y 222.7').toBe(true);
  });

  it('F7 every picker colour is ink (black, red, blue, CSS green)', () => {
    for (const [name, rgba] of [
      ['black', [0, 0, 0, 255]],
      ['red', [255, 0, 0, 255]],
      ['blue', [0, 0, 255, 255]],
      ['green', [0, 128, 0, 255]],
    ] as Array<[string, Rgba]>) {
      expect(verdictOf(assess(hundredWith(5, rgba), 10, 10)), `${name} at 5%`).toBe(true);
    }
  });

  it('F8 coverage counts every pixel, including ink at the end of the buffer', () => {
    const lastRow = buffer(10, 10, TRANSPARENT, BLACK, [97, 98, 99]);

    expect(verdictOf(assess(lastRow, 10, 10)), 'three ink pixels in the last row').toBe(true);

    const coverage = coverageOf(assess(lastRow, 10, 10));

    if (coverage !== undefined) {
      expect(coverage).toBeCloseTo(0.03, 10);
    }

    // Light pixels in the same buffer must not dilute or add to the count.
    const mixed = buffer(10, 10, [250, 250, 250, 255], BLACK, [0, 50, 99]);

    expect(verdictOf(assess(mixed, 10, 10)), 'three ink pixels on near-white paper').toBe(true);

    const mixedCoverage = coverageOf(assess(mixed, 10, 10));

    if (mixedCoverage !== undefined) {
      expect(mixedCoverage).toBeCloseTo(0.03, 10);
    }
  });

  it('F9 non-square buffers use width times height', () => {
    // 50 x 2 = 100 pixels; 2 ink pixels at the very end is 2%.
    const wide = buffer(50, 2, TRANSPARENT, BLACK, [98, 99]);

    expect(verdictOf(assess(wide, 50, 2)), '50 x 2 with 2 ink pixels').toBe(true);

    // 1 x 300 = 300 pixels; 3 ink pixels is exactly 1%, not enough; 4 is enough.
    expect(verdictOf(assess(buffer(1, 300, TRANSPARENT, BLACK, [0, 1, 2]), 1, 300)), '3 of 300').toBe(false);
    expect(verdictOf(assess(buffer(1, 300, TRANSPARENT, BLACK, [0, 1, 2, 299]), 1, 300)), '4 of 300').toBe(true);
  });
});
