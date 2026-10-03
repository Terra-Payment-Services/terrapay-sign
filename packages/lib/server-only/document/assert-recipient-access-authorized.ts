import type { Envelope, Recipient } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
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
