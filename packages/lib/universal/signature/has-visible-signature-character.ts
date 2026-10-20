const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * The typed-signature rule the client and the server share: a typed signature needs at least one letter, number,
 * punctuation mark or symbol, so whitespace and control characters alone are blank.
 *
 * @param text The typed signature.
 */
export const hasVisibleSignatureCharacter = (text: string) => VISIBLE_CHARACTER.test(text);
