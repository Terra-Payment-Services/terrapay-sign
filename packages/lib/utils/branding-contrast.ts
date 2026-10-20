import { colord } from 'colord';

import { DARK_BRAND_COLORS, DEFAULT_BRAND_COLORS } from '../constants/theme';
import { isBrandingRadius, type TCssVarsSchema } from '../types/css-vars';
import { brandingTokenToEmailHex, brandingTokenToHslTriplet } from './branding-token-colour';
import { compositeColour, contrastRatio, parseCssColour, type Rgba, showBrandingValue } from './parse-css-colour';

/**
 * The lowest contrast a branding pair may have: WCAG 2.2's level for large text (SC 1.4.3) and
 * for interface components and graphics (SC 1.4.11). It refuses unreadable pairs, not every pair
 * below the 4.5:1 body-text level, which the shipped palette itself misses in places.
 */
export const BRANDING_CONTRAST_THRESHOLD = 3;

export type BrandingTheme = 'light' | 'dark';

/** Signing pages render in either theme, and an unset token follows the theme. */
export const BRANDING_THEMES: BrandingTheme[] = ['light', 'dark'];

export type ColourToken = keyof typeof DEFAULT_BRAND_COLORS;

/** Where tokens are shown: the themes the renderer can show, and how it emits a token. */
export type BrandingRendering = { themes: BrandingTheme[]; emit: 'web' | 'email' };

/** Signing pages: both themes, tokens as rounded HSL. */
export const WEB_RENDERING: BrandingRendering = { themes: BRANDING_THEMES, emit: 'web' };

/** Emails: light defaults only, tokens as hex. */
export const EMAIL_RENDERING: BrandingRendering = { themes: ['light'], emit: 'email' };

/** Background and foreground tokens that sit on each other on a signing page. */
const TOKEN_PAIRS: [ColourToken, ColourToken][] = [
  ['background', 'foreground'],
  ['muted', 'mutedForeground'],
  ['popover', 'popoverForeground'],
  ['card', 'cardForeground'],
  ['fieldCard', 'fieldCardForeground'],
  ['primary', 'primaryForeground'],
  ['secondary', 'secondaryForeground'],
  ['accent', 'accentForeground'],
  ['destructive', 'destructiveForeground'],
  ['background', 'mutedForeground'],
  // Form-field and checkbox borders (`border-input`), a control boundary under WCAG 2.2 SC 1.4.11 (round 21).
  ['background', 'input'],
  // Round 22: pairs found by grep of the signing components, each a text token on a background token.
  // The mobile widget's `bg-card` (document-signing-mobile-widget.tsx:36) under its `text-foreground`
  // heading (:57) and its `text-muted-foreground` Expand icon and subtitle (:49, :66).
  ['card', 'foreground'],
  ['card', 'mutedForeground'],
  // The V1 widget's `bg-widget` (document-signing-page-view-v1.tsx:293) under its `text-foreground`
  // heading (:295) and `text-muted-foreground` subtitle (:350); also document-signing-form.tsx:182.
  ['widget', 'foreground'],
  ['widget', 'mutedForeground'],
  // The attachments popover (`bg-popover`, packages/ui/primitives/popover.tsx:22): its
  // `text-muted-foreground` description (document-signing-attachments-popover.tsx:48), and the
  // paperclip on `bg-muted` (:64) inheriting `text-popover-foreground`.
  ['popover', 'mutedForeground'],
  ['muted', 'popoverForeground'],
  // The viewer's Back button, `variant="secondary"` (`text-secondary-foreground`) with
  // `dark:bg-muted` (document-signing-form.tsx:136, :272).
  ['muted', 'secondaryForeground'],
  // Field loading spinners, `text-primary` on `bg-background` (document-signing-checkbox-field.tsx:266, :267).
  ['background', 'primary'],
  // The rejected page's `text-destructive` icon on the page background (sign.$token+/rejected.tsx:118).
  ['background', 'destructive'],
];

/**
 * Token pairs whose text is painted translucent on signing pages, checked at that alpha in the
 * themes listed, as well as opaque in `TOKEN_PAIRS` (round 24).
 */
const TRANSLUCENT_TOKEN_PAIRS: {
  background: ColourToken;
  foreground: ColourToken;
  alpha: number;
  themes: BrandingTheme[];
}[] = [
  // "Page 1 of 1", `text-muted-foreground/80` (pdf-viewer.tsx:317), on the V2 page root's
  // `dark:bg-background` (document-signing-page-view-v2.tsx:84). The light half is gray-50, below.
  { background: 'background', foreground: 'mutedForeground', alpha: 0.8, themes: ['dark'] },
];

/**
 * Fixed (non-token) backgrounds on signing pages that token-coloured text is painted on, each
 * checked against that token in the themes where the fixed colour shows (round 22). Warnings
 * name the background by its class. `alpha` is the opacity modifier of the class that paints the
 * text, such as `/80`, composited over the fixed colour (round 23). No cited class in `TOKEN_PAIRS`
 * carries one, so those pairs stay opaque.
 */
const FIXED_PAIRS: {
  background: string;
  colour: string;
  foreground: ColourToken;
  alpha: number;
  themes: BrandingTheme[];
}[] = [
  // `bg-gray-50 dark:bg-background` (gray-50 is #f6f7f7 in packages/tailwind-config/index.cjs:173): the
  // V2 signing page root (document-signing-page-view-v2.tsx:84) under "Page 1 of 1"
  // (`text-muted-foreground/80`, pdf-viewer.tsx:317) and the `text-foreground` empty state (:275); and the
  // neutral Alert, `bg-gray-50` with `text-muted-foreground` and a `text-foreground` title
  // (packages/ui/primitives/alert.tsx:13, used by document-signing-auth-set-password.tsx:28). The muted
  // pair is checked at 80%, the PDF label's alpha, which also covers the Alert's opaque text.
  { background: 'gray-50', colour: '#f6f7f7', foreground: 'foreground', alpha: 1, themes: ['light'] },
  { background: 'gray-50', colour: '#f6f7f7', foreground: 'mutedForeground', alpha: 0.8, themes: ['light'] },
];

/** A ratio as the warnings print it, rounded down so 2.995 never reads as 3.00. */
export const formatContrastRatio = (ratio: number) => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

const defaultToken = (token: ColourToken, theme: BrandingTheme): Rgba => {
  const value = (theme === 'dark' ? DARK_BRAND_COLORS[token] : undefined) ?? DEFAULT_BRAND_COLORS[token];

  return parseCssColour(value) as Rgba;
};

const isSet = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * A token as `emit` renders it, or null. Pages turn tokens into rounded HSL through `colord`,
 * which drops alpha and reads names as black, so a token must be opaque, read the same by both
 * parsers, and is then measured as emitted rather than as written.
 */
const readToken = (value: string, emit: BrandingRendering['emit']): Rgba | null => {
  const ours = parseCssColour(value);

  // Our parser refuses a value over the length limit, so colord never sees it.
  if (!ours) {
    return null;
  }

  const theirs = colord(value);

  if (ours.a !== 1 || !theirs.isValid() || theirs.alpha() !== 1) {
    return null;
  }

  const { r, g, b } = theirs.toRgb();

  if (Math.abs(r - ours.r) > 1 || Math.abs(g - ours.g) > 1 || Math.abs(b - ours.b) > 1) {
    return null;
  }

  const emitted = emit === 'web' ? `hsl(${brandingTokenToHslTriplet(value)})` : brandingTokenToEmailHex(value);

  return emitted === null ? null : parseCssColour(emitted);
};

const colourEntries = (colors: TCssVarsSchema) =>
  Object.entries(colors).filter(
    (entry): entry is [string, string] => entry[0] !== 'radius' && isSet(entry[1] as string | undefined),
  );

/** A token as rendered, or the theme default when it is unset or unreadable. */
export const brandingTokenOrDefault = (
  colors: TCssVarsSchema,
  token: ColourToken,
  theme: BrandingTheme,
  emit: BrandingRendering['emit'] = 'web',
): Rgba => {
  const value = colors[token];
  const parsed = isSet(value) ? readToken(value, emit) : null;

  return parsed ?? defaultToken(token, theme);
};

export type BrandingTokenProblem = {
  /** The tokens the tenant set that take part in the problem. */
  tokens: string[];
  detail: string;
};

/**
 * Every unreadable or unreadable-by-the-checker colour token in a branding colour set: tokens
 * that are not an opaque hex, `rgb()` or `hsl()` colour, and pairs below 3:1 in any of `themes`.
 * A pair is checked when the tenant sets either member; the other takes each theme's default.
 *
 * @param colors the tokens as they will be stored or rendered
 * @param rendering where they are shown; emails have only the light defaults and emit hex
 */
export const findBrandingTokenProblems = (
  colors: TCssVarsSchema | null | undefined,
  { themes, emit }: BrandingRendering = WEB_RENDERING,
): BrandingTokenProblem[] => {
  if (!colors) {
    return [];
  }

  const problems: BrandingTokenProblem[] = [];

  for (const [token, value] of colourEntries(colors)) {
    if (readToken(value, emit) === null) {
      problems.push({
        tokens: [token],
        detail: `${token} ${showBrandingValue(value)} is not an opaque hex, rgb() or hsl() colour`,
      });
    }
  }

  for (const [background, foreground] of TOKEN_PAIRS) {
    const setTokens = [background, foreground].filter((token) => isSet(colors[token]));

    if (setTokens.length === 0) {
      continue;
    }

    for (const theme of themes) {
      const ratio = contrastRatio(
        brandingTokenOrDefault(colors, foreground, theme, emit),
        brandingTokenOrDefault(colors, background, theme, emit),
      );

      if (ratio < BRANDING_CONTRAST_THRESHOLD) {
        const shown = emit === 'web' ? 'on signing pages' : 'in emails';

        problems.push({
          tokens: setTokens,
          detail: `${foreground} on ${background} has contrast ${formatContrastRatio(ratio)} in the ${theme} theme ${shown}, below 3:1`,
        });
        break;
      }
    }
  }

  // Translucent text and fixed surfaces are on signing pages only; emails do not paint them.
  for (const pair of emit === 'web' ? TRANSLUCENT_TOKEN_PAIRS : []) {
    const setTokens = [pair.background, pair.foreground].filter((token) => isSet(colors[token]));

    if (setTokens.length === 0) {
      continue;
    }

    for (const theme of pair.themes.filter((name) => themes.includes(name))) {
      const surface = brandingTokenOrDefault(colors, pair.background, theme, emit);
      const text = brandingTokenOrDefault(colors, pair.foreground, theme, emit);
      const ratio = contrastRatio(compositeColour({ ...text, a: text.a * pair.alpha }, surface), surface);

      if (ratio < BRANDING_CONTRAST_THRESHOLD) {
        problems.push({
          tokens: setTokens,
          detail: `${pair.foreground} on ${pair.background} at ${pair.alpha * 100}% opacity has contrast ${formatContrastRatio(ratio)} in the ${theme} theme on signing pages, below 3:1`,
        });
        break;
      }
    }
  }

  for (const pair of emit === 'web' ? FIXED_PAIRS : []) {
    if (!isSet(colors[pair.foreground])) {
      continue;
    }

    for (const theme of pair.themes.filter((name) => themes.includes(name))) {
      const surface = parseCssColour(pair.colour) as Rgba;
      const text = brandingTokenOrDefault(colors, pair.foreground, theme, emit);
      const ratio = contrastRatio(compositeColour({ ...text, a: text.a * pair.alpha }, surface), surface);

      if (ratio < BRANDING_CONTRAST_THRESHOLD) {
        problems.push({
          tokens: [pair.foreground],
          detail: `${pair.foreground} on ${pair.background} (the fixed ${pair.colour} surface${pair.alpha < 1 ? `, text at ${pair.alpha * 100}% opacity` : ''}) has contrast ${formatContrastRatio(ratio)} in the ${theme} theme on signing pages, below 3:1`,
        });
        break;
      }
    }
  }

  return problems;
};

/**
 * The tokens left once every unreadable pair is taken out, for rendering rows saved before the
 * check existed. Unreadable tokens go first; then the tenant-set members of each failing pair, and
 * the survivors are checked again against the defaults now showing, until nothing fails.
 *
 * @returns the readable tokens, or null when none remain
 */
export const dropUnreadableBrandingTokens = (
  colors: TCssVarsSchema | null | undefined,
  rendering: BrandingRendering = WEB_RENDERING,
): TCssVarsSchema | null => {
  if (!colors) {
    return null;
  }

  // Only set values are kept: the checker skips a blank token, so rendering must not emit it.
  const kept: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(colors).filter(([, value]) => isSet(value)),
  );

  // A radius the save would refuse is not rendered (round 23).
  if (isSet(kept.radius) && !isBrandingRadius(kept.radius)) {
    delete kept.radius;
  }

  for (;;) {
    const problems = findBrandingTokenProblems(kept as TCssVarsSchema, rendering);

    if (problems.length === 0) {
      break;
    }

    for (const problem of problems) {
      for (const token of problem.tokens) {
        delete kept[token];
      }
    }
  }

  return Object.values(kept).some((value) => isSet(value)) ? (kept as TCssVarsSchema) : null;
};
