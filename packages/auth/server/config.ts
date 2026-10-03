import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { env } from '@documenso/lib/utils/env';

/**
 * How long a session should live for in milliseconds.
 */
export const AUTH_SESSION_LIFETIME = 1000 * 60 * 60 * 24 * 30; // 30 days.

export type OAuthClientOptions = {
  id: string;
  scope: string[];
  clientId: string;
  clientSecret: string;
  wellKnownUrl: string;
  redirectUrl: string;
  bypassEmailVerification?: boolean;
};

export const GoogleAuthOptions: OAuthClientOptions = {
  id: 'google',
  scope: ['openid', 'email', 'profile'],
  clientId: env('NEXT_PRIVATE_GOOGLE_CLIENT_ID') ?? '',
  clientSecret: env('NEXT_PRIVATE_GOOGLE_CLIENT_SECRET') ?? '',
  redirectUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/callback/google`,
  wellKnownUrl: 'https://accounts.google.com/.well-known/openid-configuration',
  bypassEmailVerification: false,
};

/**
 * The multi-tenant authorities Microsoft accepts in place of a tenant identifier.
 */
const MICROSOFT_TENANT_ALIASES = ['common', 'organizations', 'consumers'];

/**
 * The authority used when no tenant is configured. Keeps existing deployments on the
 * multi-tenant endpoint they were pinned to before the tenant became configurable.
 */
const MICROSOFT_DEFAULT_TENANT = 'common';

/** A tenant GUID, e.g. "72f988bf-86f1-41af-91ab-2d7cd011db47". */
const MICROSOFT_TENANT_GUID_REGEX = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** A verified domain name, e.g. "contoso.onmicrosoft.com". At least two labels, no trailing dot. */
const MICROSOFT_TENANT_DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const isValidMicrosoftTenant = (tenant: string): boolean =>
  MICROSOFT_TENANT_ALIASES.includes(tenant) ||
  MICROSOFT_TENANT_GUID_REGEX.test(tenant) ||
  MICROSOFT_TENANT_DOMAIN_REGEX.test(tenant);

/**
 * Build the OpenID discovery URL for a Microsoft tenant.
 *
 * The tenant is interpolated into the URL, so a value carrying a slash, whitespace or any
 * other URL syntax could move discovery onto a host we do not control and hand the sign in
 * to an attacker-controlled authority. Only a GUID, a verified domain name or one of the
 * multi-tenant literals is accepted.
 *
 * An invalid value throws at config time rather than falling back to `common`, because
 * authenticating an entire deployment against the wrong authority is worse than not starting.
 */
export const formatMicrosoftWellKnownUrl = (tenant: string): string => {
  if (!isValidMicrosoftTenant(tenant)) {
    throw new Error(
      `Invalid NEXT_PRIVATE_MICROSOFT_TENANT "${tenant}". Expected a tenant GUID, a verified domain name, ` +
        `or one of: ${MICROSOFT_TENANT_ALIASES.join(', ')}.`,
    );
  }

  return `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`;
};

/**
 * Decide whether the `email_verified` check may be skipped for Microsoft.
 *
 * Skipping it is necessary for Entra ID, which does not emit the claim, but it is only safe
 * against a tenant we administer. Combined with a multi-tenant authority it is an account
 * takeover: any Microsoft tenant in the world can mint a token, the address in the token is
 * never proven to belong to the person presenting it, and the callback links an unverified
 * address to an existing local account by email, clearing that account's password on the way
 * through. This is the shape of the nOAuth attack.
 *
 * Pinning the tenant closes it, because then only our own directory issues tokens and the
 * address claims are ones we administer. So the two settings are only accepted together when
 * the tenant is a specific one. Refusing at config time is deliberate: this combination is not
 * something to warn about and carry on with.
 *
 * Note that this bounds the damage rather than removing the underlying weakness. Documenso
 * links accounts by email address throughout rather than by the issuer and subject of the
 * token, so any provider trusted to assert an address is trusted to assert any address. Fixing
 * that properly means changing how accounts are keyed, which is a much larger change than this.
 */
export const resolveMicrosoftEmailVerificationBypass = (tenant: string): boolean => {
  const bypass = env('NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY') === 'true';

  if (bypass && MICROSOFT_TENANT_ALIASES.includes(tenant)) {
    throw new Error(
      'NEXT_PRIVATE_MICROSOFT_SKIP_VERIFY cannot be enabled while NEXT_PRIVATE_MICROSOFT_TENANT is ' +
        `"${tenant}". Skipping email verification on a multi-tenant authority lets any Microsoft ` +
        'tenant assert any address and take over an account with that address. Set the tenant to ' +
        'your directory GUID or verified domain name.',
    );
  }

  return bypass;
};

const microsoftTenant = env('NEXT_PRIVATE_MICROSOFT_TENANT') || MICROSOFT_DEFAULT_TENANT;

export const MicrosoftAuthOptions: OAuthClientOptions = {
  id: 'microsoft',
  scope: ['openid', 'email', 'profile'],
  clientId: env('NEXT_PRIVATE_MICROSOFT_CLIENT_ID') ?? '',
  clientSecret: env('NEXT_PRIVATE_MICROSOFT_CLIENT_SECRET') ?? '',
  redirectUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/callback/microsoft`,
  wellKnownUrl: formatMicrosoftWellKnownUrl(microsoftTenant),
  bypassEmailVerification: resolveMicrosoftEmailVerificationBypass(microsoftTenant),
};

export const OidcAuthOptions: OAuthClientOptions = {
  id: 'oidc',
  scope: ['openid', 'email', 'profile'],
  clientId: env('NEXT_PRIVATE_OIDC_CLIENT_ID') ?? '',
  clientSecret: env('NEXT_PRIVATE_OIDC_CLIENT_SECRET') ?? '',
  redirectUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/api/auth/callback/oidc`,
  wellKnownUrl: env('NEXT_PRIVATE_OIDC_WELL_KNOWN') ?? '',
  bypassEmailVerification: env('NEXT_PRIVATE_OIDC_SKIP_VERIFY') === 'true',
};
