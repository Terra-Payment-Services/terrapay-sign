import { z } from 'zod';

// Scheme, then the authority as typed, then an optional path, query or fragment.
const URL_SHAPE = /^https?:\/\/([^/?#]*)([/?#].*)?$/i;

// Two or more ASCII labels of letters, digits and hyphens, the last starting with a letter, and an optional port.
// A letter-initial last label rules out every IPv4 spelling, and ASCII rules out IDNA remapping; an internationalised
// domain is entered in its xn-- form.
const AUTHORITY = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*(:\d{1,5})?$/i;

const INVISIBLE_OR_SPACE = /[\s\p{Cc}\p{Cf}\p{Z}\\]/u;

/**
 * Whether a Brand Website is an absolute http(s) URL whose link goes to the host typed (#155). The one rule for saving
 * it and for rendering it as a link. The value is checked as typed, by allowlist, so the URL parser never repairs,
 * decodes, strips or renumbers anything: no whitespace, control, format character or backslash anywhere, no userinfo,
 * and an ASCII host of dotted labels with an optional port, which the parser only lower-cases.
 */
export const isSafeBrandingUrl = (value: string) => {
  if (INVISIBLE_OR_SPACE.test(value)) {
    return false;
  }

  const shape = URL_SHAPE.exec(value);

  if (!shape || !AUTHORITY.test(shape[1])) {
    return false;
  }

  const parsed = URL.parse(value);

  return (
    parsed !== null &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname === shape[1].replace(/:\d+$/, '').toLowerCase()
  );
};

export const ZBrandingUrlSchema = z.string().refine((value) => value === '' || isSafeBrandingUrl(value), {
  message: 'Enter a web address that starts with http:// or https://',
});
