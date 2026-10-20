import { SIGNATURE_MIN_COVERAGE_THRESHOLD } from '../../constants/signatures';

/** A pixel composited over white is ink when its luminance is below this (G4 decision D1). */
export const SIGNATURE_INK_LUMINANCE_CUTOFF = 230;

export type SignatureInkAssessment = {
  isValid: boolean;
  coverage: number;
};

/**
 * The one ink rule the signature pad and the server share (G4 decision D1).
 *
 * A pixel is ink when, composited over white, its luminance
 * `a * (0.299 R + 0.587 G + 0.114 B) + (1 - a) * 255` is below 230. The
 * arithmetic is done in integers (weights in thousandths, alpha in 0..255) so
 * the boundary does not depend on floating-point rounding. The signature is
 * valid when ink pixels over all pixels exceed
 * SIGNATURE_MIN_COVERAGE_THRESHOLD.
 *
 * @param rgba 8-bit RGBA pixels, row-major, as `getImageData` or sharp's raw output gives them.
 * @param width Image width in pixels.
 * @param height Image height in pixels.
 */
export const assessSignatureInk = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): SignatureInkAssessment => {
  const totalPixels = width * height;
  const cutoff = SIGNATURE_INK_LUMINANCE_CUTOFF * 255 * 1000;
  let inkPixels = 0;

  for (let i = 0; i < totalPixels * 4; i += 4) {
    const alpha = rgba[i + 3];
    const luminance = 299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2];

    if (alpha * luminance + (255 - alpha) * 255 * 1000 < cutoff) {
      inkPixels++;
    }
  }

  const coverage = inkPixels / totalPixels;

  return { isValid: coverage > SIGNATURE_MIN_COVERAGE_THRESHOLD, coverage };
};
