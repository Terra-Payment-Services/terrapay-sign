import { readFileSync } from 'node:fs';
import path from 'node:path';
import { colord, extend } from 'colord';
import a11yPlugin from 'colord/plugins/a11y';
import { toKebabCase } from 'remeda';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND_COLORS, DEFAULT_DESTRUCTIVE_TEXT_COLOR } from './theme';

extend([a11yPlugin]);

const THEME_CSS_PATH = path.resolve(__dirname, '../../ui/styles/theme.css');

/**
 * The light-mode custom properties exactly as the browser receives them,
 * read from the first `:root` block of `theme.css`.
 */
const readLightThemeHex = (): Record<string, string> => {
  const css = readFileSync(THEME_CSS_PATH, 'utf8');
  const rootStart = css.indexOf(':root');
  const rootBlock = css.slice(rootStart, css.indexOf('\n  }', rootStart));

  const vars: Record<string, string> = {};

  for (const match of rootBlock.matchAll(/--([a-z0-9-]+):\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%;/g)) {
    const [, name, h, s, l] = match;

    vars[name] = colord({ h: Number(h), s: Number(s), l: Number(l) }).toHex();
  }

  return vars;
};

describe('the light theme', () => {
  const theme = readLightThemeHex();

  // HSL with one decimal place cannot hit every hex value exactly, so a
  // channel may differ by one step (warning is #ff9a62 here, #ff9962 there).
  const isSameColour = (a: string, b: string) => {
    const x = colord(a).toRgb();
    const y = colord(b).toRgb();

    return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) <= 1;
  };

  it('gives the hex mirror the same colour as theme.css for every token', () => {
    for (const [key, hex] of Object.entries(DEFAULT_BRAND_COLORS)) {
      const cssHex = theme[toKebabCase(key)];

      expect({ key, matches: Boolean(cssHex) && isSameColour(cssHex, hex) }).toEqual({ key, matches: true });
    }

    expect(isSameColour(theme['destructive-text'], DEFAULT_DESTRUCTIVE_TEXT_COLOR)).toBe(true);
  });

  it('keeps error text at WCAG AA (4.5:1) on white and on the grey-100 page', () => {
    expect(colord(theme['destructive-text']).contrast(theme.background)).toBeGreaterThanOrEqual(4.5);
    expect(colord(theme['destructive-text']).contrast(theme.muted)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the danger button label at WCAG AA (4.5:1) on its fill', () => {
    expect(colord(theme['destructive-foreground']).contrast(theme.destructive)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps input borders at the 3:1 WCAG 1.4.11 asks of a control boundary', () => {
    expect(colord(theme.input).contrast(theme.background)).toBeGreaterThanOrEqual(3);
    expect(colord(theme.input).contrast(theme.muted)).toBeGreaterThanOrEqual(3);
  });
});
