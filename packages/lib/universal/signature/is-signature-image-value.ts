const DATA_URL_PREFIX = /^data:/i;

/**
 * The image-or-typed classification the client and the server share: a signature value is an image when, trimmed,
 * it starts with `data:` in any case (G4 C101).
 *
 * @param value A signature value as stored or sent.
 */
export const isSignatureImageValue = (value: string) => DATA_URL_PREFIX.test(value.trim());

/**
 * An image value in the spelling the rest of the app reads: trimmed, with the `data:` prefix in lower case.
 *
 * @param value A value for which `isSignatureImageValue` holds.
 */
export const toCanonicalSignatureImage = (value: string) => value.trim().replace(DATA_URL_PREFIX, 'data:');
