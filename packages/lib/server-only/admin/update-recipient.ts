import { prisma } from '@documenso/prisma';
import { RecipientRole, SendStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData, diffRecipientChanges } from '../../utils/document-audit-logs';
import { lockEnvelopeForOwnerEdit } from '../recipient/lock-envelope-for-owner-edit';
import { getRecipientEmailChangeData } from '../recipient/recipient-email-change';

export type UpdateRecipientOptions = {
  id: number;
  name: string | undefined;
  email: string | undefined;
  role: RecipientRole | undefined;
  requestMetadata: ApiRequestMetadata;
};

export const updateRecipient = async ({ id, name, email, role, requestMetadata }: UpdateRecipientOptions) => {
  const { envelopeId } = await prisma.recipient.findFirstOrThrow({
    where: {
      id,
    },
  });

  return await prisma.$transaction(async (tx) => {
    // Under the lock every recipient action takes, so a field the recipient inserts, or a signature or rejection,
    // is either seen here and refuses the edit, or comes after it and finds the token replaced (#121, #150).
    const { recipients, fields } = await lockEnvelopeForOwnerEdit(tx, envelopeId);

    const recipient = recipients.find((candidate) => candidate.id === id);

    if (
      !recipient ||
      recipient.signingStatus === SigningStatus.SIGNED ||
      recipient.signingStatus === SigningStatus.REJECTED
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot update a recipient that has already signed or rejected.',
      });
    }

    const emailChange = getRecipientEmailChangeData(recipient.email, email);

    // A field already inserted was put there by the person at the old address; it must not pass to someone else.
    if (emailChange.token && fields.some((field) => field.recipientId === id && field.inserted)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Cannot update a recipient that has already signed or rejected.',
      });
    }

    // A new person has not been sent the document; the owner's edit routes reset the same way.
    const sendStatus = (role ?? recipient.role) === RecipientRole.CC ? SendStatus.SENT : SendStatus.NOT_SENT;

    const updatedRecipient = await tx.recipient.update({
      where: {
        id,
      },
      data: {
        name,
        email,
        role,
        ...emailChange,
        ...(emailChange.token ? { sendStatus } : {}),
      },
    });

    // Diffed against the row read under the lock, so concurrent admin edits each record their own transition.
    const changes = diffRecipientChanges(recipient, updatedRecipient);

    if (changes.length > 0) {
      await tx.documentAuditLog.create({
        data: {
          // Taken under the lock: the column default is the transaction's start time, which can order concurrent
          // edits against the order they were applied in.
          createdAt: new Date(),
          ...createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED,
            envelopeId,
            metadata: requestMetadata,
            data: {
              recipientEmail: updatedRecipient.email,
              recipientName: updatedRecipient.name,
              recipientId: updatedRecipient.id,
              recipientRole: updatedRecipient.role,
              changes,
            },
          }),
        },
      });
    }

    return updatedRecipient;
  });
};
