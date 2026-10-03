import fs from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';

import { getSignatureFontFamily, PDF_BODY_FONT_FAMILY, PDF_DISPLAY_FONT_FAMILY } from '../../constants/pdf';
import { PDF_FONT_FILES } from './helpers';

/**
 * The signing certificate and the audit log are what TerraPay produces when a
 * counterparty disputes a signature, and counterparties across Africa, Asia and the
 * Middle East are often named outside Latin script.
 *
 * Skia resolves a font family the way CSS does, then falls through to whatever the
 * host's font book offers. That fallback is why this cannot be tested by rendering on
 * a developer machine: macOS quietly supplies Geeza Pro, Kohinoor Devanagari and
 * PingFang, so a Han name looks perfect locally and comes out as tofu boxes from the
 * Alpine runtime image, which carries no CJK font at all. Two hosts, one signature,
 * two different evidence documents.
 *
 * So the assertion is made against the font binaries this repo ships rather than
 * against a rendering. Every codepoint a recipient name can contain must be covered by
 * some family the stack names and some file we control.
 */

const FONT_DIRECTORY = path.resolve(import.meta.dirname, '../../../../apps/remix/public/fonts');

/**
 * Pull the family names out of a CSS-style font stack, in order. Names may or may not
 * be quoted, and generic keywords such as `sans-serif` drop out because no bundled
 * file backs them.
 */
const familiesIn = (stack: string) =>
  stack
    .split(',')
    .map((family) => family.trim().replace(/^"|"$/g, ''))
    .filter((family) => family in PDF_FONT_FILES);

const openFont = (file: string) => fontkit.create(fs.readFileSync(path.join(FONT_DIRECTORY, file)));

/** Codepoints in `text` that no bundled font named by `stack` can draw. */
const uncoveredCodepoints = (stack: string, text: string) => {
  const fonts = familiesIn(stack).flatMap((family) => PDF_FONT_FILES[family].map(openFont));

  return Array.from(text)
    .map((character) => character.codePointAt(0) ?? 0)
    .filter((codePoint) => codePoint > 0x20)
    .filter((codePoint) => !fonts.some((font) => font.hasGlyphForCodePoint(codePoint)));
};

const names: Array<[string, string]> = [
  ['Latin', 'Jane Latin-Smith'],
  ['Cyrillic', 'Иван Петров'],
  ['Arabic', 'محمد عبد الرحمن الفارسي'],
  ['Devanagari', 'सुरेश कुमार शर्मा'],
  ['Han', '张伟明'],
  ['Japanese', '山田太郎'],
  ['Korean', '김민준'],
];

describe('certificate font coverage', () => {
  it('ships every font file the renderers register', () => {
    for (const files of Object.values(PDF_FONT_FILES)) {
      for (const file of files) {
        expect(fs.existsSync(path.join(FONT_DIRECTORY, file)), `missing font file: ${file}`).toBe(true);
      }
    }
  });

  it('registers no variable font, whose weights skia mixes up when it writes a PDF on Linux', () => {
    for (const files of Object.values(PDF_FONT_FILES)) {
      for (const file of files) {
        expect(Object.keys(openFont(file).variationAxes), `variable font: ${file}`).toEqual([]);
      }
    }
  });

  for (const [script, name] of names) {
    it(`draws a ${script} recipient name from a bundled font in the body stack`, () => {
      expect(uncoveredCodepoints(PDF_BODY_FONT_FAMILY, name)).toEqual([]);
    });

    it(`draws a ${script} heading from a bundled font in the display stack`, () => {
      expect(uncoveredCodepoints(PDF_DISPLAY_FONT_FAMILY, name)).toEqual([]);
    });

    it(`draws a ${script} typed signature from a bundled font`, () => {
      expect(uncoveredCodepoints(getSignatureFontFamily(name), name)).toEqual([]);
    });
  }

  it('keeps the brand faces first so Latin text is unchanged', () => {
    expect(familiesIn(PDF_BODY_FONT_FAMILY)[0]).toBe('Source Sans 3');
    expect(familiesIn(PDF_DISPLAY_FONT_FAMILY)[0]).toBe('TT Firs Neue');
  });
});
