import { NEXT_PUBLIC_WEBAPP_URL } from './app';

export const DEFAULT_STANDARD_FONT_SIZE = 12;
export const DEFAULT_HANDWRITING_FONT_SIZE = 50;
export const DEFAULT_SIGNATURE_TEXT_FONT_SIZE = 18;

export const MIN_STANDARD_FONT_SIZE = 8;
export const MIN_HANDWRITING_FONT_SIZE = 20;

export const CAVEAT_FONT_PATH = () => `${NEXT_PUBLIC_WEBAPP_URL()}/fonts/caveat.ttf`;

const SIGNATURE_FONT_FAMILY_CAVEAT = 'Caveat';

// CN-before-JP: the JP Noto file's Han glyphs use JP shapes, so pure-CN
// text would otherwise render with JP forms. Family names sync with
// apps/remix/app/app.css and packages/lib/server-only/pdf/helpers.ts.
const NOTO_FALLBACK_CHAIN =
  '"Noto Sans", "Noto Sans Arabic", "Noto Sans Chinese", "Noto Sans Japanese", "Noto Sans Korean"';

const SIGNATURE_FONT_FAMILY_NOTO = `${NOTO_FALLBACK_CHAIN}, sans-serif`;

/**
 * Body and heading families for the signing certificate and the audit log.
 *
 * Both are evidence documents, so their glyph coverage has to come from fonts this
 * repo ships rather than from whatever font book the machine generating them happens
 * to have. Source Sans 3 and TT Firs Neue carry Latin, Greek and Cyrillic and nothing
 * else, so a lone family leaves a counterparty named in Arabic, Devanagari or Han at
 * the mercy of the host: a developer Mac substitutes Geeza Pro, Kohinoor and PingFang
 * and the page looks right, while the Alpine runtime image has no Han font at all and
 * the same name comes out as tofu boxes.
 *
 * Skia resolves a comma-separated list per glyph run, the way CSS does, so naming the
 * bundled Noto families after the brand font makes the result the same everywhere.
 */
export const PDF_BODY_FONT_FAMILY = `"Source Sans 3", ${NOTO_FALLBACK_CHAIN}, sans-serif`;

export const PDF_DISPLAY_FONT_FAMILY = `"TT Firs Neue", "Source Sans 3", ${NOTO_FALLBACK_CHAIN}, sans-serif`;

const isASCII = (str: string) => /^\p{ASCII}*$/u.test(str);

// Deliberately never mix handwriting + sans-serif within one signature.
export const getSignatureFontFamily = (typedSignatureText: string): string =>
  isASCII(typedSignatureText) ? SIGNATURE_FONT_FAMILY_CAVEAT : SIGNATURE_FONT_FAMILY_NOTO;

export const PDF_SIZE_A4_72PPI = {
  width: 595,
  height: 842,
};
