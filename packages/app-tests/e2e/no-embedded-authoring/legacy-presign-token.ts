import { createHmac } from 'node:crypto';

import { createApiToken } from '@documenso/lib/server-only/public-api/create-api-token';
import { prisma } from '@documenso/prisma';

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Signs a presign token the way the removed upstream embedding code signed one: a compact HS256
 * JWT with protected header `{"alg":"HS256"}`, keyed with the API token row's stored `token`
 * column, `sub` the API token id, `aud` the team id, and `iat`/`exp` in seconds. Built by hand so
 * the tests keep working once that code is gone.
 */
export const signLegacyPresignToken = ({
  storedToken,
  apiTokenId,
  teamId,
  expiresInSeconds = 3600,
  scope,
}: {
  storedToken: string;
  apiTokenId: number;
  teamId: number;
  expiresInSeconds?: number;
  scope?: string;
}) => {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'HS256' }));
  const payload = base64url(
    JSON.stringify({
      aud: String(teamId),
      sub: String(apiTokenId),
      ...(scope ? { scope } : {}),
      iat: now,
      exp: now + expiresInSeconds,
    }),
  );

  const signature = createHmac('sha256', Buffer.from(storedToken, 'utf8')).update(`${header}.${payload}`).digest();

  return `${header}.${payload}.${base64url(signature)}`;
};

/**
 * Creates a real API token for the team and returns both the plaintext the integrator would hold
 * and a legacy presign token signed from the stored row.
 */
export const seedApiTokenWithLegacyPresignToken = async ({ userId, teamId }: { userId: number; teamId: number }) => {
  const tokenName = `legacy-presign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { token: apiToken } = await createApiToken({ userId, teamId, tokenName, expiresIn: null });

  const row = await prisma.apiToken.findFirstOrThrow({ where: { teamId, name: tokenName } });

  const presignToken = signLegacyPresignToken({ storedToken: row.token, apiTokenId: row.id, teamId });

  return { apiToken, presignToken, apiTokenId: row.id };
};
