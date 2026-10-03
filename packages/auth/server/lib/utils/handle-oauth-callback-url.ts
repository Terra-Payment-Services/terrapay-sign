import { formatPath, NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import {
  isDisposableEmail,
  isEmailDomainAllowedForSignup,
  isSignupEnabledForProvider,
} from '@documenso/lib/constants/auth';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { addUserToSoleOrganisation } from '@documenso/lib/server-only/organisation/add-user-to-sole-organisation';
import { getEmailBlocklistDomains } from '@documenso/lib/server-only/site-settings/get-email-blocklist-domains';
import { onCreateUserHook } from '@documenso/lib/server-only/user/create-user';
import { deletedServiceAccountEmail } from '@documenso/lib/server-only/user/service-accounts/deleted-account';
import { legacyServiceAccountEmail } from '@documenso/lib/server-only/user/service-accounts/legacy-service-account';
import { decideAccountForIssuer } from '@documenso/lib/utils/account-issuer';
import { env } from '@documenso/lib/utils/env';
import { isValidReturnTo, normalizeReturnTo } from '@documenso/lib/utils/is-valid-return-to';
import { logger } from '@documenso/lib/utils/logger';
import { prisma } from '@documenso/prisma';
import { UserSecurityAuditLogType } from '@prisma/client';
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';

import type { OAuthClientOptions } from '../../config';
import { AuthenticationErrorCode } from '../errors/error-codes';
import { onAuthorize } from './authorizer';
import { assertIdTokenClaims } from './id-token-claims';
import { extractEmailFromClaims, extractNameFromClaims } from './oauth-claims';
import { getOpenIdConfiguration } from './open-id';
import { exchangeAuthorizationCode } from './token-exchange';
import { verifyIdToken } from './verify-id-token';

type HandleOAuthCallbackUrlOptions = {
  c: Context;
  clientOptions: OAuthClientOptions;
};

export const handleOAuthCallbackUrl = async (options: HandleOAuthCallbackUrlOptions) => {
  const { c, clientOptions } = options;

  const requestMeta = c.get('requestMetadata');

  const { email, name, sub, issuer, accessToken, accessTokenExpiresAt, idToken, redirectPath } = await validateOauth({
    c,
    clientOptions,
  });

  if (email.toLowerCase() === legacyServiceAccountEmail() || email.toLowerCase() === deletedServiceAccountEmail()) {
    return c.text('FORBIDDEN', 403);
  }

  // Find the account if possible.
  //
  // `provider` is our own label for a configured authority, not the authority's
  // issuer, so on its own it would let two authorities share a namespace of
  // subjects and let two people resolve to one row. `validateOauth` closes the
  // half of that which is visible at sign in, by refusing any token whose `iss`
  // is not the issuer this provider's discovery document publishes.
  //
  // The other half is a label pointed at a different authority after rows
  // already exist under it, and only the issuer on the row can see that. Rows
  // are fetched on the label or the issuer so that both a repointed label and an
  // identity already linked under another label are visible to the decision.
  const candidates = await prisma.account.findMany({
    where: {
      providerAccountId: sub,
      OR: [{ provider: clientOptions.id }, { issuer }],
    },
    select: {
      id: true,
      userId: true,
      provider: true,
      issuer: true,
    },
  });

  const decision = decideAccountForIssuer(candidates, { provider: clientOptions.id, issuer });

  if (decision.action === 'refuse') {
    throw new AppError(AuthenticationErrorCode.InvalidRequest, {
      message: decision.reason,
    });
  }

  // Directly log in user if account already exists.
  if (decision.action === 'use' || decision.action === 'adopt') {
    // A row written before the issuer column existed. Stamping it here is what
    // makes the estate converge without waiting on the backfill, and it happens
    // before the session is issued so a row that cannot be stamped does not
    // quietly stay ambiguous.
    if (decision.action === 'adopt') {
      await prisma.account.update({
        where: { id: decision.account.id },
        data: { issuer },
      });
    }

    await onAuthorize({ userId: decision.account.userId }, c);

    return c.redirect(redirectPath, 302);
  }

  const userWithSameEmail = await prisma.user.findFirst({
    where: {
      email: email,
    },
    select: {
      id: true,
      emailVerified: true,
    },
  });

  // Handle existing user but no account.
  if (userWithSameEmail) {
    await prisma.$transaction(async (tx) => {
      await tx.account.create({
        data: {
          type: 'oauth',
          provider: clientOptions.id,
          providerAccountId: sub,
          issuer,
          access_token: accessToken,
          expires_at: Math.floor(accessTokenExpiresAt.getTime() / 1000),
          token_type: 'Bearer',
          id_token: idToken,
          userId: userWithSameEmail.id,
        },
      });

      // Log link event.
      await tx.userSecurityAuditLog.create({
        data: {
          userId: userWithSameEmail.id,
          ipAddress: requestMeta.ipAddress,
          userAgent: requestMeta.userAgent,
          type: UserSecurityAuditLogType.ACCOUNT_SSO_LINK,
        },
      });

      // If account already exists in an unverified state, remove the password to ensure
      // they cannot sign in since we cannot confirm the password was set by the user.
      if (!userWithSameEmail.emailVerified) {
        await tx.user.update({
          where: {
            id: userWithSameEmail.id,
          },
          data: {
            emailVerified: new Date(),
            password: null,
            // Todo: (RR7) Will need to update the "password" account after the migration.
          },
        });
      }
    });

    await onAuthorize({ userId: userWithSameEmail.id }, c);

    return c.redirect(redirectPath, 302);
  }

  // Check if signups are disabled for this provider.
  if (!isSignupEnabledForProvider(clientOptions.id as 'google' | 'microsoft' | 'oidc')) {
    const errorUrl = new URL(formatPath('/signin'), NEXT_PUBLIC_WEBAPP_URL());

    errorUrl.searchParams.set('error', AuthenticationErrorCode.SignupDisabled);

    return c.redirect(errorUrl.toString(), 302);
  }

  // Check domain restriction for new SSO users.
  if (!isEmailDomainAllowedForSignup(email)) {
    const errorUrl = new URL(formatPath('/signin'), NEXT_PUBLIC_WEBAPP_URL());

    errorUrl.searchParams.set('error', AuthenticationErrorCode.SignupDisabled);

    return c.redirect(errorUrl.toString(), 302);
  }

  // Reject disposable / throwaway email providers for new SSO users.
  const additionalBlockedDomains = await getEmailBlocklistDomains();

  if (isDisposableEmail(email, additionalBlockedDomains)) {
    const errorUrl = new URL(formatPath('/signin'), NEXT_PUBLIC_WEBAPP_URL());

    errorUrl.searchParams.set('error', AuthenticationErrorCode.SignupDisposableEmail);

    return c.redirect(errorUrl.toString(), 302);
  }

  // Handle new user.
  const createdUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: email,
        name: name,
        emailVerified: new Date(),
      },
    });

    await tx.account.create({
      data: {
        type: 'oauth',
        provider: clientOptions.id,
        providerAccountId: sub,
        issuer,
        access_token: accessToken,
        expires_at: Math.floor(accessTokenExpiresAt.getTime() / 1000),
        token_type: 'Bearer',
        id_token: idToken,
        userId: user.id,
      },
    });

    return user;
  });

  // Everyone here works inside the TerraPay organisation's teams. A personal
  // organisation would be the only team a new user has, so sign in lands them
  // there instead of on the inbox.
  await onCreateUserHook(createdUser, { skipPersonalOrganisation: true }).catch((err) => {
    // Todo: (RR7) Add logging.
    console.error(err);
  });

  // Only Microsoft sign in is checked against the TerraPay Entra tenant (see
  // validateOauth), so only it can vouch that the new user is staff. A failure
  // here must not block the sign in; the user can still be invited by hand.
  if (clientOptions.id === 'microsoft') {
    try {
      await addUserToSoleOrganisation({ userId: createdUser.id });
    } catch (err) {
      logger.error({ msg: 'Could not add the new user to the organisation', userId: createdUser.id, err });
    }
  }

  await onAuthorize({ userId: createdUser.id }, c);

  return c.redirect(redirectPath, 302);
};

export const validateOauth = async (options: HandleOAuthCallbackUrlOptions) => {
  const { c, clientOptions } = options;

  if (!clientOptions.clientId || !clientOptions.clientSecret) {
    throw new AppError(AppErrorCode.NOT_SETUP);
  }

  const {
    token_endpoint,
    issuer,
    jwks_uri,
    id_token_signing_alg_values_supported: signingAlgorithms,
  } = await getOpenIdConfiguration(clientOptions.wellKnownUrl, {
    requiredScopes: clientOptions.scope,
  });

  const code = c.req.query('code');
  const state = c.req.query('state');

  const storedState = deleteCookie(c, `${clientOptions.id}_oauth_state`);
  const storedCodeVerifier = deleteCookie(c, `${clientOptions.id}_code_verifier`);
  const storedRedirectPath = deleteCookie(c, `${clientOptions.id}_redirect_path`) ?? '';

  if (!code || !storedState || state !== storedState || !storedCodeVerifier) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Invalid or missing state',
    });
  }

  // eslint-disable-next-line prefer-const
  let [redirectState, redirectPath] = storedRedirectPath.split(' ');

  // The sub-path aware root, e.g. "/" or "/ESign/".
  const defaultRedirectPath = formatPath('/');

  if (redirectState !== storedState || !redirectPath) {
    redirectPath = defaultRedirectPath;
  }

  if (!isValidReturnTo(redirectPath)) {
    redirectPath = defaultRedirectPath;
  }

  redirectPath = normalizeReturnTo(redirectPath) || defaultRedirectPath;

  // The exchange is made here rather than by arctic, which offers no way to
  // control what its fetch does with a redirect. See token-exchange.ts.
  const { accessToken, accessTokenExpiresAt, idToken } = await exchangeAuthorizationCode({
    tokenEndpoint: token_endpoint,
    clientId: clientOptions.clientId,
    clientSecret: clientOptions.clientSecret,
    redirectUri: clientOptions.redirectUrl,
    code,
    codeVerifier: storedCodeVerifier,
  });

  // The signature is checked before anything in the token is read. Everything
  // below uses these claims to decide who is signing in, and an unverified
  // claim is a string the authority may never have written.
  //
  // The issuer, the key set and the algorithm list all come from the discovery
  // document of the authority this provider is configured against, so a token
  // is accepted only from the authority we sent the person to. That is also
  // what makes `provider` safe as half of the account key further down: only
  // one issuer can produce a token that gets this far under a given label.
  const claims = await verifyIdToken({
    idToken,
    issuer,
    audience: clientOptions.clientId,
    jwksUri: jwks_uri,
    advertisedSigningAlgorithms: signingAlgorithms,
  });

  // Now the claims a general purpose JWT library has no opinion about. The
  // Entra directory is the one that matters for this deployment, since a
  // verified signature from the right issuer still leaves `tid` unexamined.
  assertIdTokenClaims(claims, {
    audience: clientOptions.clientId,
    tenantId: clientOptions.id === 'microsoft' ? env('NEXT_PRIVATE_MICROSOFT_TENANT') : null,
  });

  const email = extractEmailFromClaims(claims, clientOptions.id);
  const sub = claims.sub;

  if (email === null) {
    throw new AppError(AuthenticationErrorCode.InvalidRequest, {
      message: 'Missing email',
    });
  }

  const name = extractNameFromClaims(claims, email);

  if (typeof sub !== 'string') {
    throw new AppError(AuthenticationErrorCode.InvalidRequest, {
      message: 'Missing sub claim',
    });
  }

  if (claims.email_verified !== true && !clientOptions.bypassEmailVerification) {
    throw new AppError(AuthenticationErrorCode.UnverifiedEmail, {
      message: 'Account email is not verified',
    });
  }

  return {
    email,
    name,
    sub,
    // The authority the token was verified against, taken from the discovery
    // document that supplied the key set. Whatever is configured under this
    // label later cannot change what this token was checked against.
    issuer,
    accessToken,
    accessTokenExpiresAt,
    idToken,
    redirectPath,
  };
};
