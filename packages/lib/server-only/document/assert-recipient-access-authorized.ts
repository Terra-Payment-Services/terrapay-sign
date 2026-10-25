import { prisma } from '@documenso/prisma';
import type { Envelope, Recipient } from '@prisma/client';
import { EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DocumentAuth } from '../../types/document-auth';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { isRecipientAccess2FASatisfied } from '../2fa/email/recipient-access-2fa-cookie';
import { isRecipientAuthorized } from './is-recipient-authorized';

export type AssertRecipientAccessAuthorizedOptions = {
  documentAuthOptions: Envelope['authOptions'];
  recipient: Pick<Recipient, 'authOptions' | 'email' | 'envelopeId'>;

  /**
   * The ID of the signed-in user making the request, if any.
   */
  userId?: number;
};

/**
 * Throws unless the caller satisfies the recipient's access authentication.
 *
 * The signing page checks this when it loads, but a signing token alone is
 * enough to call the signing mutations directly, so every mutation that acts
 * for a recipient must check it again. No auth options are passed on purpose:
 * `isRecipientAuthorized` then derives the ACCOUNT check from `userId`, and an
 * emailed 2FA code is checked separately at completion.
 */
export const assertRecipientAccessAuthorized = async ({
  documentAuthOptions,
  recipient,
  userId,
}: AssertRecipientAccessAuthorizedOptions) => {
  const isAuthorized = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions,
    recipient,
    userId,
  });

  if (!isAuthorized) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Recipient access authentication is required',
      statusCode: 401,
    });
  }
};

/**
 * Whether a request holding only a signing token may see the document behind
 * it: the caller satisfies the recipient's account requirement, and the
 * emailed access code cookie when one is required. A token that matches no
 * recipient is reported as authorized so the route can answer with its own
 * not-found response.
 */
export const isRecipientTokenAccessAuthorized = async ({
  headers,
  token,
  userId,
}: {
  headers: Headers;
  token: string;
  userId?: number;
}) => {
  const recipient = await prisma.recipient.findFirst({
    where: { token },
    select: {
      id: true,
      token: true,
      email: true,
      envelopeId: true,
      authOptions: true,
      envelope: {
        select: {
          type: true,
          authOptions: true,
        },
      },
    },
  });

  if (!recipient) {
    return true;
  }

  // A direct template's recipient is a placeholder, so "Require account" there means any signed-in user,
  // as the /d/:token page decides.
  if (recipient.envelope.type === EnvelopeType.TEMPLATE) {
    const { derivedRecipientAccessAuth } = extractDocumentAuthMethods({
      documentAuth: recipient.envelope.authOptions,
    });

    if (derivedRecipientAccessAuth.includes(DocumentAuth.ACCOUNT) && !userId) {
      return false;
    }

    return await isRecipientAccess2FASatisfied({
      headers,
      documentAuthOptions: recipient.envelope.authOptions,
      recipient,
    });
  }

  const isAccessAuthorized = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
    userId,
  });

  if (!isAccessAuthorized) {
    return false;
  }

  return await isRecipientAccess2FASatisfied({
    headers,
    documentAuthOptions: recipient.envelope.authOptions,
    recipient,
  });
};
