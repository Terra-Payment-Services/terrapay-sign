import { zEmail } from '@documenso/lib/utils/zod';

const ZEmailClaimSchema = zEmail();

/**
 * The only claim OpenID Connect defines as an email address.
 */
const STANDARD_EMAIL_CLAIM = 'email';

/**
 * Fallbacks, and only for Microsoft.
 *
 * Entra ID omits `email` unless the optional claim is configured on the app registration, and
 * sends the address as `preferred_username` or `upn` instead, so without these a correctly
 * configured tenant cannot sign in at all.
 *
 * They are a weaker thing than `email` and the narrowing matters. Microsoft documents
 * `preferred_username` as mutable and says it must not be used for authorization or as a durable
 * identifier; the same is true of `upn`, which a directory administrator can change. This value
 * goes on to match and link an existing account, so accepting it is accepting a claim of
 * ownership from whoever controls the directory that issued it.
 *
 * That is tolerable for Microsoft here because the tenant is pinned to TerraPay's own directory,
 * so the only party who can set those claims is TerraPay. It is not tolerable in general, and an
 * earlier version of this file applied the fallbacks to every provider including generic OIDC,
 * where any accepted authority could have asserted `preferred_username: "someone@terrapay.com"`
 * and been linked to that account.
 *
 * Validating the string as an address does not help. It proves the shape, never the ownership.
 */
const MICROSOFT_EMAIL_CLAIM_FALLBACKS = ['preferred_username', 'upn'] as const;

/**
 * The claims that may carry the user's display name, in the order they are trusted.
 *
 * Entra ID emits `name` only when the directory holds a display name for the account, so guest
 * and some service-created accounts arrive without it. The address is used as the last resort
 * since a missing display name is no reason to refuse an otherwise valid login.
 */
const NAME_CLAIM_KEYS = ['name', 'preferred_username'] as const;

/**
 * Resolve the email address from a decoded ID token, returning null when no claim holds a
 * well-formed address.
 *
 * @param provider - The provider this token came from. The non-standard fallbacks are offered
 *   only to Microsoft, whose tenant is pinned; every other provider must send `email`.
 */
export const extractEmailFromClaims = (claims: Record<string, unknown>, provider?: string): string | null => {
  const keys =
    provider === 'microsoft'
      ? ([STANDARD_EMAIL_CLAIM, ...MICROSOFT_EMAIL_CLAIM_FALLBACKS] as const)
      : ([STANDARD_EMAIL_CLAIM] as const);

  for (const key of keys) {
    const value = claims[key];

    if (typeof value !== 'string') {
      continue;
    }

    const result = ZEmailClaimSchema.safeParse(value.trim());

    if (result.success) {
      return result.data;
    }
  }

  return null;
};

/**
 * Resolve the display name from a decoded ID token, falling back to the resolved email address.
 */
export const extractNameFromClaims = (claims: Record<string, unknown>, fallbackEmail: string): string => {
  // A display name is not an identity and links nothing, so the fallback here
  // is unrestricted in a way the email one deliberately is not.
  for (const key of NAME_CLAIM_KEYS) {
    const value = claims[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return fallbackEmail;
};
