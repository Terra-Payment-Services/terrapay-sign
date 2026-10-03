import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { RequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { assertRecipientNotExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, FieldType, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { isRecipientAccess2FARequired } from '../2fa/email/recipient-access-2fa-cookie';
import { assertRecipientAccessAuthorized } from '../document/assert-recipient-access-authorized';

export type RemovedSignedFieldWithTokenOptions = {
  token: string;
  fieldId: number;

  /**
   * The ID of the signed-in user making the request, if any.
   */
  userId?: number;
  /**
   * Whether the request carries the recipient's access code cookie. A
   * recipient whose access auth is an emailed code cannot act without it.
   */
  isAccess2FAVerified?: boolean;
  requestMetadata?: RequestMetadata;
};

export const removeSignedFieldWithToken = async ({
  token,
  fieldId,
  userId,
  isAccess2FAVerified = false,
  requestMetadata,
}: RemovedSignedFieldWithTokenOptions) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      token,
    },
  });

  const field = await prisma.field.findFirstOrThrow({
    where: {
      id: fieldId,
      recipient: {
        ...(recipient.role !== RecipientRole.ASSISTANT
          ? {
              id: recipient.id,
            }
          : {
              signingOrder: {
                gte: recipient.signingOrder ?? 0,
              },
              signingStatus: {
                not: SigningStatus.SIGNED,
              },
              envelopeId: recipient.envelopeId,
            }),
      },
    },
    include: {
      envelope: true,
      recipient: true,
    },
  });

  const { envelope } = field;

  if (!envelope) {
    throw new Error(`Document not found for field ${field.id}`);
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new Error(`Document ${envelope.id} must be pending`);
  }

  assertRecipientNotExpired(recipient);

  if (recipient?.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
    throw new Error(`Recipient ${recipient.id} has already signed`);
  }

  // Unreachable code based on the above query but we need to satisfy TypeScript
  if (field.recipientId === null) {
    throw new Error(`Field ${fieldId} has no recipientId`);
  }

  // Mirrors the guard in signFieldWithToken. An assistant may clear a field they
  // prefilled for someone else, but not tear out that recipient's own signature.
  if (
    recipient.role === RecipientRole.ASSISTANT &&
    field.recipientId !== recipient.id &&
    (field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE)
  ) {
    throw new Error(`Assistant ${recipient.id} cannot remove the signature of recipient ${field.recipientId}`);
  }

  await assertRecipientAccessAuthorized({
    documentAuthOptions: envelope.authOptions,
    recipient,
    userId,
  });

  if (isRecipientAccess2FARequired({ documentAuthOptions: envelope.authOptions, recipient }) && !isAccess2FAVerified) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'The access code must be entered before changing a field',
      statusCode: 401,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.field.update({
      where: {
        id: field.id,
      },
      data: {
        customText: '',
        inserted: false,
      },
    });

    await tx.signature.deleteMany({
      where: {
        fieldId: field.id,
      },
    });

    // Logged for every actor, assistants included. An assistant clearing a field
    // they prefilled for someone else used to leave no trace at all.
    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED,
        envelopeId: envelope.id,
        user: {
          name: recipient.name,
          email: recipient.email,
        },
        requestMetadata,
        data: {
          field: field.type,
          fieldId: field.secondaryId,
        },
      }),
    });
  });
};
