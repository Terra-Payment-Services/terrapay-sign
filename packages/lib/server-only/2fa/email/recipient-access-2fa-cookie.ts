import { prisma } from '@documenso/prisma';
import type { Envelope, Recipient } from '@prisma/client';
import { parseSigned, serializeSigned } from 'hono/utils/cookie';

import { formatSecureCookieName, getCookieDomain, useSecureCookies } from '../../../constants/auth';
import { DocumentAuth } from '../../../types/document-auth';
import { extractDocumentAuthMethods } from '../../../utils/document-auth';
import { env } from '../../../utils/env';

/**
 * How long a recipient stays verified after entering their emailed access
 * code. Long enough to read and sign a document, short enough that a copied
 * cookie is soon useless.
 */
export const RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS = 30 * 60;

const getCookieSecret = () => {
  const secret = env('NEXTAUTH_SECRET');

  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set');
  }

  return secret;
};

/**
 * One cookie per recipient, so verifying for one document does not disturb
 * another open in the same browser.
 */
export const getRecipientAccess2FACookieName = (recipientId: number) =>
  formatSecureCookieName(`recipientAccess2FA-${recipientId}`);

/**
 * Build the Set-Cookie header that marks a recipient as having entered their
 * access code. The signed value carries the recipient ID and an expiry, so it
 * cannot be renamed onto another recipient or kept alive past its lifetime.
 */
export const createRecipientAccess2FACookie = async ({
  recipientId,
  now = Date.now(),
}: {
  recipientId: number;
  now?: number;
}): Promise<string> => {
  const expiresAt = now + RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS * 1000;

  return await serializeSigned(
    getRecipientAccess2FACookieName(recipientId),
    `${recipientId}:${expiresAt}`,
    getCookieSecret(),
    {
      httpOnly: true,
      path: '/',
      // The embedded signing page reads it inside a third-party iframe, as it
      // does the session cookie.
      sameSite: useSecureCookies ? 'None' : 'Lax',
      secure: useSecureCookies,
      partitioned: useSecureCookies ? true : undefined,
      domain: getCookieDomain(),
      maxAge: RECIPIENT_ACCESS_2FA_COOKIE_MAX_AGE_SECONDS,
      expires: new Date(expiresAt),
    },
  );
};

/**
 * Whether the request carries a valid, unexpired access code cookie for this
 * recipient.
 */
export const hasRecipientAccess2FACookie = async ({
  headers,
  recipientId,
  now = Date.now(),
}: {
  headers: Headers;
  recipientId: number;
  now?: number;
}): Promise<boolean> => {
  const cookieHeader = headers.get('cookie');

  if (!cookieHeader) {
    return false;
  }

  const name = getRecipientAccess2FACookieName(recipientId);
  const parsed = await parseSigned(cookieHeader, getCookieSecret(), name);
  const value = parsed[name];

  if (!value) {
    return false;
  }

  const [cookieRecipientId, expiresAt] = value.split(':');

  return Number(cookieRecipientId) === recipientId && Number(expiresAt) > now;
};

/**
 * Whether the recipient's access auth asks for an emailed code.
 */
export const isRecipientAccess2FARequired = ({
  documentAuthOptions,
  recipient,
}: {
  documentAuthOptions: Envelope['authOptions'];
  recipient: Pick<Recipient, 'authOptions'>;
}) => {
  const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
    documentAuth: documentAuthOptions,
    recipientAuth: recipient.authOptions,
  });

  return derivedRecipientAccessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH);
};

/**
 * Whether the request may see the document behind a recipient: either the
 * recipient needs no access code, or the request carries their cookie.
 */
export const isRecipientAccess2FASatisfied = async ({
  headers,
  documentAuthOptions,
  recipient,
}: {
  headers: Headers;
  documentAuthOptions: Envelope['authOptions'];
  recipient: Pick<Recipient, 'id' | 'authOptions'>;
}) => {
  if (!isRecipientAccess2FARequired({ documentAuthOptions, recipient })) {
    return true;
  }

  return await hasRecipientAccess2FACookie({ headers, recipientId: recipient.id });
};

/**
 * The same check for a route that has only a signing token. A token that
 * matches no recipient is reported as satisfied so the route can answer with
 * its own not-found response.
 */
export const isRecipientTokenAccess2FASatisfied = async ({ headers, token }: { headers: Headers; token: string }) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: {
      id: true,
      authOptions: true,
      envelope: {
        select: {
          authOptions: true,
        },
      },
    },
  });

  if (!recipient) {
    return true;
  }

  return await isRecipientAccess2FASatisfied({
    headers,
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
  });
};
