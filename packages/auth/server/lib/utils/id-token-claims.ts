import { AppError } from '@documenso/lib/errors/app-error';

import { AuthenticationErrorCode } from '../errors/error-codes';

/**
 * Checking who an ID token was actually minted for.
 *
 * The signature is verified before any of this runs. `verifyIdToken` fetches
 * the authority's keys from its `jwks_uri`, pins the algorithm to what the
 * authority advertises, and refuses the token outright if the signature, `iss`,
 * `aud`, `exp` or `nbf` do not hold up. Callers must go through it first, which
 * `validateOauth` does and which is the only path into these checks.
 *
 * What is left here is the part a general purpose JWT library has no way to
 * know about. `tid` means nothing outside Microsoft, so no library will look at
 * it, and a token dated in the future goes unremarked by most of them. The
 * subject gets its shape checked because it becomes half of the key an account
 * is stored under, where an empty or absurd value would do real damage.
 *
 * `aud` is checked in both places on purpose. The duplication is cheap and it
 * means a future caller that reaches these checks by some other route still
 * gets the audience decided, rather than inheriting a hole from whatever it
 * forgot to call.
 */

/** Allowed clock difference between us and the authority. */
export const CLOCK_SKEW_SECONDS = 300;

/**
 * OpenID Connect caps a subject identifier at 255 ASCII characters. Anything
 * longer is not a subject, and an empty one is certainly not an identity.
 */
const MAX_SUBJECT_LENGTH = 255;

export type IdTokenExpectations = {
  /** The application the token must have been issued for. */
  audience: string;
  /** For Entra, the directory it must have come from. */
  tenantId?: string | null;
  /** Overridden in tests. */
  now?: Date;
};

/**
 * Assert an ID token's claims describe a sign-in we asked for.
 *
 * @throws {AppError} when the token was issued for another application, by
 *   another directory, or is outside its validity window.
 */
export const assertIdTokenClaims = (claims: Record<string, unknown>, expectations: IdTokenExpectations): void => {
  const { audience, tenantId, now = new Date() } = expectations;
  const seconds = Math.floor(now.getTime() / 1000);

  const refuse = (message: string): never => {
    throw new AppError(AuthenticationErrorCode.InvalidRequest, { message });
  };

  // A token minted for a different client, at the same authority, is a real
  // token that says nothing about our application.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (!audiences.some((value) => typeof value === 'string' && value === audience)) {
    refuse('The identity token was issued for a different application');
  }

  // Entra puts the directory in `tid`. With the tenant pinned in the discovery
  // URL we already choose where to send people, but nothing checked where the
  // answer came back from, and a pinned authority is only half the control.
  if (tenantId && typeof claims.tid === 'string' && claims.tid !== tenantId) {
    refuse('The identity token came from a different directory');
  }

  if (tenantId && claims.tid !== undefined && typeof claims.tid !== 'string') {
    refuse('The identity token carries an unreadable directory identifier');
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    refuse('The identity token has no expiry');
  }

  if ((claims.exp as number) + CLOCK_SKEW_SECONDS < seconds) {
    refuse('The identity token has expired');
  }

  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > seconds) {
    refuse('The identity token is not valid yet');
  }

  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > seconds) {
    refuse('The identity token is dated in the future');
  }

  // The subject becomes half of the key an account is stored under, so an
  // empty or absurd one would collapse separate people onto one row.
  const subject = claims.sub;

  if (typeof subject !== 'string' || subject.trim() === '') {
    refuse('The identity token carries no subject');
  }

  if ((subject as string).length > MAX_SUBJECT_LENGTH) {
    refuse('The identity token carries an implausible subject');
  }
};
