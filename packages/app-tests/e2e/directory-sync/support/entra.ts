/**
 * Sign accounts as Microsoft Entra sign-in leaves them, and the directory
 * entries that go with them.
 *
 * An Account row is written the way the OAuth callback writes one
 * (packages/auth/server/lib/utils/handle-oauth-callback-url.ts): provider
 * `microsoft`, the token's `sub` as providerAccountId, the v2.0 issuer, and the
 * raw id_token. The id_token carries the claims Entra's v2.0 endpoint issues
 * (https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference),
 * among them `oid`, the user's object id, which is the same value Graph returns
 * as the user's `id`, and `tid`, the tenant. `sub` is pairwise per application
 * and is not the object id.
 */

import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { createWebhook } from '@documenso/lib/server-only/webhooks/create-webhook';
import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';
import { WebhookTriggerEvents } from '@prisma/client';

import type { DirectoryUser } from './graph-stub';

import { SIGN_IN_CLIENT_ID, TENANT_ID } from './tenant';

export { OTHER_TENANT_ID, SIGN_IN_CLIENT_ID, SYNC_CLIENT_ID, SYNC_CLIENT_SECRET, TENANT_ID } from './tenant';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_ID = randomBytes(20).toString('base64url');

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The tenant as an issuer URL carries it: Entra's `iss` always holds the bare,
 * lower-case GUID, so a test that spells the `tid` claim differently still
 * gets a real issuer.
 */
const issuerFor = (tid: unknown) =>
  `https://login.microsoftonline.com/${(typeof tid === 'string' ? tid : TENANT_ID)
    .trim()
    .replace(/^\{(.*)\}$/, '$1')
    .trim()
    .toLowerCase()}/v2.0`;

export type IdTokenClaims = {
  oid?: unknown;
  tid?: unknown;
  sub?: string;
  email?: string;
  [claim: string]: unknown;
};

/** An RS256 id_token shaped like one from login.microsoftonline.com/{tid}/v2.0. */
export const entraIdToken = (claims: IdTokenClaims) => {
  const now = Math.floor(Date.now() / 1000) - 86400 * 30;
  const header = { typ: 'JWT', alg: 'RS256', kid: KEY_ID };
  const payload = {
    aud: SIGN_IN_CLIENT_ID,
    iss: issuerFor(claims.tid),
    iat: now,
    nbf: now,
    exp: now + 3600,
    name: claims.email ?? 'Someone',
    preferred_username: claims.email,
    rh: `0.AXkA${randomBytes(24).toString('base64url')}`,
    uti: randomBytes(16).toString('base64url'),
    ver: '2.0',
    ...claims,
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
};

export const newObjectId = () => randomUUID();

export const member = (email: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id: newObjectId(),
  displayName: email.split('@')[0],
  mail: email,
  userPrincipalName: email,
  accountEnabled: true,
  userType: 'Member',
  ...overrides,
});

export const guest = (email: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id: newObjectId(),
  displayName: email.split('@')[0],
  mail: email,
  userPrincipalName: `${email.replace('@', '_')}#EXT#@terrapaystub.onmicrosoft.com`,
  accountEnabled: true,
  userType: 'Guest',
  ...overrides,
});

export type SeedSignAccountOptions = {
  email: string;
  isAdmin?: boolean;
  disabled?: boolean;
  /**
   * The person signed in with Microsoft. `objectId` becomes the token's `oid`,
   * `tenantId` its `tid`. `idToken` replaces the whole token.
   */
  microsoft?: { objectId?: unknown; tenantId?: unknown; idToken?: string };
  /** The address exactly as stored, when it differs from the seeded lower-case one. */
  storedEmail?: string;
};

/**
 * A Sign user with what disabling must cut off: an API token that never
 * expires and an enabled webhook.
 */
export const seedSignAccount = async (options: SeedSignAccountOptions) => {
  const { user, team } = await seedUser({ email: options.email, isAdmin: options.isAdmin });

  await createApiToken({ userId: user.id, teamId: team.id, tokenName: 'directory-sync', expiresIn: null });
  await createWebhook({
    webhookUrl: 'https://hooks.example.invalid/sign',
    eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
    secret: null,
    enabled: true,
    userId: user.id,
    teamId: team.id,
  });

  if (options.microsoft) {
    const sub = randomBytes(32).toString('base64url');
    const tid = options.microsoft.tenantId ?? TENANT_ID;
    const idToken =
      options.microsoft.idToken ??
      entraIdToken({ oid: options.microsoft.objectId, tid, sub, email: options.storedEmail ?? options.email });

    await prisma.account.create({
      data: {
        type: 'oauth',
        provider: 'microsoft',
        providerAccountId: sub,
        issuer: issuerFor(tid),
        access_token: randomBytes(48).toString('base64url'),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
        id_token: idToken,
        userId: user.id,
      },
    });
  }

  if (options.storedEmail) {
    await prisma.user.update({ where: { id: user.id }, data: { email: options.storedEmail } });
  }

  if (options.disabled) {
    await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });
  }

  return { id: user.id, email: options.storedEmail ?? user.email };
};

/**
 * Staff who signed in with Microsoft and are still enabled members. They give
 * a run a body of accounts to keep, so that the disable limit is not what
 * decides a test about matching.
 */
export const seedStaff = async (count: number, directory: DirectoryUser[], prefix = 'staff') => {
  const seeded: { id: number; email: string }[] = [];

  for (let i = 0; i < count; i++) {
    const email = `${prefix}-${i}-${randomBytes(3).toString('hex')}@terrapay-stub.example`;
    const entry = member(email);

    directory.push(entry);
    seeded.push(await seedSignAccount({ email, microsoft: { objectId: entry.id } }));
  }

  return seeded;
};

export type AccountState = {
  disabled: boolean;
  apiTokensLive: number;
  apiTokens: number;
  webhooksEnabled: number;
  webhooks: number;
};

/** What an operator would see in the database for one account. */
export const accountState = async (userId: number): Promise<AccountState> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { disabled: true, apiTokens: { select: { expires: true } }, webhooks: { select: { enabled: true } } },
  });

  const now = Date.now();

  return {
    disabled: user.disabled,
    apiTokens: user.apiTokens.length,
    apiTokensLive: user.apiTokens.filter((t) => t.expires === null || t.expires.getTime() > now).length,
    webhooks: user.webhooks.length,
    webhooksEnabled: user.webhooks.filter((w) => w.enabled).length,
  };
};

export const ACTIVE: AccountState = {
  disabled: false,
  apiTokens: 1,
  apiTokensLive: 1,
  webhooks: 1,
  webhooksEnabled: 1,
};
export const CUT_OFF: AccountState = {
  disabled: true,
  apiTokens: 1,
  apiTokensLive: 0,
  webhooks: 1,
  webhooksEnabled: 0,
};

export const disabledUserCount = async () => await prisma.user.count({ where: { disabled: true } });

/** The two accounts the migrations create, renamed to this host at server start. */
export const serviceAccounts = async () =>
  await prisma.user.findMany({
    where: {
      OR: [{ email: { startsWith: 'serviceaccount@' } }, { email: { startsWith: 'deleted-account@' } }],
    },
    select: { id: true, email: true, disabled: true },
  });
