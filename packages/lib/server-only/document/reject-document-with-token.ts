// This is closely related to `reject-document-on-behalf-of.ts` but is intentionally
// kept as a separate method rather than merged into one. This file focuses on
// rejection from a recipient perspective (the recipient rejecting via their token),
// whereas `reject-document-on-behalf-of.ts` focuses on it from an API/programmatic
// perspective (an authenticated API user acting on behalf of a recipient).
//
// Code changes in one should probably be mirrored to the other, particularly in
// relation to the jobs triggered after a rejection.
import { jobs } from '@documenso/lib/jobs/client';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { mapSecondaryIdToDocumentId, unsafeBuildEnvelopeIdQuery } from '../../utils/envelope';
import { assertRecipientNotExpired } from '../../utils/recipients';
import { isRecipientAccess2FARequired } from '../2fa/email/recipient-access-2fa-cookie';
import { assertRecipientsTurn } from '../recipient/assert-recipients-turn';
import { lockEnvelopeForRecipientAction } from '../recipient/lock-envelope-for-recipient-action';
import { assertRecipientAccessAuthorized } from './assert-recipient-access-authorized';

export type RejectDocumentWithTokenOptions = {
  token: string;
  id: EnvelopeIdOptions;
  reason: string;

  /**
   * The ID of the signed-in user making the request, if any.
   */
  userId?: number;

  /**
   * Whether the request carries the recipient's access code cookie. A
   * recipient whose access auth is an emailed code cannot reject without it.
   */
  isAccess2FAVerified?: boolean;
  requestMetadata?: RequestMetadata;
};

export async function rejectDocumentWithToken({
  token,
  id,
  reason,
  userId,
  isAccess2FAVerified = false,
  requestMetadata,
}: RejectDocumentWithTokenOptions) {
  // Find the recipient and document in a single query
  const recipient = await prisma.recipient.findFirst({
    where: {
      token,
      envelope: unsafeBuildEnvelopeIdQuery(id, EnvelopeType.DOCUMENT),
    },
    include: {
      envelope: true,
    },
  });

  const envelope = recipient?.envelope;

  if (!recipient || !envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document or recipient not found',
    });
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Document ${envelope.id} must be pending to reject`,
    });
  }

  // A signing link stays valid after it has been used, so a recipient who has
  // signed can reopen it and reach the reject button. Rejecting writes a fresh
  // `signedAt` and cascades the signature row away, which destroys the evidence
  // that they signed and when. Their decision is already recorded; refuse to
  // let a second one overwrite it. `rejectDocumentOnBehalfOf` carries the same
  // guard.
  if (recipient.signingStatus !== SigningStatus.NOT_SIGNED) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Recipient ${recipient.id} has already actioned this document`,
    });
  }

  assertRecipientNotExpired(recipient);

  await assertRecipientAccessAuthorized({
    documentAuthOptions: envelope.authOptions,
    recipient,
    userId,
  });

  if (isRecipientAccess2FARequired({ documentAuthOptions: envelope.authOptions, recipient }) && !isAccess2FAVerified) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'The access code must be entered before rejecting',
      statusCode: 401,
    });
  }

  // Update the recipient status to rejected
  const updatedRecipient = await prisma.$transaction(async (tx) => {
    const actor = await lockEnvelopeForRecipientAction(tx, {
      envelopeId: envelope.id,
      recipientId: recipient.id,
      token,
    });

    // A recipient may not reject before their turn (G4 D5, #145).
    await assertRecipientsTurn(tx, { envelopeId: envelope.id, recipientId: recipient.id });

    if (actor.signingStatus !== SigningStatus.NOT_SIGNED) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} has already actioned this document`,
      });
    }

    // Conditional: a CC recipient has nothing to reject, and a role changed to CC since the read above must not
    // turn into a rejection the seal then overwrites (#121).
    const { count } = await tx.recipient.updateMany({
      where: {
        id: recipient.id,
        signingStatus: SigningStatus.NOT_SIGNED,
        role: { not: RecipientRole.CC },
      },
      data: {
        signedAt: new Date(),
        signingStatus: SigningStatus.REJECTED,
        rejectionReason: reason,
      },
    });

    if (count === 0) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} cannot reject this document`,
      });
    }

    const rejected = await tx.recipient.findUniqueOrThrow({ where: { id: recipient.id } });

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED,
        user: {
          name: recipient.name,
          email: recipient.email,
        },
        data: {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          recipientId: recipient.id,
          recipientRole: recipient.role,
          reason,
        },
        requestMetadata,
      }),
    });

    return rejected;
  });

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  // Trigger the seal document job to process the document asynchronously
  await jobs.triggerJob({
    name: 'internal.seal-document',
    payload: {
      documentId: legacyDocumentId,
      requestMetadata,
    },
  });

  // The rejection and cancellation emails are queued by the seal once it commits, so a seal that stops sends
  // none (G4 D2).

  return updatedRecipient;
}
