import { DEFAULT_BRAND_COLORS } from '../constants/theme';
import type { TCssVarsSchema } from '../types/css-vars';
import { dropUnreadableBrandingTokens, EMAIL_RENDERING } from './branding-contrast';
import { brandingTokenToEmailHex } from './branding-token-colour';

/**
 * The `brandingColors` tokens that emails actually render — the canonical
 * subset of `TCssVarsSchema`. `TCssVarsSchema` is the single source of truth
 * for token names; this tuple just selects the ones email templates use, and
 * both the `EmailBrandingColors` type and the resolver below derive from it.
 */
export const EMAIL_BRANDING_COLOR_KEYS = [
  'background',
  'foreground',
  'muted',
  'mutedForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'accent',
  'accentForeground',
  'destructive',
  'destructiveForeground',
  'warning',
  'border',
] as const satisfies readonly (keyof TCssVarsSchema)[];

export type EmailBrandingColorKey = (typeof EMAIL_BRANDING_COLOR_KEYS)[number];

/**
 * Resolved, email-ready brand colour set.
 *
 * Emails cannot use CSS variables, so every value here is a concrete hex
 * string. This is the shape carried through the email branding context and
 * injected into the per-render Tailwind config.
 *
 * Derived from `TCssVarsSchema` (the persisted shape) by narrowing to the
 * email token subset and making every field required: the resolver fills every
 * token (tenant value or Documenso default), so consumers never see `undefined`.
 *
 * Produced by `resolveEmailBrandingColors`, or `null` when the tenant has no
 * usable/safe colour set (callers fall back to the default Documenso palette).
 */
export type EmailBrandingColors = Required<Pick<TCssVarsSchema, EmailBrandingColorKey>>;

/**
 * Normalise an arbitrary stored colour value (hex or any colord-parseable
 * string) to a hex string. Returns `null` for missing/invalid input.
 *
 * `brandingColors` is validated loosely (`z.string()`) so values are not
 * guaranteed to be valid colours — parse defensively.
 */
export const normalizeColorToHex = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  return brandingTokenToEmailHex(value);
};

/**
 * Resolve a tenant's stored `brandingColors` into an email-ready colour set.
 *
 * Each token is taken from the tenant value when it parses to a valid colour,
 * otherwise the Documenso default. A pair of tokens below 3:1 against each other
 * or the light defaults falls back to the defaults, as on the signing page.
 *
 * Returns `null` (⇒ caller uses the default Documenso palette) only when there
 * is no `brandingColors` object at all.
 */
export const resolveEmailBrandingColors = (
  brandingColors: TCssVarsSchema | null | undefined,
): EmailBrandingColors | null => {
  if (!brandingColors) {
    return null;
  }

  // Emails have no dark theme, so an unset partner is always the light default.
  const readable = dropUnreadableBrandingTokens(brandingColors, EMAIL_RENDERING) ?? {};

  const resolve = (value: string | null | undefined, fallback: string): string =>
    normalizeColorToHex(value) ?? fallback;

  return {
    background: resolve(readable.background, DEFAULT_BRAND_COLORS.background),
    foreground: resolve(readable.foreground, DEFAULT_BRAND_COLORS.foreground),
    muted: resolve(readable.muted, DEFAULT_BRAND_COLORS.muted),
    mutedForeground: resolve(readable.mutedForeground, DEFAULT_BRAND_COLORS.mutedForeground),
    primary: resolve(readable.primary, DEFAULT_BRAND_COLORS.primary),
    primaryForeground: resolve(readable.primaryForeground, DEFAULT_BRAND_COLORS.primaryForeground),
    secondary: resolve(readable.secondary, DEFAULT_BRAND_COLORS.secondary),
    secondaryForeground: resolve(readable.secondaryForeground, DEFAULT_BRAND_COLORS.secondaryForeground),
    accent: resolve(readable.accent, DEFAULT_BRAND_COLORS.accent),
    accentForeground: resolve(readable.accentForeground, DEFAULT_BRAND_COLORS.accentForeground),
    destructive: resolve(readable.destructive, DEFAULT_BRAND_COLORS.destructive),
    destructiveForeground: resolve(readable.destructiveForeground, DEFAULT_BRAND_COLORS.destructiveForeground),
    warning: resolve(readable.warning, DEFAULT_BRAND_COLORS.warning),
    border: resolve(readable.border, DEFAULT_BRAND_COLORS.border),
  };
};
