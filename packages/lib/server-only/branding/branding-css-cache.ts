import { createHash } from 'node:crypto';

import type { TCssVarsSchema } from '../../types/css-vars';
import { checkBrandingCssContrast } from '../../utils/branding-css-contrast';
import { sanitizeBrandingCss } from '../../utils/sanitize-branding-css';

/** Bounds on the render cache: entries, and UTF-16 bytes of cached CSS. */
export const MAX_BRANDING_CSS_CACHE_ENTRIES = 200;
export const MAX_BRANDING_CSS_CACHE_BYTES = 16 * 1024 * 1024;

// A Map keeps insertion order, so its first key is the least recently used.
const cache = new Map<string, string>();
let cachedBytes = 0;

const sizeOf = (css: string) => css.length * 2;

const remember = (key: string, css: string) => {
  if (sizeOf(css) > MAX_BRANDING_CSS_CACHE_BYTES) {
    return;
  }

  cache.set(key, css);
  cachedBytes += sizeOf(css);

  while (cache.size > MAX_BRANDING_CSS_CACHE_ENTRIES || cachedBytes > MAX_BRANDING_CSS_CACHE_BYTES) {
    const [oldestKey, oldestCss] = cache.entries().next().value as [string, string];

    cache.delete(oldestKey);
    cachedBytes -= sizeOf(oldestCss);
  }
};

/**
 * The stored branding stylesheet as a signing page renders it: sanitised, then checked for
 * contrast against `colors`. Both are pure functions of the stylesheet and the tokens (the theme
 * defaults are constants), so the result is cached, exact-keyed by a hash of the two, and is
 * reused while resident in the cache rather than recomputed on every page load.
 *
 * @param css the stylesheet as stored
 * @param colors the tokens it renders with, after `dropUnreadableBrandingTokens`
 * @returns the CSS to inline, or '' for none
 */
export const renderStoredBrandingCss = (css: string, colors: TCssVarsSchema | null): string => {
  const key = createHash('sha256')
    .update(JSON.stringify([css, colors]))
    .digest('hex');
  const hit = cache.get(key);

  if (hit !== undefined) {
    // Move it to the most recently used end.
    cache.delete(key);
    cache.set(key, hit);

    return hit;
  }

  const rendered = checkBrandingCssContrast(sanitizeBrandingCss(css).css, colors).css;

  remember(key, rendered);

  return rendered;
};
