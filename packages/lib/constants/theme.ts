import type { TCssVarsSchema } from '../types/css-vars';

/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * KEEP THIS FILE IN SYNC WITH `packages/ui/styles/theme.css`.
 *
 * These are the light-mode default values for the CSS custom properties
 * defined under `:root` in the theme stylesheet, exposed here as hex strings
 * so they can be used as defaults for colour-picker UI components and other
 * places that don't render through CSS variables.
 *
 * If you change a value in `theme.css`, update it here too. There is NO
 * automated check linking the two files; they have drifted historically
 * and will drift again unless you update both.
 *
 * Computed via `colord({ h, s, l }).toHex()` — see the inline HSL comments
 * for the source-of-truth values from `theme.css`.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
export const DEFAULT_BRAND_COLORS = {
  background: '#ffffff', //              0 0% 100%            white
  foreground: '#213871', //              223 54.8% 28.6%      blue-900
  muted: '#eeeff0', //                   210 6.2% 93.7%       grey-100
  mutedForeground: '#6e7586', //         223 9.8% 47.8%       grey-500
  popover: '#ffffff', //                 0 0% 100%            white
  popoverForeground: '#213871', //       223 54.8% 28.6%      blue-900
  card: '#ffffff', //                    0 0% 100%            white
  cardBorder: '#dedfe2', //              225 6.5% 87.8%       grey-200
  cardForeground: '#213871', //          223 54.8% 28.6%      blue-900
  fieldCard: '#e8eefb', //               221 70.4% 94.7%      blue-100
  fieldCardBorder: '#213871', //         223 54.8% 28.6%      blue-900
  fieldCardForeground: '#213871', //     223 54.8% 28.6%      blue-900
  widget: '#f6f7f7', //                  180 5.9% 96.7%       grey-50
  widgetForeground: '#eeeff0', //        210 6.2% 93.7%       grey-100
  border: '#dedfe2', //                  225 6.5% 87.8%       grey-200
  input: '#6e7586', //                   223 9.8% 47.8%       grey-500
  primary: '#213871', //                 223 54.8% 28.6%      blue-900
  primaryForeground: '#ffffff', //       0 0% 100%            white
  secondary: '#eeeff0', //               210 6.2% 93.7%       grey-100
  secondaryForeground: '#213871', //     223 54.8% 28.6%      blue-900
  accent: '#e8eefb', //                  221 70.4% 94.7%      blue-100
  accentForeground: '#213871', //        223 54.8% 28.6%      blue-900
  destructive: '#c84a44', //             3 54.5% 52.5%        coral-700
  destructiveForeground: '#ffffff', //   0 0% 100%            white
  ring: '#213871', //                    223 54.8% 28.6%      blue-900
  warning: '#ff9a62', //                 21 100% 69.2%        orange-500
  envelopeEditorBackground: '#f1f5fe', //222 86.7% 97.1%      blue-50
  // `cardBorderTint` is intentionally excluded from the colour-picker UI:
  // unlike the rest of these tokens it is consumed via `rgb(var(--token))`
  // (not `hsl(...)`) and stored as raw RGB triplets in `theme.css`. It does
  // not flow through `toNativeCssVars` and is not user-customisable from the
  // branding form. `radius` is a length, not a colour, so it lives in
  // `DEFAULT_BRAND_RADIUS` below.
} as const satisfies Record<keyof Omit<TCssVarsSchema, 'radius' | 'cardBorderTint'>, string>;

export const DEFAULT_BRAND_RADIUS = '0.5rem';

/**
 * The dark-mode defaults, from `.dark:not(.dark-mode-disabled)` in `theme.css`, for the tokens
 * the branding contrast check pairs. A token missing here has no dark override and keeps
 * its light value. KEEP IN SYNC WITH `theme.css`, as above.
 */
export const DARK_BRAND_COLORS: Partial<Record<keyof typeof DEFAULT_BRAND_COLORS, string>> = {
  background: 'hsl(222 25% 11%)',
  foreground: 'hsl(0 0% 97%)',
  muted: 'hsl(222 18% 19%)',
  mutedForeground: 'hsl(222 12% 72%)',
  popover: 'hsl(222 25% 13%)',
  popoverForeground: 'hsl(0 0% 92%)',
  card: 'hsl(222 25% 13%)',
  cardForeground: 'hsl(0 0% 95%)',
  widget: 'hsl(222 25% 13%)',
  primary: 'hsl(223 100% 69%)',
  primaryForeground: 'hsl(223 54.8% 12%)',
  secondary: 'hsl(222 18% 19%)',
  secondaryForeground: 'hsl(223 100% 69%)',
  accent: 'hsl(222 15% 26%)',
  accentForeground: 'hsl(223 100% 69%)',
  destructive: 'hsl(3 54.5% 52.5%)',
  destructiveForeground: 'hsl(0 0% 100%)',
};

/**
 * `--destructive-text` in `theme.css`: 2 58.6% 45.5%, TOPS coral-text.
 *
 * Kept out of `DEFAULT_BRAND_COLORS` because that record is typed against the
 * tenant branding schema, and error text is not a colour tenants set.
 */
export const DEFAULT_DESTRUCTIVE_TEXT_COLOR = '#b83530';
