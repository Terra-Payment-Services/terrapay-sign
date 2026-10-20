import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RecipientRole, SendStatus, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { canRecipientBeModified, isRecipientEmailValidForSending } from '../../utils/recipients';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertEnvelopeMutable } from '../envelope/assert-envelope-mutable';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { lockEnvelopeForOwnerEdit } from './lock-envelope-for-owner-edit';

export interface DeleteEnvelopeRecipientOptions {
  userId: number;
  teamId: number;
  recipientId: number;
  requestMetadata: ApiRequestMetadata;
}

export const deleteEnvelopeRecipient = async ({
  userId,
  teamId,
  recipientId,
  requestMetadata,
}: DeleteEnvelopeRecipientOptions) => {
  const envelope = await prisma.envelope.findFirst({
    where: {
      recipients: {
        some: {
          id: recipientId,
        },
      },
      team: buildTeamWhereQuery({ teamId, userId }),
    },
    include: {
      documentMeta: true,
      team: true,
      recipients: {
        where: {
          id: recipientId,
        },
        include: {
          fields: true,
        },
      },
    },
  });

  const user = await prisma.user.findFirst({
    where: {
      id: userId,
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  await assertEnvelopeMutable(envelope);

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Document already complete',
    });
  }

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'User not found',
    });
  }

  const recipientToDelete = envelope.recipients[0];

  if (!recipientToDelete || recipientToDelete.id !== recipientId) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Recipient not found',
    });
  }

  if (!canRecipientBeModified(recipientToDelete, recipientToDelete.fields)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Recipient has already interacted with the document.',
    });
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: envelope.id,
    },
    type: null,
    userId,
    teamId,
  });

  const deletedRecipient = await prisma.$transaction(async (tx) => {
    await assertEnvelopeMutable(envelope, tx);

    // Checked again under the envelope lock, which rejection and signing also take, so a recipient who rejected
    // or signed after the read above is not deleted (#121).
    const locked = await lockEnvelopeForOwnerEdit(tx, envelope.id);
    const lockedRecipient = locked.recipients.find((candidate) => candidate.id === recipientId);

    if (!lockedRecipient) {
      throw new AppError(AppErrorCode.NOT_FOUND, {
        message: 'Recipient not found',
      });
    }

    if (!canRecipientBeModified(lockedRecipient, locked.fields)) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Recipient has already interacted with the document.',
      });
    }

    if (envelope.type === EnvelopeType.DOCUMENT) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_DELETED,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            recipientEmail: recipientToDelete.email,
            recipientName: recipientToDelete.name,
            recipientId: recipientToDelete.id,
            recipientRole: recipientToDelete.role,
          },
        }),
      });
    }

    const { count } = await tx.recipient.deleteMany({
      where: {
        id: recipientId,
        envelope: envelopeWhereInput,
        OR: [
          { role: RecipientRole.CC, signingStatus: { not: SigningStatus.REJECTED } },
          { signingStatus: SigningStatus.NOT_SIGNED },
        ],
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Recipient has already interacted with the document.',
      });
    }

    return lockedRecipient;
  });

  const isRecipientRemovedEmailEnabled = extractDerivedDocumentEmailSettings(envelope.documentMeta).recipientRemoved;

  // Send email to deleted recipient.
  if (
    recipientToDelete.sendStatus === SendStatus.SENT &&
    recipientToDelete.role !== RecipientRole.CC &&
    isRecipientRemovedEmailEnabled &&
    envelope.type === EnvelopeType.DOCUMENT &&
    isRecipientEmailValidForSending(recipientToDelete)
  ) {
    // Enqueue the "removed from document" email as a background job so a
    // transient mail outage doesn't fail the request and the send is retried.
    await jobs.triggerJob({
      name: 'send.recipient.removed.email',
      payload: {
        envelopeId: envelope.id,
        recipientEmail: recipientToDelete.email,
        recipientName: recipientToDelete.name,
        inviterName: envelope.team?.name || user.name || undefined,
      },
    });
  }

  return deletedRecipient;
};
