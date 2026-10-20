/**
 * Maximum length (in characters) of the user-supplied custom CSS for branding.
 * Enforced at the TRPC request boundary on both the organisation and team
 * settings update routes, and again by the sanitiser, so a row stored before
 * the limit was lowered renders without its CSS.
 *
 * 32 KiB. This is the real bound on the work a stylesheet can cause on
 * every save and render-cache miss; the sanitiser's pre-parse scan is a second
 * layer inside it.
 */
export const BRANDING_CSS_MAX_LENGTH = 32 * 1024;

/** The refusal when branding CSS is over BRANDING_CSS_MAX_LENGTH. */
export const BRANDING_CSS_TOO_LONG = `the stylesheet is longer than the ${BRANDING_CSS_MAX_LENGTH.toLocaleString('en')}-character (32 KiB) limit`;

/**
 * Branding logo upload constraints. Enforced server-side at the TRPC request
 * boundary (`zfdBrandingImageFile`) and reused by the client form for matching UX.
 */
export const BRANDING_LOGO_MAX_SIZE_MB = 5;

export const BRANDING_LOGO_MAX_SIZE_BYTES = BRANDING_LOGO_MAX_SIZE_MB * 1024 * 1024;

export const BRANDING_LOGO_ALLOWED_TYPES: string[] = ['image/jpeg', 'image/png', 'image/webp'];
