import { CSS_NAMED_COLOURS } from '../constants/css-named-colours';

/** An sRGB colour with channels 0 to 255, unrounded, and alpha 0 to 1. */
export type Rgba = { r: number; g: number; b: number; a: number };

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const PERCENT_RE = new RegExp(`^${NUMBER}%$`);
const HUE_RE = new RegExp(`^${NUMBER}(?:deg)?$`);
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const FUNCTION_RE = /^(rgba?|hsla?)\(([^()]*)\)$/;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The largest number a colour may contain. Larger numbers, and any that overflow to Infinity, are
 * refused before conversion: the browser still paints them (clamped, or hue taken modulo 360),
 * but the arithmetic here would not follow it.
 */
const MAX_NUMBER = 1_000_000;

/** True when any number in a function's arguments overflows or exceeds `MAX_NUMBER`. */
const hasUnsafeNumber = (text: string) =>
  [...text.matchAll(/\d*\.?\d+/g)].some((match) => {
    const value = parseFloat(match[0]);

    return !Number.isFinite(value) || value > MAX_NUMBER;
  });

/** CSS whitespace: space, tab, line feed, carriage return and form feed, nothing wider. */
const CSS_SPACE = '[ \\t\\n\\r\\f]';
const HAS_SPACE_RE = new RegExp(CSS_SPACE);
const SPACES_RE = new RegExp(`${CSS_SPACE}+`);
const isCssSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

/**
 * Strips CSS whitespace from both ends; `String.trim` also strips Unicode spaces CSS keeps. A scan
 * rather than a regex, because an unanchored `\s+$` is quadratic over interior whitespace.
 */
export const trimCssSpace = (value: string) => {
  let start = 0;
  let end = value.length;

  while (start < end && isCssSpace(value.charCodeAt(start))) {
    start++;
  }

  while (end > start && isCssSpace(value.charCodeAt(end - 1))) {
    end--;
  }

  return value.slice(start, end);
};

/** Folds A to Z only, as CSS matches keywords; `toLowerCase` would also fold the Kelvin sign. */
export const asciiLowerCase = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const parseAlpha = (token: string | undefined): number | null => {
  if (token === undefined) {
    return 1;
  }

  if (NUMBER_RE.test(token)) {
    return clamp(Number(token), 0, 1);
  }

  if (PERCENT_RE.test(token)) {
    return clamp(parseFloat(token) / 100, 0, 1);
  }

  return null;
};

/** Splits a function's arguments in comma or space syntax; null when neither shape fits. */
const splitArguments = (inner: string): { channels: string[]; alpha?: string } | null => {
  const text = trimCssSpace(inner);

  if (text.includes(',')) {
    const parts = text.split(',').map(trimCssSpace);

    if (parts.length < 3 || parts.length > 4 || parts.some((part) => part === '' || HAS_SPACE_RE.test(part))) {
      return null;
    }

    return { channels: parts.slice(0, 3), alpha: parts[3] };
  }

  const [left, alpha, ...rest] = text.split('/').map(trimCssSpace);
  const channels = left.split(SPACES_RE);

  if (rest.length > 0 || channels.length !== 3 || alpha === '' || (alpha !== undefined && HAS_SPACE_RE.test(alpha))) {
    return null;
  }

  return { channels, alpha };
};

const parseRgb = (channels: string[], alpha: number): Rgba | null => {
  const allNumbers = channels.every((channel) => NUMBER_RE.test(channel));
  const allPercents = channels.every((channel) => PERCENT_RE.test(channel));

  if (!allNumbers && !allPercents) {
    return null;
  }

  const [r, g, b] = channels.map((channel) =>
    allNumbers ? clamp(Number(channel), 0, 255) : clamp(parseFloat(channel), 0, 100) * 2.55,
  );

  return { r, g, b, a: alpha };
};

const parseHsl = (channels: string[], alpha: number): Rgba | null => {
  const [hue, saturation, lightness] = channels;

  if (!HUE_RE.test(hue) || !PERCENT_RE.test(saturation) || !PERCENT_RE.test(lightness)) {
    return null;
  }

  const h = (((parseFloat(hue) % 360) + 360) % 360) / 360;
  const s = clamp(parseFloat(saturation), 0, 100) / 100;
  const l = clamp(parseFloat(lightness), 0, 100) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const channel = (offset: number) => {
    const t = (((h + offset) % 1) + 1) % 1;

    if (t < 1 / 6) {
      return p + (q - p) * 6 * t;
    }

    if (t < 1 / 2) {
      return q;
    }

    if (t < 2 / 3) {
      return p + (q - p) * (2 / 3 - t) * 6;
    }

    return p;
  };

  return { r: channel(1 / 3) * 255, g: channel(0) * 255, b: channel(-1 / 3) * 255, a: alpha };
};

const parseHex = (value: string): Rgba => {
  const digits = value.slice(1);
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits;

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
};

/**
 * Reads a CSS colour the way the browser does, for the forms the branding contrast check allows:
 * hex (3, 4, 6 or 8 digits), `rgb()`/`rgba()` and `hsl()`/`hsla()` in comma or space syntax, the
 * CSS named colours and `transparent`. Anything else returns null, including escapes, comments,
 * `currentColor`, CSS-wide keywords and every other colour function, so a caller can refuse what
 * it cannot read rather than guess.
 *
 * @param raw a single colour value, any case
 * @returns the colour, or null when the value is outside the allowed forms
 */
/** The longest colour value or token the contrast check evaluates; longer ones are unreadable. */
export const MAX_BRANDING_VALUE_LENGTH = 1_000;

/** A value as a warning shows it: as written, or by length when it is over the limit. */
export const showBrandingValue = (value: string) =>
  value.length > MAX_BRANDING_VALUE_LENGTH
    ? `(${value.length} characters, over the ${MAX_BRANDING_VALUE_LENGTH.toLocaleString('en')}-character limit)`
    : `"${value}"`;

export const parseCssColour = (raw: string): Rgba | null => {
  if (raw.length > MAX_BRANDING_VALUE_LENGTH) {
    return null;
  }

  const value = asciiLowerCase(trimCssSpace(raw));

  if (value.includes('\\') || value.includes('/*')) {
    return null;
  }

  if (value === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const named = Object.hasOwn(CSS_NAMED_COLOURS, value) ? CSS_NAMED_COLOURS[value] : undefined;

  if (named !== undefined) {
    return parseHex(named);
  }

  if (HEX_RE.test(value)) {
    return parseHex(value);
  }

  const match = value.match(FUNCTION_RE);
  const parts = match ? splitArguments(match[2]) : null;

  if (!match || !parts || hasUnsafeNumber(match[2])) {
    return null;
  }

  const alpha = parseAlpha(parts.alpha);

  if (alpha === null) {
    return null;
  }

  return match[1].startsWith('rgb') ? parseRgb(parts.channels, alpha) : parseHsl(parts.channels, alpha);
};

const linearise = (channel: number) => {
  const c = channel / 255;

  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }: Rgba) => 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);

/**
 * WCAG 2.2 contrast ratio of two opaque colours, `(L1 + 0.05) / (L2 + 0.05)`.
 */
export const contrastRatio = (x: Rgba, y: Rgba): number => {
  const [high, low] = [luminance(x), luminance(y)].sort((p, q) => q - p);

  return (high + 0.05) / (low + 0.05);
};

/**
 * Source-over compositing of `top` on an opaque `bottom`, per sRGB channel, unrounded.
 */
export const compositeColour = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});
