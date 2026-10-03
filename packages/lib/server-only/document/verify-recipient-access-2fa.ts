import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { TRecipientAccessAuth } from '../../types/document-auth';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { createRecipientAccess2FACookie, isRecipientAccess2FARequired } from '../2fa/email/recipient-access-2fa-cookie';
import { assertAccessAuth2FAAttemptAllowed } from './assert-access-auth-2fa-attempt-allowed';
import { isRecipientAuthorized } from './is-recipient-authorized';

export type VerifyRecipientAccess2FAOptions = {
  token: string;
  authOptions: TRecipientAccessAuth;
  userId?: number;
  requestMetadata?: RequestMetadata;
};

/**
 * Check the access code a recipient entered before they are shown the
 * document, and return the Set-Cookie header that lets them through.
 *
 * Attempts count against the same per-recipient limit as completion.
 */
export const verifyRecipientAccess2FA = async ({
  token,
  authOptions,
  userId,
  requestMetadata,
}: VerifyRecipientAccess2FAOptions): Promise<{ cookie: string }> => {
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      envelope: {
        type: EnvelopeType.DOCUMENT,
      },
    },
    include: {
      envelope: {
        select: {
          id: true,
          authOptions: true,
        },
      },
    },
  });

  if (!recipient) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Recipient not found',
    });
  }

  const { envelope } = recipient;

  if (!isRecipientAccess2FARequired({ documentAuthOptions: envelope.authOptions, recipient })) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'This recipient does not require an access code',
    });
  }

  await assertAccessAuth2FAAttemptAllowed({ recipientId: recipient.id });

  const isValid = await isRecipientAuthorized({
    type: 'ACCESS_2FA',
    documentAuthOptions: envelope.authOptions,
    recipient,
    userId,
    authOptions,
  });

  const auditData = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    recipientEmail: recipient.email,
  };

  if (!isValid) {
    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED,
        envelopeId: envelope.id,
        requestMetadata,
        data: auditData,
      }),
    });

    throw new AppError(AppErrorCode.TWO_FACTOR_AUTH_FAILED, {
      message: 'Invalid 2FA authentication',
    });
  }

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED,
      envelopeId: envelope.id,
      requestMetadata,
      data: auditData,
    }),
  });

  return {
    cookie: await createRecipientAccess2FACookie({ recipientId: recipient.id }),
  };
};
