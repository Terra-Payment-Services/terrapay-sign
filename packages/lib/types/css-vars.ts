import { z } from 'zod';

/**
 * A CSS length value: `0`, or a positive number followed by `px` or `rem`.
 * Used for the radius field, which is interpolated raw into a `<style>`
 * block at render time. Anything outside this shape is a CSS-injection
 * vector — DO NOT loosen without re-checking `toNativeCssVars`. Since the contrast work
 * round 23 it no longer takes `em`, `%`, `pt` or a bare number.
 */
export const CSS_LENGTH_REGEX = /^(0|(\d+(\.\d+)?)(rem|px))$/i;

/**
 * Whether `value` is a radius the signing pages can take: `0`, `0px` to `16px`, or `0rem` to `1rem`
 * (the default is `0.5rem`). A larger radius rounds a dialog's corners into its text and clips its
 * opaque background, exposing the overlay behind the title, which the contrast guard cannot see
 * (round 23; round 17 removed the stylesheet's radius properties for the same reason).
 */
export const isBrandingRadius = (value: string): boolean => {
  const match = CSS_LENGTH_REGEX.exec(value);

  if (!match) {
    return false;
  }

  if (match[1] === '0') {
    return true;
  }

  const size = Number(match[2]);

  return match[4].toLowerCase() === 'px' ? size <= 16 : size <= 1;
};

const RADIUS_MESSAGE = 'radius must be 0, a px length up to 16px, or a rem length up to 1rem';

export const ZCssVarsSchema = z
  .object({
    background: z.string().optional().describe('Base background color'),
    foreground: z.string().optional().describe('Base text color'),
    muted: z.string().optional().describe('Muted/subtle background color'),
    mutedForeground: z.string().optional().describe('Muted/subtle text color'),
    popover: z.string().optional().describe('Popover/dropdown background color'),
    popoverForeground: z.string().optional().describe('Popover/dropdown text color'),
    card: z.string().optional().describe('Card background color'),
    cardBorder: z.string().optional().describe('Card border color'),
    cardBorderTint: z.string().optional().describe('Card border tint/highlight color'),
    cardForeground: z.string().optional().describe('Card text color'),
    fieldCard: z.string().optional().describe('Field card background color'),
    fieldCardBorder: z.string().optional().describe('Field card border color'),
    fieldCardForeground: z.string().optional().describe('Field card text color'),
    widget: z.string().optional().describe('Widget background color'),
    widgetForeground: z.string().optional().describe('Widget text color'),
    border: z.string().optional().describe('Default border color'),
    input: z.string().optional().describe('Input field border color'),
    primary: z.string().optional().describe('Primary action/button color'),
    primaryForeground: z.string().optional().describe('Primary action/button text color'),
    secondary: z.string().optional().describe('Secondary action/button color'),
    secondaryForeground: z.string().optional().describe('Secondary action/button text color'),
    accent: z.string().optional().describe('Accent/highlight color'),
    accentForeground: z.string().optional().describe('Accent/highlight text color'),
    destructive: z.string().optional().describe('Destructive/danger action color'),
    destructiveForeground: z.string().optional().describe('Destructive/danger text color'),
    ring: z.string().optional().describe('Focus ring color'),
    radius: z
      .string()
      .refine(isBrandingRadius, RADIUS_MESSAGE)
      .optional()
      .describe('Border radius — 0, 0px to 16px, or 0rem to 1rem'),
    warning: z.string().optional().describe('Warning/alert color'),
    envelopeEditorBackground: z.string().optional().describe('Envelope editor background color'),
  })
  .describe('Custom CSS variables for theming');

export type TCssVarsSchema = z.infer<typeof ZCssVarsSchema>;

/**
 * `ZCssVarsSchema` for values stored or passed in before the radius was bounded: a radius
 * `isBrandingRadius` refuses is dropped, so the other tokens still parse (round 23). Saves use
 * `ZCssVarsSchema`, which refuses it.
 */
export const ZStoredCssVarsSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || !('radius' in value)) {
    return value;
  }

  const { radius, ...rest } = value as Record<string, unknown>;

  return typeof radius === 'string' && isBrandingRadius(radius) ? value : rest;
}, ZCssVarsSchema);
