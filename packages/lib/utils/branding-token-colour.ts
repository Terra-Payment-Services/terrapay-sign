import { colord } from 'colord';

/**
 * The HSL triplet a branding colour token is emitted as on web pages (`h s% l%`, read by
 * `hsl(var(--token))`). `colord` rounds each part to a whole number, so the rendered colour can
 * differ from the token as written; the contrast check reads this same output.
 *
 * @param value a colour token as stored
 */
export const brandingTokenToHslTriplet = (value: string): string => {
  const { h, s, l } = colord(value).toHsl();

  return `${h} ${s}% ${l}%`;
};

/**
 * The hex a branding colour token is emitted as in emails, or null when `colord` cannot read it.
 *
 * @param value a colour token as stored
 */
export const brandingTokenToEmailHex = (value: string): string | null => {
  const parsed = colord(value);

  return parsed.isValid() ? parsed.toHex() : null;
};
