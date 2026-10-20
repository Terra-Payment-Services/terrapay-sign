import { assessSignatureInk } from '@documenso/lib/universal/signature/assess-signature-ink';
import type { RefObject } from 'react';

/**
 * Checks whether the signature on the canvas has enough ink, using the rule
 * the server applies to every stored signature image (assessSignatureInk).
 */
export const checkSignatureValidity = (element: RefObject<HTMLCanvasElement | null>) => {
  if (!element.current) {
    return false;
  }

  const ctx = element.current.getContext('2d');

  if (!ctx) {
    return false;
  }

  const { width, height } = element.current;
  const imageData = ctx.getImageData(0, 0, width, height);

  return assessSignatureInk(imageData.data, width, height).isValid;
};

export const average = (a: number, b: number) => (a + b) / 2;

export const getSvgPathFromStroke = (points: number[][], closed = true) => {
  const len = points.length;

  if (len < 4) {
    return ``;
  }

  let a = points[0];
  let b = points[1];
  const c = points[2];

  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(
    2,
  )} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;

  for (let i = 2, max = len - 1; i < max; i++) {
    a = points[i];
    b = points[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }

  if (closed) {
    result += 'Z';
  }

  return result;
};
