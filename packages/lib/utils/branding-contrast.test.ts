import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND_COLORS } from '../constants/theme';
import { dropUnreadableBrandingTokens, findBrandingTokenProblems } from './branding-contrast';

/**
 * Round 21 (C114): `['background', 'input']` is a channel B pair at 3:1 in every theme the
 * renderer shows. The `input` token draws form-field and checkbox borders; the default `#6e7586`
 * reads 4.61:1 on the default white. Tokens go through the same path as the other pairs: refused at
 * save (`findBrandingTokenProblems`) and dropped at render for rows stored earlier
 * (`dropUnreadableBrandingTokens`).
 */
describe('round 21: the input token', () => {
  // #000000 since the amendment after the round 21 red run: about 1.2:1 on the dark default background.
  for (const input of ['#f5f5f5', '#ffffff', '#000000']) {
    it(`reports { input: '${input}' } on a default background, naming the pair`, () => {
      const problems = findBrandingTokenProblems({ input });

      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((problem) => problem.tokens.includes('input'))).toBe(true);
      expect(problems.map((problem) => problem.detail).join(' ')).toMatch(/background/i);
    });

    it(`drops a stored { input: '${input}' } at render and keeps the readable tokens`, () => {
      const kept = dropUnreadableBrandingTokens({ input, primary: '#047857', primaryForeground: '#ffffff' });

      expect(kept?.input).toBeUndefined();
      expect(kept?.primary).toBe('#047857');
      expect(kept?.primaryForeground).toBe('#ffffff');
    });
  }

  it("keeps { input: '#6e7586' }, the default", () => {
    expect(findBrandingTokenProblems({ input: '#6e7586' })).toEqual([]);
    expect(dropUnreadableBrandingTokens({ input: '#6e7586' })?.input).toBe('#6e7586');
  });

  it("keeps { input: '#808080' }, readable on both default backgrounds", () => {
    expect(findBrandingTokenProblems({ input: '#808080' })).toEqual([]);
    expect(dropUnreadableBrandingTokens({ input: '#808080' })?.input).toBe('#808080');
  });

  it('reports a faint input against a tenant background too', () => {
    const problems = findBrandingTokenProblems({ background: '#202020', foreground: '#ffffff', input: '#262626' });

    expect(problems.some((problem) => problem.tokens.includes('input'))).toBe(true);
  });
});

/** A clause naming `foreground on background`, whole words, as the warnings word a pair. */
const namesPair = (details: string, foreground: string, background: string) =>
  new RegExp(`(^|[^A-Za-z])${foreground} on ${background}([^A-Za-z]|$)`).test(details);

/**
 * Round 22 (C118): the save-time pairs enumerated from the signing components. The mobile widget
 * paints `bg-card` under `text-foreground` and `text-muted-foreground` (document-signing-mobile-widget.tsx
 * lines 36, 48, 56, 66); the V1 widget paints `bg-widget` under `text-foreground`
 * (document-signing-page-view-v1.tsx lines 293, 295).
 */
describe('round 22: pairs from the signing widgets', () => {
  it("reports { card: '#6e7586', cardForeground: '#ffffff' }, naming foreground and mutedForeground on card", () => {
    const problems = findBrandingTokenProblems({ card: '#6e7586', cardForeground: '#ffffff' });
    const details = problems.map((problem) => problem.detail).join('; ');

    expect(problems.some((problem) => problem.tokens.includes('card'))).toBe(true);
    expect(namesPair(details, 'foreground', 'card'), details).toBe(true);
    expect(namesPair(details, 'mutedForeground', 'card'), details).toBe(true);
  });

  it("reports { widget: '#213871' }, naming foreground on widget", () => {
    const problems = findBrandingTokenProblems({ widget: '#213871' });
    const details = problems.map((problem) => problem.detail).join('; ');

    expect(problems.some((problem) => problem.tokens.includes('widget'))).toBe(true);
    expect(namesPair(details, 'foreground', 'widget'), details).toBe(true);
  });

  it('keeps the shipped defaults sent explicitly under the added pairs', () => {
    expect(findBrandingTokenProblems({ ...DEFAULT_BRAND_COLORS })).toEqual([]);
  });

  // C120's brand palette passes every pair, so the "benign tokens stay" journey is reachable.
  it("keeps C120's brand palette", () => {
    expect(findBrandingTokenProblems({ primary: '#c84a44', primaryForeground: '#ffffff' })).toEqual([]);
  });

  // "Fixed backgrounds are pairs too": the dark palette's light mutedForeground reads 1.68:1 on the V2 page
  // root's fixed bg-gray-50 (document-signing-page-view-v2.tsx:84) in the light theme.
  it("refuses C120's dark palette, naming mutedForeground on a fixed surface", () => {
    const problems = findBrandingTokenProblems({
      background: '#0b1020',
      foreground: '#f5f7ff',
      card: '#141b33',
      cardForeground: '#f5f7ff',
      muted: '#1c2442',
      mutedForeground: '#b8c0e0',
      widget: '#141b33',
      input: '#8a93b8',
      popover: '#141b33',
      popoverForeground: '#f5f7ff',
      secondaryForeground: '#f5f7ff',
      primary: '#8fb4ff',
      primaryForeground: '#0b1020',
      secondary: '#1c2442',
    });

    expect(problems.some((problem) => problem.tokens.includes('mutedForeground'))).toBe(true);
    expect(problems.some((problem) => problem.detail.includes('mutedForeground'))).toBe(true);
  });
});

/**
 * Round 23 (C125): a fixed-surface pair carries the alpha of the class that paints it. "Page 1 of 1"
 * paints `text-muted-foreground/80` on gray-50 (pdf-viewer.tsx:317), so `#858585` (3.02:1 opaque) paints
 * about 2.57:1 and is refused; the default composite (about 3.02:1) still passes.
 */
describe('round 23: translucent fixed-surface text', () => {
  it("reports { mutedForeground: '#858585' }, naming mutedForeground", () => {
    const problems = findBrandingTokenProblems({ mutedForeground: '#858585' });

    expect(problems.some((problem) => problem.tokens.includes('mutedForeground'))).toBe(true);
    expect(problems.some((problem) => problem.detail.includes('mutedForeground'))).toBe(true);
  });

  // Control: palettes that pass every pair. A lone explicit mutedForeground would also apply in the dark
  // theme, where it reads 2.99:1 on the dark muted default, so the whole shipped palette is the control.
  it('keeps the shipped defaults and the C120 brand palette', () => {
    expect(findBrandingTokenProblems({ ...DEFAULT_BRAND_COLORS })).toEqual([]);
    expect(findBrandingTokenProblems({ primary: '#c84a44', primaryForeground: '#ffffff' })).toEqual([]);
  });
});

/**
 * Round 23 (C122, C123): the radius token is bounded to 0, 0 to 16px or 0 to 1rem, and a stored
 * radius outside that is dropped by the token cleanup (read here as `dropUnreadableBrandingTokens`).
 */
describe('round 23: the radius token at render', () => {
  for (const radius of ['100%', '2em', '12pt', '100', '17px', '1.5rem']) {
    it(`drops a stored { radius: '${radius}' } and keeps the readable tokens`, () => {
      const kept = dropUnreadableBrandingTokens({ radius, primary: '#047857', primaryForeground: '#ffffff' });

      expect(kept?.radius).toBeUndefined();
      expect(kept?.primary).toBe('#047857');
    });
  }

  for (const radius of ['0', '0.5rem', '16px', '1rem']) {
    it(`keeps a stored { radius: '${radius}' }`, () => {
      expect(dropUnreadableBrandingTokens({ radius })?.radius).toBe(radius);
    });
  }
});

/**
 * Round 24 (C127): "Page 1 of 1" paints mutedForeground at 80% on `dark:bg-background`, so the
 * mutedForeground on background pair is checked at 80% in the dark theme, at save and at render.
 */
describe('round 24: the PDF label on the dark page', () => {
  it("reports { mutedForeground: '#757575' }, naming mutedForeground and the dark theme", () => {
    const problems = findBrandingTokenProblems({ mutedForeground: '#757575' });
    const dark = problems.filter(
      (problem) => problem.tokens.includes('mutedForeground') && /dark/i.test(problem.detail),
    );

    expect(dark.length).toBeGreaterThan(0);
    expect(dark.some((problem) => problem.detail.includes('mutedForeground'))).toBe(true);
  });

  it("drops a stored { mutedForeground: '#757575' } and keeps the readable tokens", () => {
    const kept = dropUnreadableBrandingTokens({
      mutedForeground: '#757575',
      primary: '#c84a44',
      primaryForeground: '#ffffff',
    });

    expect(kept?.mutedForeground).toBeUndefined();
    expect(kept?.primary).toBe('#c84a44');
  });

  it('keeps the shipped defaults and the C120 brand palette', () => {
    expect(findBrandingTokenProblems({ ...DEFAULT_BRAND_COLORS })).toEqual([]);
    expect(findBrandingTokenProblems({ primary: '#c84a44', primaryForeground: '#ffffff' })).toEqual([]);
  });
});
